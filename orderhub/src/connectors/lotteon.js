'use strict';
// 롯데ON - 판매자 OpenAPI (https://api.lotteon.com)
// 인증: Authorization: Bearer {인증키} (판매자센터 > 판매자정보 > OpenAPI 관리, 서버 IP 등록 필요)
// 주문진행단계(odPrgsStepCd): 11 출고지시, 12 상품준비, 13 발송완료, 14 배송완료, 15 수취완료, 21 취소완료 …
// 발주확인/발송처리: 배송상태 통보(SellerDeliveryProgressStateInform) - 12 상품준비 / 13 발송완료(+택배사·송장)
const { request, requestRaw, parseJsonBig } = require('./http');
const { pick, findArray, findCustomsCode, shape } = require('./fields');
const { kstParts, toIso, toInt, str } = require('../util');
const { courierCode } = require('../couriers');

const STEP = {
  11: { state: 'NEW', label: '출고지시' },
  12: { state: 'CONFIRMED', label: '상품준비' },
  13: { state: 'SHIPPED', label: '발송완료' },
  14: { state: 'DELIVERED', label: '배송완료' },
  15: { state: 'DELIVERED', label: '수취완료' },
  21: { state: 'CANCELED', label: '취소완료' },
  22: { state: 'NEW', label: '취소철회' },
  23: { state: 'DELIVERED', label: '회수지시', claim: 'RETURN' },
  24: { state: 'DELIVERED', label: '회수진행', claim: 'RETURN' },
  25: { state: 'DELIVERED', label: '회수완료', claim: 'RETURN' },
  26: { state: 'DELIVERED', label: '회수확정', claim: 'RETURN' },
  27: { state: 'RETURNED', label: '반품완료' },
};

const PATHS = {
  orders: '/v1/openapi/order/v1/getOrderList',
  progress: '/v1/openapi/delivery/v1/SellerDeliveryProgressStateSearch',
  inform: '/v1/openapi/delivery/v1/SellerDeliveryProgressStateInform',
};

// yyyymmddhhmmss (KST)
function dttm(d = new Date()) {
  const p = kstParts(d);
  return `${p.y}${p.m}${p.d}${p.hh}${p.mm}${p.ss}`;
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
  let res = await send(ctx.config.lotteonApiBase + path, { method: 'POST', headers, body: JSON.stringify(body || {}) }, key);
  if (res.status === 405) {
    // 조회 API 가 GET 방식인 경우
    const qs = new URLSearchParams(Object.entries(body || {}).map(([k, v]) => [k, String(v)])).toString();
    res = await send(`${ctx.config.lotteonApiBase}${path}${qs ? `?${qs}` : ''}`, { method: 'GET', headers }, key);
  }
  const text = res.buffer.toString('utf8');
  let json = null;
  try {
    json = text ? parseJsonBig(text) : null;
  } catch {}
  if (res.status === 401 || res.status === 403) {
    const detail = [`HTTP ${res.status}`, resultMessage(json) || text.trim().slice(0, 120) || '응답 내용 없음', headerHint(res)].filter(Boolean).join(' · ');
    const msg =
      res.status === 401
        ? `롯데ON 인증 실패: 인증키가 올바르지 않습니다. 스토어센터 > 판매자정보 > OpenAPI 관리의 인증키를 [복사]해서 [키 변경]으로 다시 넣어주세요.`
        : `롯데ON 접속 거부(403): 롯데ON이 이 서버의 호출을 막았습니다. 스토어센터 > 판매자정보 > OpenAPI 관리에서 ① 서버 IP 칸에 [스토어] 화면 맨 위의 서버 IP가 있는지 확인하고 [저장하기] ② [키발급]으로 새 인증키를 받아 오더허브 [키 변경]에 넣어주세요. (기존 키는 샵모아 등 다른 프로그램용으로 그대로 두세요)`;
    throw Object.assign(new Error(`${msg} (${detail})`), { status: res.status });
  }
  if (!res.ok) throw Object.assign(new Error(`롯데ON API 오류 (HTTP ${res.status}) ${path}: ${resultMessage(json) || text.slice(0, 200)}`), { status: res.status });
  const code = resultCode(json);
  if (code !== null && !OK_CODES.includes(code.toUpperCase())) {
    throw Object.assign(new Error(`롯데ON API 오류 [${code}] ${resultMessage(json)}`), { code });
  }
  return json;
}

