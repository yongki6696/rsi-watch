'use strict';
// 11번가 - 셀러 Open API (https://openapi.11st.co.kr)
// 인증: 요청 헤더 openapikey / 응답: XML (EUC-KR)
// 주문 수집: 결제완료(발주확인할 내역) / 배송준비중(발송처리할 내역) / 취소요청 목록
const { request, decodeText } = require('./http');
const { kstCompact, toIso, toInt, str, sleep } = require('../util');
const { courierCode } = require('../couriers');

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// 평평한 XML 요소(<a>값</a>)들을 객체로
function parseFlat(xml) {
  const obj = {};
  const re = /<(?:[A-Za-z0-9_]+:)?([A-Za-z0-9_]+)(?:\s[^>]*)?>([^<]*(?:<!\[CDATA\[[\s\S]*?\]\]>[^<]*)*)<\/(?:[A-Za-z0-9_]+:)?\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (!(m[1] in obj)) obj[m[1]] = decodeEntities(m[2]).trim();
  }
  return obj;
}

// 반복 요소(<ns2:order>…</ns2:order>) 추출
function parseList(xml, tag) {
  const out = [];
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(parseFlat(m[1]));
  return out;
}

function resultOf(xml) {
  const code = (xml.match(/<(?:[A-Za-z0-9_]+:)?result_code>\s*([^<]*?)\s*</) || [])[1];
  const text =
    (xml.match(/<(?:[A-Za-z0-9_]+:)?result_text>([\s\S]*?)</) || [])[1] ||
    (xml.match(/<(?:[A-Za-z0-9_]+:)?result_message>([\s\S]*?)</) || [])[1] ||
    '';
  return { code: code === undefined ? null : code, text: decodeEntities(text || '').trim() };
}

const ERROR_CODES = new Set(['-1', '2', '1000', '-1000']);

async function api(ctx, path, attempt = 0) {
  const key = ctx.creds.apiKey;
  if (!key) throw new Error('11번가 Open API Key를 입력해주세요');
  const res = await request(ctx.config.elevenstApiBase + path, {
    method: 'GET',
    headers: { openapikey: key, Accept: 'application/xml, text/xml' },
  });
  const xml = decodeText(res.buffer, res.headers, 'euc-kr');
  if (res.status === 429 && attempt < 3) {
    await sleep(1500 * (attempt + 1));
    return api(ctx, path, attempt + 1);
  }
  if (!res.ok) {
    const r = resultOf(xml);
    const hint = res.status === 401 || res.status === 403 ? ' (API Key 또는 등록된 서버 IP를 확인해주세요)' : '';
    throw new Error(`11번가 API 오류 (HTTP ${res.status})${hint}: ${r.text || xml.slice(0, 200)}`);
  }
  const r = resultOf(xml);
  if (r.code !== null && ERROR_CODES.has(r.code)) {
    throw new Error(`11번가 API 오류 (${r.code}): ${r.text || '알 수 없는 오류'}`);
  }
  return xml;
}

const pick = (o, ...keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== '' && o[k] !== 'null') return o[k];
  return '';
};

function findCustoms(o) {
  const direct = pick(o, 'psnCscUniqNo', 'prsnCstmsClrnNo', 'cstmsClrnNo', 'customsCode', 'psnCstmsUniqNo');
  if (direct) return direct;
  for (const v of Object.values(o)) if (/^P\d{12}$/.test(String(v))) return String(v);
  return '';
}

