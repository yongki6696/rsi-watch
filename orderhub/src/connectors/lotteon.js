'use strict';
// 롯데ON - 판매자 OpenAPI (https://api.lotteon.com)
// 인증: Authorization: Bearer {인증키} + 거래처번호(trGrpCd=SR, trNo=LO…)
//       스토어센터 > 판매자정보 > OpenAPI 관리 (연동방법 '직접입력' + 서버 IP 등록 필요)
// 주문 수집: 출고/회수지시(주문정보) 조회 SellerDeliveryOrdersSearch (apiNo 209)
//   - 한 번에 1일까지만 조회 가능 → 하루씩 나눠 조회
//   - ifCplYN: 빈값 = 아직 연동완료 처리 안 된 주문, Y = 다른 프로그램(샵모아 등)이 연동완료 처리한 주문 → 둘 다 조회
//   - 오더허브는 '연동완료 통보'를 보내지 않음 → 같은 키를 쓰는 다른 프로그램의 주문 수집에 영향 없음
//   - 이 목록의 진행단계는 출고지시(11)로 고정 → 현재 단계는 아래 배송상태 조회로 확인
// 현재 단계·주문순번(odSeq/procSeq): 롯데ON배송상태 조회 SellerDeliveryProgressStateSearch (apiNo 140)
// 발주확인/발송처리: 배송상태 통보 SellerDeliveryProgressStateInform (apiNo 137) - 12 상품준비 / 13 발송완료(+택배사·송장)
// ※ 주문정보 조회(getOrderList)는 일반 판매자 키로는 403(접근 거부)이라 쓰지 않음
// 문의: 상품 Q&A (apiNo 99) + 판매자 문의 (apiNo 179) - 답변은 스토어센터에서
const { request, requestRaw, parseJsonBig } = require('./http');
const { pick, findArray, findCustomsCode, shape } = require('./fields');
const { kstParts, toIso, toInt, str } = require('../util');
const { courierCode } = require('../couriers');
const { isNoData, dateRanges, compact, plainText } = require('./inquiry-util');
const { faultFromText } = require('../claims');

// 주문진행단계(odPrgsStepCd)
const STEP = {
  11: { state: 'NEW', label: '출고지시' },
  12: { state: 'CONFIRMED', label: '상품준비' },
  13: { state: 'SHIPPED', label: '발송완료' },
  14: { state: 'DELIVERED', label: '배송완료' },
  15: { state: 'DELIVERED', label: '수취완료' },
  21: { state: 'CANCELED', label: '취소완료' },
  22: { state: 'CANCELED', label: '철회' },
  23: { state: 'DELIVERED', label: '회수지시', claim: 'RETURN' },
  24: { state: 'DELIVERED', label: '회수진행', claim: 'RETURN' },
  25: { state: 'DELIVERED', label: '회수완료', claim: 'RETURN' },
  26: { state: 'RETURNED', label: '회수확정' },
  27: { state: 'RETURNED', label: '반품완료' },
};
const DELIVERY_STEPS = ['11', '12', '13', '14', '15'];

const PATHS = {
  orders: '/v1/openapi/delivery/v1/SellerDeliveryOrdersSearch',
  progress: '/v1/openapi/delivery/v1/SellerDeliveryProgressStateSearch',
  inform: '/v1/openapi/delivery/v1/SellerDeliveryProgressStateInform',
  productQna: '/v1/openapi/product/v1/product/qna/list',
  sellerInquiry: '/v1/openapi/customer/v1/getSellerInquiryList',
};

// yyyymmddhhmmss (KST)
function dttm(d = new Date()) {
  const p = kstParts(d);
  return `${p.y}${p.m}${p.d}${p.hh}${p.mm}${p.ss}`;
}

// [start, end] 를 1일 이하 구간으로 (최신 구간부터)
function dayWindows(start, end) {
  const out = [];
  const first = start.getTime();
  let to = end.getTime();
  while (to > first && out.length < 400) {
    const from = Math.max(first, to - 86400000 + 1000);
    out.push({ from: new Date(from), to: new Date(to) });
    to = from - 1000;
  }
  return out;
}

const OK_CODES = ['0000', '0', '00', '200', 'SUCCESS', 'S'];

function resultCode(json) {
  if (!json || typeof json !== 'object') return null;
  const c = json.returnCode ?? json.resultCode ?? json.rsltCd ?? json.code;
  return c === undefined || c === null ? null : String(c);
}

function resultMessage(json) {
  return str(json?.message ?? json?.returnMessage ?? json?.resultMessage ?? json?.rsltMsg ?? json?.msg ?? '');
}