function stepOf(o) {
  return String(pick(o, ['odPrgsStepCd', 'odPrgsStepCode', 'prgsStepCd'], [/prgs.*step/i]) || '').padStart(2, '0');
}

function itemKeyOf(o) {
  const odNo = str(pick(o, ['odNo', 'orderNo', 'ordNo']));
  const odSeq = str(pick(o, ['odSeq', 'orderSeq', 'ordSeq']));
  return odNo ? `${odNo}-${odSeq || '1'}` : '';
}

function normalizeItem(o, fallbackStep) {
  const odNo = str(pick(o, ['odNo', 'orderNo', 'ordNo']));
  const odSeq = pick(o, ['odSeq', 'orderSeq', 'ordSeq']) || 1;
  const procSeq = pick(o, ['procSeq']) || 1;
  const step = stepOf(o) || fallbackStep || '11';
  const st = STEP[Number(step)] || STEP[11];
  const qty = toInt(pick(o, ['odQty', 'ordQty', 'qty', 'slQty', 'orderQty'], [/qty/i]), 1) || 1;
  const unit = toInt(pick(o, ['slPrc', 'sellPrc', 'slUprc', 'prc'], [/slprc|uprc/i]));
  const amount = toInt(pick(o, ['odAmt', 'stlAmt', 'payAmt', 'ordAmt', 'slAmt'], [/(od|stl|pay|ord).*amt/i]));
  return {
    group: {
      groupKey: odNo,
      orderNo: odNo,
      orderedAt: toIso(pick(o, ['odAcptDttm', 'odDttm', 'ordDttm', 'orderDttm'], [/od.*dttm|ord.*dt/i])),
      paidAt: toIso(pick(o, ['stlDttm', 'payDttm', 'odCmptDttm', 'odAcptDttm'], [/(stl|pay).*dttm/i])),
      shipDue: toIso(pick(o, ['sndPrmsDt', 'dvPrmsDt', 'shpPrmsDt'], [/prms/i])),
      ordererName: str(pick(o, ['odrNm', 'ordrNm', 'ordNm', 'mbNm', 'custNm'], [/^(odr|ordr|ord)nm/i])),
      ordererPhone: str(pick(o, ['odrMphnNo', 'odrTelNo', 'ordrMphnNo', 'ordrTelNo'], [/^(odr|ordr).*(mphn|tel)/i])),
      receiverName: str(pick(o, ['dvpCustNm', 'rcvrNm', 'rcvNm', 'dvRcvNm', 'rcpNm', 'dvpNm'], [/(dvp|rcv|rcp).*nm/i])),
      receiverPhone: str(pick(o, ['dvpMphnNo', 'rcvrMphnNo', 'rcvMphnNo', 'rcpMphnNo'], [/(dvp|rcv|rcp).*mphn/i])),
      receiverPhone2: str(pick(o, ['dvpTelNo', 'rcvrTelNo', 'rcvTelNo', 'rcpTelNo'], [/(dvp|rcv|rcp).*tel/i])),
      zipcode: str(pick(o, ['dvpZipNo', 'zipNo', 'rcvrZipNo', 'rcvZipNo'], [/zip/i])),
      address1: str(pick(o, ['dvpStnmZipAddr', 'dvpStnmAddr', 'dvpBscAddr', 'stnmZipAddr', 'bscAddr', 'rcvrAddr'], [/(stnm|bsc).*addr|zipaddr/i])),
      address2: str(pick(o, ['dvpStnmDtlAddr', 'dvpDtlAddr', 'stnmDtlAddr', 'dtlAddr', 'rcvrDtlAddr'], [/dtl.*addr/i])),
      deliveryMemo: str(pick(o, ['dvMsg', 'dvRqmCnts', 'dlvMsg', 'dvMemo', 'shpMsg'], [/dvmsg|dlvmsg|rqm/i])),
      customsCode: findCustomsCode(o),
      shippingFee: toInt(pick(o, ['dvCst', 'dvAmt', 'dlvCst']), 0),
      marketTrackingNo: str(pick(o, ['invcNo'])),
      marketCourierCode: str(pick(o, ['dvCoCd'])),
    },
    item: {
      itemKey: `${odNo}-${odSeq}`,
      orderNo: odNo,
      productName: str(pick(o, ['spdNm', 'pdNm', 'prdNm', 'lrtrPdNm', 'goodsNm'], [/(spd|pd|prd).*nm/i])),
      optionName: str(pick(o, ['sitmNm', 'itmNm', 'optNm', 'optVal'], [/(sitm|itm|opt).*nm/i])),
      quantity: qty,
      unitPrice: unit,
      amount: amount ?? (unit ? unit * qty : null),
      productCode: str(pick(o, ['epdNo', 'eitmNo', 'slrPdNo', 'sellerPdNo'], [/^e(pd|itm)no/i])),
      productId: str(pick(o, ['spdNo', 'pdNo'])),
      marketState: st.state,
      marketStatus: st.label,
      claim: st.claim || null,
      extra: { odNo, odSeq, procSeq },
      raw: o,
    },
  };
}