function normalizeOrder(o, state, label) {
  const ordNo = pick(o, 'ordNo');
  const seq = pick(o, 'ordPrdSeq');
  const dlvNo = pick(o, 'dlvNo') || `${ordNo}`;
  const qty = toInt(pick(o, 'ordQty', 'ordCnt'), 1);
  return {
    groupKey: String(dlvNo),
    orderNo: String(ordNo),
    orderedAt: toIso(pick(o, 'ordDt', 'ordStlDt')),
    paidAt: toIso(pick(o, 'ordStlEndDt', 'ordDt')),
    shipDue: toIso(pick(o, 'dlvSndDue', 'delaySendDt')),
    ordererName: pick(o, 'ordNm', 'memNm'),
    ordererPhone: pick(o, 'ordPrtblTel', 'ordTlphnNo'),
    receiverName: pick(o, 'rcvrNm'),
    receiverPhone: pick(o, 'rcvrPrtblNo', 'rcvrTlphn'),
    receiverPhone2: pick(o, 'rcvrPrtblNo') ? pick(o, 'rcvrTlphn') : '',
    zipcode: pick(o, 'rcvrMailNo'),
    address1: pick(o, 'rcvrBaseAddr'),
    address2: pick(o, 'rcvrDtlsAddr'),
    deliveryMemo: pick(o, 'ordDlvReqCont', 'dlvReqCont'),
    customsCode: findCustoms(o),
    shippingFee: toInt(pick(o, 'dlvCst'), 0),
    items: [
      {
        itemKey: `${ordNo}-${seq}`,
        orderNo: String(ordNo),
        productName: pick(o, 'prdNm'),
        optionName: pick(o, 'slctPrdOptNm', 'optNm'),
        quantity: qty,
        unitPrice: toInt(pick(o, 'selPrc')),
        amount: toInt(pick(o, 'ordPayAmt', 'ordAmt')),
        productCode: pick(o, 'sellerPrdCd', 'sellerStockCd'),
        productId: pick(o, 'prdNo'),
        marketState: state,
        marketStatus: label,
        claim: null,
        extra: {
          ordNo: String(ordNo),
          ordPrdSeq: String(seq),
          addPrdYn: pick(o, 'addPrdYn') || 'N',
          addPrdNo: pick(o, 'addPrdNo') || 'null',
          dlvNo: String(dlvNo),
        },
        raw: o,
      },
    ],
  };
}

function mergeGroups(list) {
  const map = new Map();
  const partials = [];
  for (const g of list) {
    if (g.partial) {
      partials.push(g);
      continue;
    }
    if (!map.has(g.groupKey)) map.set(g.groupKey, { ...g, items: [] });
    const target = map.get(g.groupKey);
    for (const it of g.items) {
      const idx = target.items.findIndex((x) => x.itemKey === it.itemKey);
      if (idx >= 0) target.items[idx] = it;
      else target.items.push(it);
    }
  }
  return [...map.values(), ...partials];
}

const meta = {
  type: 'elevenst',
  label: '11번가',
  short: '11',
  color: '#ff0038',
  beta: true,
  fields: [{ key: 'apiKey', label: 'Open API Key', required: true, secret: true }],
  guide: [
    '11번가 셀러오피스 → [판매자 정보] 또는 Open API 센터(openapi.11st.co.kr)에서 Open API Key를 발급받습니다.',
    'API 사용 서버 IP 등록 메뉴가 있으면 아래 표시된 이 서버의 IP를 등록합니다.',
    '발급받은 Open API Key를 아래에 입력하고 [연결 테스트]를 누릅니다.',
    '11번가 연동은 베타입니다. 처음 며칠은 셀러오피스 화면과 수집 결과를 함께 확인해주세요.',
  ],
};