function trInfo(ctx) {
  const trNo = str(ctx.creds?.trNo).replace(/\s/g, '').toUpperCase();
  if (!trNo) throw new Error('롯데ON 거래처번호(LO로 시작, 예: LO10012345)를 입력해주세요. 스토어센터 왼쪽 위 상호 아래에 있는 번호입니다. ([스토어] → 롯데ON → [키 변경]에서 입력)');
  return { trGrpCd: 'SR', trNo };
}

const UA = `Mozilla/5.0 (compatible; OrderHub/${require('../../package.json').version})`;
const rawMode = new Set(); // 인증키별: Node 기본 요청이 막히고 일반 HTTP 요청이 통한 경우

// 롯데ON 방화벽이 Node 기본 요청을 막는 경우(403)에 대비해 한 번은 일반 HTTP 요청으로 다시 시도
async function send(url, opts, key) {
  const raw = () => requestRaw(url, { ...opts, headers: { ...opts.headers, 'User-Agent': UA } });
  if (rawMode.has(key)) return raw();
  const res = await request(url, opts);
  if (res.status !== 403) return res;
  const alt = await raw();
  if (alt.status !== 403) rawMode.add(key);
  return alt;
}

// 원인 파악용: 어느 단계(방화벽/게이트웨이/앱)에서 막혔는지 알 수 있는 응답 헤더
function headerHint(res) {
  const names = ['server', 'via', 'x-cache', 'x-amzn-errortype', 'x-amz-apigw-id', 'x-amzn-requestid', 'cf-ray', 'x-request-id', 'content-type'];
  return names
    .map((n) => [n, res.headers?.get?.(n)])
    .filter(([, v]) => v)
    .map(([n, v]) => `${n}=${String(v).slice(0, 40)}`)
    .join(', ');
}

async function api(ctx, path, body) {
  const key = str(ctx.creds?.apiKey);
  if (!key) throw new Error('롯데ON OpenAPI 인증키를 입력해주세요');
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Accept-Language': 'ko',
    'X-Timezone': 'GMT+09:00',
    'Content-Type': 'application/json',
  };
  const res = await send(ctx.config.lotteonApiBase + path, { method: 'POST', headers, body: JSON.stringify(body || {}) }, key);
  const text = res.buffer.toString('utf8');
  let json = null;
  try {
    json = text ? parseJsonBig(text) : null;
  } catch {}
  if (res.status === 401 || res.status === 403) {
    const detail = [`HTTP ${res.status}`, resultMessage(json) || text.trim().slice(0, 120) || '응답 내용 없음', headerHint(res)].filter(Boolean).join(' · ');
    const msg =
      res.status === 401
        ? '롯데ON 인증 실패: 인증키가 올바르지 않습니다. 스토어센터 > 판매자정보 > OpenAPI 관리의 인증키를 [복사]해서 [키 변경]으로 다시 넣어주세요.'
        : '롯데ON 접속 거부(403): 스토어센터 > 판매자정보 > OpenAPI 관리에서 연동방법 [직접입력]이 체크돼 있는지, 서버 IP 칸에 [스토어] 화면 맨 위의 서버 IP가 있는지 확인하고 [저장하기]를 눌러주세요.';
    throw Object.assign(new Error(`${msg} (${detail})`), { status: res.status });
  }
  if (!res.ok) throw Object.assign(new Error(`롯데ON API 오류 (HTTP ${res.status}) ${path}: ${resultMessage(json) || text.slice(0, 200)}`), { status: res.status });
  const code = resultCode(json);
  if (code !== null && !OK_CODES.includes(code.toUpperCase())) {
    let hint = '';
    if (/거래처/.test(resultMessage(json))) hint = ' - [키 변경]에서 거래처번호(LO…)를 확인해주세요';
    throw Object.assign(new Error(`롯데ON API 오류 [${code}] ${resultMessage(json)}${hint}`), { code });
  }
  return json;
}