function toGroups(records) {
  const map = new Map();
  for (const r of records) {
    const { group, item } = normalizeItem(r.data, r.step);
    if (!group.groupKey) continue;
    if (!map.has(group.groupKey)) map.set(group.groupKey, { ...group, items: [] });
    const g = map.get(group.groupKey);
    // 같은 주문의 다른 상품 정보로 비어있는 칸 채우기
    for (const [k, v] of Object.entries(group)) if (!g[k] && v) g[k] = v;
    const idx = g.items.findIndex((x) => x.itemKey === item.itemKey);
    if (idx >= 0) g.items[idx] = item;
    else g.items.push(item);
  }
  return [...map.values()];
}

// 주문정보 + 배송상태 조회를 합쳐서 상품주문 단위 레코드로
// range: 최근 N일(숫자) 또는 { start: Date, end: Date }
async function collect(ctx, range, diag) {
  const now = new Date();
  const from = dttm(typeof range === 'object' ? range.start : new Date(now.getTime() - range * 86400000));
  const to = dttm(typeof range === 'object' ? range.end : now);
  const body = { srchStrtDt: from, srchEndDt: to, srchStrtDtm: from, srchEndDtm: to };
  const byKey = new Map();
  const errors = [];
  let ordersOk = false;
  try {
    const json = await api(ctx, PATHS.orders, body);
    ordersOk = true;
    if (diag) diag.orders = shape(json);
    for (const o of findArray(json?.data ?? json, ['orderList', 'list', 'dataList', 'odList'])) {
      // 주문 안에 상품 목록이 있으면 펼치기
      const nested = Object.values(o).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object' && (v[0].odSeq !== undefined || v[0].spdNm !== undefined));
      const rows = nested ? nested.map((x) => ({ ...o, ...x })) : [o];
      for (const row of rows) {
        const k = itemKeyOf(row);
        if (k) byKey.set(k, { data: row, step: stepOf(row) });
      }
    }
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw e;
    errors.push(`주문정보 조회: ${e.message}`);
  }
  try {
    const json = await api(ctx, PATHS.progress, { srchStrtDt: from, srchEndDt: to });
    if (diag) diag.progress = shape(json);
    for (const p of findArray(json?.data ?? json, ['deliveryProgressStateList', 'list', 'dataList'])) {
      const k = itemKeyOf(p);
      if (!k) continue;
      const cur = byKey.get(k);
      if (cur) {
        cur.step = stepOf(p) || cur.step;
        cur.data = { ...p, ...cur.data, odPrgsStepCd: stepOf(p) || cur.data.odPrgsStepCd };
      } else byKey.set(k, { data: p, step: stepOf(p) });
    }
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw e;
    errors.push(`배송상태 조회: ${e.message}`);
    if (!ordersOk) throw new Error(`롯데ON 주문을 가져오지 못했습니다. ${errors.join(' / ')}`);
  }
  return [...byKey.values()];
}