module.exports = {
  ...meta,

  async test(ctx) {
    const now = new Date();
    await api(ctx, `/ordservices/complete/${kstCompact(new Date(now.getTime() - 86400000))}/${kstCompact(now)}`);
    return { ok: true, message: '11번가 연결 성공 (결제완료 주문 조회 권한 확인)' };
  },

  async fetch(ctx) {
    const state = { ...(ctx.state || {}) };
    const now = new Date();
    const start = kstCompact(new Date(now.getTime() - 7 * 86400000 + 60000)); // 최대 7일
    const end = kstCompact(now);
    const list = [];
    const newXml = await api(ctx, `/ordservices/complete/${start}/${end}`);
    for (const o of parseList(newXml, 'order')) list.push(normalizeOrder(o, 'NEW', '결제완료'));
    const packXml = await api(ctx, `/ordservices/packaging/${start}/${end}`);
    for (const o of parseList(packXml, 'order')) list.push(normalizeOrder(o, 'CONFIRMED', '배송준비중'));

    const groups = mergeGroups(list);
    // 취소요청 목록 → 해당 상품에 취소요청 표시
    try {
      const cancelXml = await api(ctx, `/claimservice/cancelorders/${start}/${end}`);
      const reqs = parseList(cancelXml, 'order');
      for (const c of reqs) {
        const key = `${pick(c, 'ordNo')}-${pick(c, 'ordPrdSeq')}`;
        for (const g of groups) for (const it of g.items) if (it.itemKey === key) {
          it.claim = 'CANCEL';
          it.marketStatus += ' · 취소요청';
        }
      }
      // 목록에서 사라진 미처리 주문이 취소요청 목록에 있으면 표시용 그룹 생성
      const open = ctx.openGroups ? ctx.openGroups() : [];
      for (const c of reqs) {
        const key = `${pick(c, 'ordNo')}-${pick(c, 'ordPrdSeq')}`;
        const exists = groups.some((g) => g.items.some((it) => it.itemKey === key));
        if (!exists && open.some((g) => g.item_keys?.includes(key))) {
          const g = normalizeOrder(c, 'CONFIRMED', '취소요청');
          g.items[0].claim = 'CANCEL';
          g.partial = true;
          groups.push(g);
        }
      }
    } catch (e) {
      ctx.log?.(`11번가 취소요청 조회 실패: ${e.message}`);
    }
    // 취소완료 목록 → 취소 상태 반영
    try {
      const doneXml = await api(ctx, `/claimservice/canceledorders/${start}/${end}`);
      const open = ctx.openGroups ? ctx.openGroups() : [];
      for (const c of parseList(doneXml, 'order')) {
        const key = `${pick(c, 'ordNo')}-${pick(c, 'ordPrdSeq')}`;
        if (!open.some((g) => g.item_keys?.includes(key))) continue;
        const g = normalizeOrder(c, 'CANCELED', '취소완료');
        g.partial = true;
        groups.push(g);
      }
    } catch (e) {
      ctx.log?.(`11번가 취소완료 조회 실패: ${e.message}`);
    }
    return { groups: mergeGroups(groups), state };
  },

  // 발주확인 (결제완료 → 배송준비중)
  async confirm(ctx, order, items) {
    const ok = [];
    const failed = [];
    for (const it of items) {
      const e = it.extra || {};
      try {
        const xml = await api(
          ctx,
          `/ordservices/reqpackaging/${encodeURIComponent(e.ordNo)}/${encodeURIComponent(e.ordPrdSeq)}/${encodeURIComponent(
            e.addPrdYn || 'N'
          )}/${encodeURIComponent(e.addPrdNo || 'null')}/${encodeURIComponent(e.dlvNo)}`
        );
        const r = resultOf(xml);
        if (r.code === null || r.code === '0' || r.code === '1' || r.code === '100' || r.code === '200') ok.push(it.itemKey);
        else failed.push({ itemKey: it.itemKey, message: `${r.text} (${r.code})` });
      } catch (err) {
        failed.push({ itemKey: it.itemKey, message: err.message });
      }
    }
    return { ok, failed };
  },

  // 발송처리 (배송번호 단위)
  async dispatch(ctx, order, items, { courierKey, trackingNo }) {
    const code = courierCode(courierKey, 'elevenst');
    if (!code) throw new Error('이 택배사는 11번가 코드가 없습니다. 택배사를 다시 선택하거나 직접 코드를 입력해주세요.');
    const dlvNos = [...new Set(items.map((i) => i.extra?.dlvNo).filter(Boolean))];
    const okDlv = new Set();
    const failMsg = new Map();
    for (const dlvNo of dlvNos) {
      try {
        const xml = await api(
          ctx,
          `/ordservices/reqdelivery/${kstCompact(new Date())}/01/${encodeURIComponent(code)}/${encodeURIComponent(
            String(trackingNo).trim()
          )}/${encodeURIComponent(dlvNo)}`
        );
        const r = resultOf(xml);
        if (r.code === null || r.code === '0' || r.code === '1' || r.code === '100' || r.code === '200') okDlv.add(dlvNo);
        else failMsg.set(dlvNo, `${r.text} (${r.code})`);
      } catch (err) {
        failMsg.set(dlvNo, err.message);
      }
    }
    return {
      ok: items.filter((i) => okDlv.has(i.extra?.dlvNo)).map((i) => i.itemKey),
      failed: items.filter((i) => !okDlv.has(i.extra?.dlvNo)).map((i) => ({ itemKey: i.itemKey, message: failMsg.get(i.extra?.dlvNo) || '발송처리 실패' })),
    };
  },

  _internal: { parseList, parseFlat, resultOf, normalizeOrder },
};