// 상품명에 섞여 오는 HTML 문자(&lt; 등) 정리
function unescapeHtml(s) {
  return str(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stepOf(o) {
  const v = str(pick(o, ['odPrgsStepCd', 'odPrgsStepCode', 'prgsStepCd'], [/prgs.*step/i]));
  return v ? v.padStart(2, '0') : '';
}

const odNoOf = (o) => str(pick(o, ['odNo', 'orderNo', 'ordNo']));

// 상품(라인) 고유키: 주문번호 + 판매자상품번호 + 단품번호 (출고지시 목록에는 odSeq 가 없을 수 있음)
function lineKey(o) {
  const odNo = odNoOf(o);
  if (!odNo) return '';
  const spdNo = str(pick(o, ['spdNo']));
  const sitmNo = str(pick(o, ['sitmNo']));
  if (spdNo || sitmNo) return `${odNo}-${spdNo}-${sitmNo}`;
  return `${odNo}-${str(pick(o, ['odSeq', 'orderSeq', 'ordSeq'])) || '1'}`;
}

// 출고지시 행의 실제 주문일: 주문접수일시 → (없으면) 주문번호 앞 8자리
function orderedAtOf(o) {
  const t = toIso(pick(o, ['odAccpDttm', 'odAcptDttm', 'odDttm', 'ordDttm', 'orderDttm']));
  if (t) return t;
  const m = odNoOf(o).match(/^(20\d{6})/);
  if (m) return toIso(m[1]);
  return toIso(pick(o, ['odCmptDttm']));
}

function normalizeItem(o) {
  const odNo = odNoOf(o);
  const step = stepOf(o) || '11';
  const st = STEP[Number(step)] || STEP[11];
  const qty = toInt(pick(o, ['odQty', 'slQty', 'ordQty', 'qty', 'orderQty'], [/qty/i]), 1) || 1;
  const unit = toInt(pick(o, ['slPrc', 'slUprc', 'sellPrc', 'itmSlPrc', 'prc'], [/slprc|uprc/i]));
  const amount = toInt(pick(o, ['actualAmt', 'slAmt', 'odAmt', 'stlAmt', 'payAmt', 'ordAmt'], [/(actual|stl|pay).*amt/i]));
  const orderedAt = orderedAtOf(o);
  const spdNo = str(pick(o, ['spdNo']));
  const sitmNo = str(pick(o, ['sitmNo']));
  return {
    group: {
      groupKey: odNo,
      orderNo: odNo,
      orderedAt,
      paidAt: step === '11' ? toIso(pick(o, ['odCmptDttm'])) || orderedAt : orderedAt,
      shipDue: toIso(pick(o, ['sndPrmsDt', 'dvPrmsDt', 'shpPrmsDt', 'sndPrmsDttm'], [/prms/i])),
      ordererName: str(pick(o, ['odrNm', 'odNm', 'ordrNm', 'ordNm', 'mbNm', 'custNm'], [/^(odr|ordr|ord)nm/i])),
      ordererPhone: str(pick(o, ['mphnNo', 'odrMphnNo', 'odrTelNo', 'ordrMphnNo', 'ordrTelNo'], [/^(odr|ordr).*(mphn|tel)/i])),
      receiverName: str(pick(o, ['dvpCustNm', 'rcvrNm', 'rcvNm', 'dvRcvNm', 'rcpNm', 'dvpNm'], [/(dvp|rcv|rcp).*nm/i])),
      receiverPhone: str(pick(o, ['dvpMphnNo', 'rcvrMphnNo', 'rcvMphnNo', 'rcpMphnNo'], [/(dvp|rcv|rcp).*mphn/i])),
      receiverPhone2: str(pick(o, ['dvpTelNo', 'rcvrTelNo', 'rcvTelNo', 'rcpTelNo'], [/(dvp|rcv|rcp).*tel/i])),
      zipcode: str(pick(o, ['dvpZipNo', 'zipNo', 'rcvrZipNo', 'rcvZipNo'], [/zip(no|cd)$/i])),
      address1: str(pick(o, ['dvpStnmZipAddr', 'dvpStnmAddr', 'dvpBscAddr', 'stnmZipAddr', 'bscAddr', 'rcvrAddr'], [/(stnm|bsc).*addr|zipaddr/i])),
      address2: str(pick(o, ['dvpStnmDtlAddr', 'dvpDtlAddr', 'stnmDtlAddr', 'dtlAddr', 'rcvrDtlAddr'], [/dtl.*addr/i])),
      deliveryMemo: str(pick(o, ['dvMsg', 'dvRqmCnts', 'dlvMsg', 'dvMemo', 'shpMsg'], [/dvmsg|dlvmsg|rqm/i])),
      customsCode: str(pick(o, ['indvCstmPclrNo'])) || findCustomsCode(o),
      shippingFee: toInt(pick(o, ['dvCst', 'dvAmt', 'dlvCst']), 0),
      marketTrackingNo: str(pick(o, ['invcNo'])),
      marketCourierCode: str(pick(o, ['dvCoCd'])),
    },
    item: {
      itemKey: lineKey(o),
      orderNo: odNo,
      productName: unescapeHtml(pick(o, ['spdNm', 'pdNm', 'prdNm', 'lrtrPdNm', 'goodsNm'], [/(spd|pd|prd).*nm/i])),
      optionName: unescapeHtml(pick(o, ['sitmNm', 'itmNm', 'optNm', 'optVal'], [/(sitm|itm|opt).*nm/i])),
      quantity: qty,
      unitPrice: unit,
      amount: amount ?? (unit ? unit * qty : null),
      productCode: str(pick(o, ['epdNo', 'eitmNo', 'slrPdNo', 'sellerPdNo'], [/^e(pd|itm)no/i])),
      productId: spdNo,
      marketState: st.state,
      marketStatus: st.label,
      claim: st.claim || null,
      claimInfo: claimInfoOf(o, st.state, st.claim),
      extra: { odNo, odSeq: str(pick(o, ['odSeq'])) || null, procSeq: str(pick(o, ['procSeq'])) || null, spdNo, sitmNo, qty },
      raw: o,
    },
  };
}

// 배송상태 행 중 가장 최근 것 (배송상태발생일시 → 처리순번 순)
function latest(rows) {
  return [...rows].sort((a, b) => {
    const t = str(pick(b, ['dvTrcStatDttm'])).localeCompare(str(pick(a, ['dvTrcStatDttm'])));
    return t || Number(pick(b, ['procSeq']) || 0) - Number(pick(a, ['procSeq']) || 0);
  })[0];
}

// 상품(라인)에 해당하는 배송상태 행 찾기: 상품번호 → 주문순번 → (상품 1개면) 그 주문의 행 → 순서대로
function matchProgress(item, progs, siblings) {
  if (!progs?.length) return null;
  const ex = item.extra || {};
  const bySku = progs.filter((p) => str(p.spdNo) && str(p.spdNo) === str(ex.spdNo) && (!str(p.sitmNo) || !str(ex.sitmNo) || str(p.sitmNo) === str(ex.sitmNo)));
  if (bySku.length) return latest(bySku);
  if (ex.odSeq) {
    const bySeq = progs.filter((p) => str(p.odSeq) === str(ex.odSeq));
    if (bySeq.length) return latest(bySeq);
  }
  if (siblings.length <= 1) return latest(progs);
  const seqs = [...new Set(progs.map((p) => str(p.odSeq)).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  const seq = seqs[siblings.indexOf(item)];
  return seq ? latest(progs.filter((p) => str(p.odSeq) === seq)) : null;
}

// 상품에 배송상태 반영 (현재 단계, 주문순번, 송장)
// 취소·회수(반품) 사유: 클레임 사유코드(취소 101~, 반품 301~)와 사유 내용
function claimInfoOf(row, state, claim) {
  const type = claim === 'RETURN' || state === 'RETURNED' ? 'RETURN' : claim === 'EXCHANGE' ? 'EXCHANGE' : state === 'CANCELED' || claim === 'CANCEL' ? 'CANCEL' : '';
  if (!type) return undefined;
  const code = str(pick(row, ['clmRsnCd', 'rtrvRsnCd', 'cnclRsnCd']));
  const text = plainText(pick(row, ['clmRsnCnts', 'clmRsnNm', 'clmRsnDtlCnts', 'rtrvRsnCnts', 'cnclRsnCnts', 'clmRsn']));
  if (!code && !text) return undefined;
  return {
    market: 'lotteon',
    type,
    reasonCode: code,
    reason: text || `사유 코드 ${code}`,
    detail: '',
    fault: faultFromText(text),
    feeAmount: toInt(pick(row, ['rtrvDvCst', 'clmDvCst', 'rtngDvCst', 'rtnDvCst']), null),
    at: toIso(pick(row, ['clmReqDttm', 'clmAccpDttm', 'dvTrcStatDttm'])),
  };
}

function applyProgress(item, p) {
  if (!p) return;
  const step = stepOf(p);
  const st = STEP[Number(step)];
  if (st) {
    item.marketState = st.state;
    item.marketStatus = st.label;
    item.claim = st.claim || null;
    const info = claimInfoOf(p, st.state, st.claim);
    if (info) item.claimInfo = info;
  }
  // 발주확인·발송처리 때 보낼 주문순번·처리순번
  item.extra = { ...item.extra, odSeq: str(p.odSeq) || item.extra?.odSeq || null, procSeq: str(p.procSeq) || item.extra?.procSeq || null };
}

function progressIndex(rows) {
  const map = new Map();
  for (const p of rows) {
    const no = odNoOf(p);
    if (!no) continue;
    if (!map.has(no)) map.set(no, []);
    map.get(no).push(p);
  }
  return map;
}

// 출고지시 행 + 배송상태 행 → 주문 묶음
function toGroups(rows, progRows = [], open = []) {
  const prog = progressIndex(progRows);
  const map = new Map();
  const claimRows = [];
  for (const row of rows) {
    const typ = str(pick(row, ['odTypCd'])) || '10';
    const step = stepOf(row) || '11';
    // 회수지시·교환 재출고 행은 새 주문이 아니라 기존 주문의 클레임
    if (typ !== '10' || !DELIVERY_STEPS.includes(step)) {
      claimRows.push(row);
      continue;
    }
    const { group, item } = normalizeItem(row);
    if (!group.groupKey || !item.itemKey) continue;
    if (!map.has(group.groupKey)) map.set(group.groupKey, { ...group, items: [] });
    const g = map.get(group.groupKey);
    // 같은 주문의 다른 상품 정보로 비어있는 칸 채우기
    for (const [k, v] of Object.entries(group)) if (!g[k] && v) g[k] = v;
    if (!g.items.some((x) => x.itemKey === item.itemKey)) g.items.push(item);
  }
  for (const g of map.values()) {
    const progs = prog.get(g.groupKey) || [];
    for (const it of g.items) {
      const p = matchProgress(it, progs, g.items);
      applyProgress(it, p);
      if (p && !g.marketTrackingNo && str(p.invcNo)) {
        g.marketTrackingNo = str(p.invcNo);
        g.marketCourierCode = str(p.dvCoCd);
      }
    }
  }
  const out = [...map.values()];
  // 회수/교환 지시 → 이미 저장된 주문 상품에 클레임 표시 (없는 주문은 만들지 않음)
  for (const row of claimRows) {
    const odNo = odNoOf(row);
    const key = lineKey(row);
    if (!odNo || !key) continue;
    const exchange = str(pick(row, ['odTypCd'])) === '30';
    const step = stepOf(row);
    const label = exchange ? '교환 회수지시' : STEP[Number(step)]?.label || '회수지시';
    const g = map.get(odNo);
    const it = g?.items.find((x) => x.itemKey === key);
    if (it && it.marketState !== 'CANCELED' && it.marketState !== 'RETURNED') {
      it.claim = exchange ? 'EXCHANGE' : 'RETURN';
      it.marketStatus = `${it.marketStatus} · ${label}`;
    } else if (!g) {
      out.push({ groupKey: odNo, partial: true, items: [{ itemKey: key, claim: exchange ? 'EXCHANGE' : 'RETURN', marketStatus: label }] });
    }
  }
  // 이번 목록에 없는 미처리 주문: 배송상태만 반영 (셀러센터에서 직접 처리·고객 취소 등)
  for (const og of open) {
    if (map.has(og.group_key)) continue;
    const progs = prog.get(og.group_key);
    if (!progs?.length) continue;
    const keys = og.item_keys || [];
    const items = [];
    keys.forEach((k, idx) => {
      const [, spdNo = '', sitmNo = ''] = String(k).split('-');
      const pseudo = { itemKey: k, extra: { spdNo, sitmNo } };
      const siblings = keys.map((x, i) => (i === idx ? pseudo : { itemKey: x }));
      const p = matchProgress(pseudo, progs, siblings);
      const st = p && STEP[Number(stepOf(p))];
      if (st) items.push({ itemKey: k, marketState: st.state, marketStatus: st.label, claim: st.claim || null });
    });
    if (items.length) out.push({ groupKey: og.group_key, partial: true, items });
  }
  return out;
}

// 출고/회수지시(주문정보) 조회: 하루씩, 신규(빈값)+연동완료(Y) 모두
async function fetchDeliveryOrders(ctx, windows, diag) {
  const tr = trInfo(ctx);
  const rows = new Map();
  for (const w of windows) {
    for (const flag of ['', 'Y']) {
      let json;
      try {
        json = await api(ctx, PATHS.orders, { ...tr, srchStrtDt: dttm(w.from), srchEndDt: dttm(w.to), ifCplYN: flag });
      } catch (e) {
        if (flag === '' || e.status || e.network) throw e; // 연동완료(Y) 조회만 안 되는 경우는 넘어감
        if (diag) diag.linkedError = e.message;
        continue;
      }
      if (diag && !diag.orders) diag.orders = shape(json);
      for (const row of findArray(json?.data ?? json, ['deliveryOrderList', 'list', 'dataList'])) {
        const key = `${lineKey(row)}|${str(pick(row, ['odTypCd']))}|${str(pick(row, ['procSeq']))}`;
        if (lineKey(row) && !rows.has(key)) rows.set(key, row);
      }
    }
  }
  return [...rows.values()];
}

// 롯데ON배송상태 조회: 기간(하루씩) 또는 주문번호
async function fetchProgress(ctx, { window, odNo }, diag) {
  const body = { ...trInfo(ctx) };
  if (odNo) body.odNo = odNo;
  else Object.assign(body, { srchStrtDt: dttm(window.from), srchEndDt: dttm(window.to) });
  const json = await api(ctx, PATHS.progress, body);
  if (diag && !diag.progress) diag.progress = shape(json);
  return findArray(json?.data ?? json, ['deliveryProgressStateList', 'progressStateList', 'list', 'dataList']);
}

async function collect(ctx, days, diag) {
  // 끝 시각은 1분 여유 (방금 들어온 주문이 초 단위 경계에서 빠지지 않게)
  const end = new Date(Date.now() + 60000);
  const windows = dayWindows(new Date(end.getTime() - days * 86400000), end);
  const rows = await fetchDeliveryOrders(ctx, windows, diag);
  const progRows = [];
  const warnings = [];
  try {
    for (const w of windows) progRows.push(...(await fetchProgress(ctx, { window: w }, diag)));
  } catch (e) {
    if (e.network) throw e;
    warnings.push(`배송상태 조회 실패(주문은 정상 수집): ${e.message}`);
    if (diag) diag.progress = `실패: ${e.message}`;
  }
  // 이번 기간 밖의 미처리 주문은 주문번호로 현재 단계 확인 (최대 30건)
  const open = ctx.openGroups ? ctx.openGroups() : [];
  if (!warnings.length) {
    const seen = new Set([...rows.map(odNoOf), ...progRows.map(odNoOf)]);
    for (const og of open.filter((g) => !seen.has(g.group_key)).slice(0, 30)) {
      try {
        progRows.push(...(await fetchProgress(ctx, { odNo: og.group_key })));
      } catch (e) {
        if (e.network) throw e;
        ctx.log?.(`롯데ON 배송상태 조회 실패(${og.group_key}): ${e.message}`);
      }
    }
  }
  return { groups: toGroups(rows, progRows, open), rows, warnings };
}

async function inform(ctx, items, step, extraFields = {}) {
  // 주문순번(odSeq/procSeq)을 모르는 상품은 배송상태 조회로 채움
  const lookups = new Map();
  for (const it of items) {
    if (it.extra?.odSeq && it.extra?.procSeq) continue;
    const odNo = it.extra?.odNo || it.order_no;
    if (!odNo) continue;
    if (!lookups.has(odNo)) lookups.set(odNo, await fetchProgress(ctx, { odNo }).catch(() => []));
    const siblings = items.filter((x) => (x.extra?.odNo || x.order_no) === odNo);
    const p = matchProgress(it, lookups.get(odNo), siblings);
    if (p) it.extra = { ...it.extra, odSeq: str(p.odSeq) || it.extra?.odSeq, procSeq: str(p.procSeq) || it.extra?.procSeq };
  }
  const list = items.map((it) => ({
    dvRtrvDvsCd: 'DV',
    odNo: String(it.extra?.odNo || it.order_no || ''),
    odSeq: String(it.extra?.odSeq || 1),
    procSeq: String(it.extra?.procSeq || 1),
    orglProcSeq: '',
    clmNo: '',
    odPrgsStepCd: step,
    dvTrcStatDttm: dttm(new Date()),
    spdNo: String(it.extra?.spdNo || it.product_id || ''),
    spdNm: '',
    sitmNo: String(it.extra?.sitmNo || ''),
    itmNm: '',
    itmSlPrc: '',
    slQty: String(it.quantity || it.extra?.qty || 1),
    ...extraFields,
  }));
  const json = await api(ctx, PATHS.inform, { deliveryProgressStateList: list });
  // 상품별 결과가 있으면 반영
  const results = findArray(json?.data ?? json, ['resultList', 'deliveryProgressStateList', 'list']);
  const failMsg = new Map();
  for (const r of results) {
    const code = str(pick(r, ['resultCode', 'rsltCd', 'returnCode']));
    if (!code || OK_CODES.includes(code.toUpperCase())) continue;
    const msg = `${str(pick(r, ['resultMessage', 'rsltMsg', 'message']))} (${code})`;
    const target = items.find((it) => (str(r.spdNo) ? str(r.spdNo) === str(it.extra?.spdNo) : true) && odNoOf(r) === String(it.extra?.odNo || it.order_no));
    if (target) failMsg.set(target.itemKey, msg);
  }
  return {
    ok: items.filter((i) => !failMsg.has(i.itemKey)).map((i) => i.itemKey),
    failed: items.filter((i) => failMsg.has(i.itemKey)).map((i) => ({ itemKey: i.itemKey, message: failMsg.get(i.itemKey) })),
  };
}

// ---------- 문의 ----------
// 상품 Q&A 처리상태: NPROC 미처리 / PROC 처리완료 / CC_TCTL 고객센터 이관
const QNA_STAT = { NPROC: '미처리', PROC: '처리완료', CC_TCTL: '고객센터 이관' };

// 페이지 단위 조회 (한 페이지 최대 100건)
async function pagedList(ctx, path, bodyFor) {
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    let json;
    try {
      json = await api(ctx, path, bodyFor(page));
    } catch (e) {
      if (isNoData(e)) break;
      throw e;
    }
    const list = findArray(json?.data ?? json, ['rsltList', 'data', 'list', 'pdQnaList', 'qnaList']);
    rows.push(...list);
    if (list.length < 100) break;
  }
  return rows;
}

function normalizeProductQna(q) {
  const no = str(pick(q, ['pdQnaNo', 'qnaNo']));
  if (!no) return null;
  const st = str(pick(q, ['qnaStatCd'])).toUpperCase();
  const answer = plainText(pick(q, ['ansCnts', 'answCnts', 'ansCont', 'rplyCnts']));
  const spdNo = str(pick(q, ['spdNo']));
  const typeName = str(pick(q, ['qstTypNm', 'qstTypCdNm']));
  return {
    key: `p-${no}`,
    kind: 'product',
    category: typeName || (st === 'CC_TCTL' ? QNA_STAT.CC_TCTL : ''),
    title: plainText(pick(q, ['qstTtl', 'qnaTtl'])),
    content: plainText(pick(q, ['qstCnts', 'qnaCnts', 'qstCont'])),
    productName: unescapeHtml(pick(q, ['spdNm', 'pdNm', 'sitmNm'])),
    productId: spdNo,
    orderNo: odNoOf(q),
    writer: str(pick(q, ['mbNm', 'custNm', 'regrNm'])),
    askedAt: toIso(pick(q, ['regDttm', 'qstDttm'])),
    answered: st ? st !== 'NPROC' : !!answer,
    answer: answer || (st === 'CC_TCTL' ? '고객센터로 이관된 문의입니다' : ''),
    extra: { pdQnaNo: no, spdNo, sitmNo: str(pick(q, ['sitmNo'])), status: QNA_STAT[st] || st },
  };
}

function normalizeSellerInquiry(q) {
  const no = str(pick(q, ['slrInqNo', 'inqNo']));
  if (!no) return null;
  const st = str(pick(q, ['slrInqProcStatCd'])).toUpperCase();
  const answer = plainText(pick(q, ['ansCnts', 'answCnts']));
  return {
    key: `s-${no}`,
    kind: 'customer',
    category: str(pick(q, ['vocTypNm', 'vocLcsfNm', 'vocMcsfNm'])),
    title: plainText(pick(q, ['inqTtl'])),
    content: plainText(pick(q, ['inqCnts'])),
    productName: unescapeHtml(pick(q, ['pdNm', 'spdNm'])),
    productId: str(pick(q, ['spdNo'])),
    orderNo: odNoOf(q),
    writer: str(pick(q, ['custNm', 'mbNm', 'inqrNm'])),
    askedAt: toIso(pick(q, ['accpDttm', 'inqDttm', 'regDttm'])),
    // ANS 답변 / UNANS 미답변
    answered: st === 'ANS' || (st !== 'UNANS' && !!answer),
    answer,
    extra: { slrInqNo: no },
  };
}

async function fetchProductQna(ctx) {
  const tr = trInfo(ctx);
  const out = new Map();
  for (const w of dateRanges(ctx.inquiryDays || 7)) {
    const rows = await pagedList(ctx, PATHS.productQna, (pageNo) => ({
      ...tr,
      lrtrNo: '',
      regStrDttm: `${compact(w.from)}000000`,
      regEndDttm: `${compact(w.to)}235959`,
      qnaStatCd: 'ALL',
      pageNo,
      rowsPerPage: 100,
    }));
    for (const q of rows) {
      const n = normalizeProductQna(q);
      if (n && !out.has(n.key)) out.set(n.key, n);
    }
  }
  return [...out.values()];
}

async function fetchSellerInquiries(ctx) {
  const out = new Map();
  for (const w of dateRanges(ctx.inquiryDays || 7)) {
    const rows = await pagedList(ctx, PATHS.sellerInquiry, (pageNo) => ({
      scStrtDt: compact(w.from),
      scEndDt: compact(w.to),
      vocLcsfCd: '',
      slrInqProcStatCd: '',
      pageNo,
      rowsPerPage: 100,
    }));
    for (const q of rows) {
      const n = normalizeSellerInquiry(q);
      if (n && !out.has(n.key)) out.set(n.key, n);
    }
  }
  return [...out.values()];
}

// 상품 Q&A + 판매자 문의 (한쪽만 실패하면 나머지는 그대로 반영)
async function fetchInquiries(ctx) {
  const list = [];
  const warnings = [];
  for (const [label, fn] of [
    ['상품 Q&A', fetchProductQna],
    ['판매자 문의', fetchSellerInquiries],
  ]) {
    try {
      list.push(...(await fn(ctx)));
    } catch (e) {
      if (e.network) throw e;
      warnings.push(`${label} - ${e.status === 403 ? '이 인증키로는 조회 권한이 없습니다(403). 스토어센터 > 판매자정보 > OpenAPI 관리에서 확인해주세요' : e.message}`);
    }
  }
  if (warnings.length === 2) throw new Error(`롯데ON 문의 조회 실패: ${warnings.join(' / ')}`);
  return { list, warnings };
}

module.exports = {
  type: 'lotteon',
  label: '롯데ON',
  short: 'L',
  color: '#262626',
  beta: true,
  inquiries: true, // 상품 Q&A + 판매자 문의 (답변은 스토어센터에서)
  answerable: false,
  backfill: true,
  sellerCenter: 'https://store.lotteon.com/',
  fields: [
    { key: 'trNo', label: '거래처번호', placeholder: 'LO로 시작 (예: LO10012345)', required: true },
    { key: 'apiKey', label: 'OpenAPI 인증키', placeholder: '스토어센터에서 발급받은 인증키', required: true, secret: true },
  ],
  guide: [
    '롯데ON 스토어센터 로그인 → 판매자정보 → OpenAPI 관리로 이동합니다.',
    "연동방법에서 [직접입력]을 체크하고, '서버 IP 등록' 칸에 아래 표시된 이 서버의 IP를 추가한 뒤 [저장하기]를 누릅니다. 이미 다른 IP가 있으면 세미콜론(;)으로 이어서 적습니다. 예) 1.2.3.4;5.6.7.8",
    '[키발급]으로 인증키를 받아 아래에 입력합니다. (다른 프로그램이 쓰는 기존 키는 그대로 두세요. 인증키는 3개까지, 유효기간 1년)',
    '거래처번호는 스토어센터 왼쪽 위 상호 아래에 있는 LO로 시작하는 번호입니다. 입력 후 [연결 테스트]를 누릅니다.',
  ],

  async test(ctx) {
    const diag = {};
    const to = new Date(Date.now() + 60000);
    const window = { from: new Date(to.getTime() - 86400000 + 1000), to };
    const rows = await fetchDeliveryOrders(ctx, [window], diag);
    try {
      await fetchProgress(ctx, { window }, diag);
    } catch (e) {
      if (e.network) throw e;
      diag.progress = `실패: ${e.message}`;
    }
    return {
      ok: true,
      message: `롯데ON 연결 성공 · 최근 24시간 출고지시 ${rows.length}건 확인`,
      diagnostic: Object.entries(diag)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' | '),
    };
  },

  async fetch(ctx) {
    const state = { ...(ctx.state || {}) };
    // 평소엔 최근 3일, 첫 연결은 설정한 기간, 지난 주문 불러오기는 그 기간 (하루씩 조회)
    const days = ctx.backfillDays || (state._syncedOnce ? 3 : Math.max(ctx.initialDays || 7, 3));
    const { groups, warnings } = await collect(ctx, days);
    // 배송상태 조회만 실패하는 경우: 같은 내용은 한 번만 기록
    if (!ctx.backfillDays) {
      if (warnings.length && state.lastWarning !== warnings[0]) ctx.log?.(warnings[0]);
      if (warnings.length) state.lastWarning = warnings[0];
      else delete state.lastWarning;
    }
    return { groups, state, warnings };
  },

  // 상품 Q&A + 판매자 문의 - 최근 7일 (처음·1시간마다 30일)
  fetchInquiries,

  // 발주확인 = 상품준비(12) 통보
  async confirm(ctx, order, items) {
    return inform(ctx, items, '12');
  },

  // 발송처리 = 발송완료(13) 통보 + 택배사/송장
  async dispatch(ctx, order, items, { courierKey, trackingNo }) {
    const code = courierCode(courierKey, 'lotteon');
    if (!code) throw new Error('이 택배사는 롯데ON 코드가 없습니다. 택배사를 다시 선택하거나 직접 코드(4자리)를 입력해주세요.');
    return inform(ctx, items, '13', { invcNbr: '1', dvCoCd: code, invcNo: String(trackingNo).trim() });
  },

  _internal: { normalizeItem, toGroups, dttm, dayWindows, lineKey, matchProgress, STEP, rawMode, unescapeHtml, normalizeProductQna, normalizeSellerInquiry, claimInfoOf },
};