async function inform(ctx, items, step, extraFields = {}) {
  const list = items.map((it) => ({
    odNo: it.extra?.odNo,
    odSeq: it.extra?.odSeq ?? 1,
    procSeq: it.extra?.procSeq ?? 1,
    odPrgsStepCd: step,
    dvTrcStatDttm: dttm(new Date()),
    ...extraFields,
  }));
  const json = await api(ctx, PATHS.inform, { deliveryProgressStateList: list });
  // 상품별 결과가 있으면 반영
  const results = findArray(json?.data ?? json, ['resultList', 'deliveryProgressStateList', 'list']);
  const failMsg = new Map();
  for (const r of results) {
    const code = str(pick(r, ['resultCode', 'rsltCd', 'returnCode']));
    if (code && !OK_CODES.includes(code.toUpperCase())) failMsg.set(itemKeyOf(r), `${str(pick(r, ['resultMessage', 'rsltMsg', 'message']))} (${code})`);
  }
  return {
    ok: items.filter((i) => !failMsg.has(i.itemKey)).map((i) => i.itemKey),
    failed: items.filter((i) => failMsg.has(i.itemKey)).map((i) => ({ itemKey: i.itemKey, message: failMsg.get(i.itemKey) })),
  };
}

module.exports = {
  type: 'lotteon',
  label: '롯데ON',
  short: 'L',
  color: '#262626',
  beta: true,
  inquiries: false,
  backfill: true,
  sellerCenter: 'https://store.lotteon.com/',
  fields: [{ key: 'apiKey', label: 'OpenAPI 인증키', placeholder: '판매자센터에서 발급받은 인증키', required: true, secret: true }],
  guide: [
    '롯데ON 스토어센터 로그인 → 판매자정보 → OpenAPI 관리로 이동합니다.',
    "'서버 IP 등록' 칸에 아래 표시된 이 서버의 IP를 추가하고 [저장하기]를 누릅니다. 이미 다른 IP가 있으면 뒤에 세미콜론(;)을 붙여 이어서 적습니다. 예) 1.2.3.4;5.6.7.8",
    'IP를 저장한 뒤 [키발급]으로 새 인증키를 받아 아래에 입력하고 [연결 테스트]를 누릅니다. (다른 프로그램이 쓰는 기존 키는 그대로 두세요. 인증키는 3개까지, 유효기간 1년)',
    '베타 연동입니다. 연결 테스트 결과에 표시되는 응답 구조를 알려주시면 더 정확하게 맞출 수 있습니다.',
  ],

  async test(ctx) {
    const diag = {};
    const records = await collect(ctx, 2, diag);
    return {
      ok: true,
      message: `롯데ON 연결 성공 · 최근 주문 ${records.length}건 확인`,
      diagnostic: Object.entries(diag)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' | '),
    };
  },

  async fetch(ctx) {
    const state = { ...(ctx.state || {}) };
    if (ctx.backfillDays) {
      // 지난 주문 불러오기: 7일씩 나눠 조회
      const records = [];
      const now = Date.now();
      for (let back = ctx.backfillDays; back > 0; back -= 7) {
        const start = new Date(now - back * 86400000);
        const end = new Date(Math.min(now, start.getTime() + 7 * 86400000));
        records.push(...(await collect(ctx, { start, end })));
      }
      return { groups: toGroups(records), state };
    }
    const days = state._syncedOnce ? 7 : Math.max(ctx.initialDays || 7, 3);
    const records = await collect(ctx, days);
    return { groups: toGroups(records), state };
  },

  // 발주확인 = 상품준비(12) 통보
  async confirm(ctx, order, items) {
    return inform(ctx, items, '12');
  },

  // 발송처리 = 발송완료(13) 통보 + 택배사/송장
  async dispatch(ctx, order, items, { courierKey, trackingNo }) {
    const code = courierCode(courierKey, 'lotteon');
    if (!code) throw new Error('이 택배사는 롯데ON 코드가 없습니다. 택배사를 다시 선택하거나 직접 코드(4자리)를 입력해주세요.');
    return inform(ctx, items, '13', { invcNbr: 1, dvCoCd: code, invcNo: String(trackingNo).trim() });
  },

  _internal: { normalizeItem, toGroups, dttm, STEP, rawMode },
};
