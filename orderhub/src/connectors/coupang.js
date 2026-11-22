'use strict';
// 쿠팡 Wing - Open API (https://developers.coupangcorp.com)
// 인증: CEA HMAC-SHA256  message = signedDate + METHOD + path + query
// 주문 수집: 발주서 목록(ordersheets) ACCEPT(결제완료) / INSTRUCT(상품준비중) …
const crypto = require('node:crypto');
const { request, parseJsonBig, stringifyBig, BIG } = require('./http');
const { kstDate, toIso, toInt, str, chunk, sleep } = require('../util');
const { courierCode } = require('../couriers');

const STATUS_LABEL = {
  ACCEPT: '결제완료',
  INSTRUCT: '상품준비중',
  DEPARTURE: '배송지시',
  DELIVERING: '배송중',
  FINAL_DELIVERY: '배송완료',
  NONE_TRACKING: '업체직송',
};

function signedDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(
    d.getUTCMinutes()
  )}${p(d.getUTCSeconds())}Z`;
}

function sign({ method, path, query, accessKey, secretKey, now }) {
  const date = signedDate(now);
  const message = date + method.toUpperCase() + path + (query || '');
  const signature = crypto.createHmac('sha256', secretKey).update(message, 'utf8').digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${date}, signature=${signature}`;
}

function buildQuery(query) {
  const parts = [];
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

function friendlyError(status, body, text) {
  const msg = body?.message || body?.errorMessage || text || '';
  if (/ip/i.test(msg) && /(not|allow|denied|whitelist|허용|등록)/i.test(msg)) {
    return `등록되지 않은 IP에서 호출했습니다. Wing > 판매자정보 > 추가판매정보 > OPEN API 키의 IP 주소에 이 서버 IP를 추가해주세요. (${msg})`;
  }
  if (status === 401 || status === 403) {
    return `쿠팡 인증 실패: 업체코드/Access Key/Secret Key와 등록 IP를 확인해주세요. (HTTP ${status} ${msg})`;
  }
  if (status === 429) return '쿠팡 호출 한도 초과 - 잠시 후 다시 시도합니다.';
  return `쿠팡 API 오류 (HTTP ${status}${body?.code ? ' ' + body.code : ''}): ${msg}`;
}

const vendorPath = (v, vendorId) => `/v2/providers/openapi/apis/api/${v}/vendors/${encodeURIComponent(vendorId)}`;

async function api(ctx, method, path, { query, body } = {}, attempt = 0) {
  const { accessKey, secretKey } = ctx.creds;
  if (!accessKey || !secretKey || !ctx.creds.vendorId) throw new Error('업체코드, Access Key, Secret Key를 모두 입력해주세요');
  const qs = buildQuery(query);
  const authorization = sign({ method, path, query: qs, accessKey, secretKey });
  const res = await request(ctx.config.coupangApiBase + path + (qs ? `?${qs}` : ''), {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
    },
    body: body !== undefined ? stringifyBig(body) : undefined,
  });
  const text = res.buffer.toString('utf8');
  let json = null;
  try {
    json = text ? parseJsonBig(text) : null;
  } catch {}
  if (res.status === 429 && attempt < 3) {
    await sleep(1200 * (attempt + 1));
    return api(ctx, method, path, { query, body }, attempt + 1);
  }
  const bizError = typeof json?.code === 'string' && json.code.toUpperCase() === 'ERROR';
  if (!res.ok || bizError) {
    const err = new Error(friendlyError(res.status, json, text.slice(0, 300)));
    err.status = res.status;
    throw err;
  }
  return json;
}

function mapState(status) {
  switch (status) {
    case 'ACCEPT':
      return 'NEW';
    case 'INSTRUCT':
      return 'CONFIRMED';
    case 'DEPARTURE':
    case 'DELIVERING':
    case 'NONE_TRACKING':
      return 'SHIPPED';
    case 'FINAL_DELIVERY':
      return 'DELIVERED';
    default:
      return 'NEW';
  }
}

function normalizeSheet(s) {
  const orderer = s.orderer || {};
  const receiver = s.receiver || {};
  const oversea = s.overseaShippingInfoDto || {};
  const boxId = str(s.shipmentBoxId);
  const orderNo = str(s.orderId);
  const state = mapState(s.status);
  const items = (s.orderItems || []).map((it) => {
    const qty = toInt(it.shippingCount, 0);
    const cancelCount = toInt(it.cancelCount, 0);
    const hold = toInt(it.holdCountForCancel, 0);
    const canceled = it.canceled === true || (qty > 0 && cancelCount >= qty) || (qty === 0 && cancelCount > 0);
    const productName = str(it.sellerProductName) || str(it.vendorItemName);
    let optionName = str(it.sellerProductItemName);
    if (!optionName && it.vendorItemName && productName && it.vendorItemName !== productName) {
      optionName = str(it.vendorItemName).replace(productName, '').replace(/^[,\s]+/, '');
    }
    let marketStatus = STATUS_LABEL[s.status] || s.status || '';
    if (canceled) marketStatus = '취소';
    else if (hold > 0) marketStatus += ' · 출고중지요청';
    return {
      itemKey: `${boxId}-${str(it.vendorItemId)}`,
      orderNo,
      productName,
      optionName,
      quantity: qty || toInt(it.shippingCount, 1),
      unitPrice: toInt(it.salesPrice),
      amount: toInt(it.orderPrice),
      productCode: str(it.externalVendorSkuCode),
      productId: str(it.vendorItemId),
      marketState: canceled ? 'CANCELED' : state,
      marketStatus,
      claim: !canceled && hold > 0 ? 'CANCEL' : null,
      extra: { shipmentBoxId: boxId, orderId: orderNo, vendorItemId: str(it.vendorItemId) },
      raw: { ...s, orderItems: [it] },
    };
  });
  return {
    groupKey: boxId,
    orderNo,
    orderedAt: toIso(s.orderedAt),
    paidAt: toIso(s.paidAt),
    shipDue: toIso(s.orderItems?.[0]?.estimatedShippingDate),
    ordererName: str(orderer.name),
    ordererPhone: str(orderer.ordererNumber) || str(orderer.safeNumber),
    receiverName: str(receiver.name),
    receiverPhone: str(receiver.receiverNumber) || str(receiver.safeNumber),
    receiverPhone2: receiver.receiverNumber && receiver.safeNumber ? str(receiver.safeNumber) : '',
    zipcode: str(receiver.postCode),
    address1: str(receiver.addr1),
    address2: str(receiver.addr2),
    deliveryMemo: str(s.parcelPrintMessage),
    customsCode: str(oversea.personalCustomsClearanceCode),
    shippingFee: toInt(s.shippingPrice, 0) + toInt(s.remotePrice, 0),
    marketTrackingNo: str(s.invoiceNumber),
    marketCourierName: str(s.deliveryCompanyName),
    items,
  };
}

// 발주서 목록 (v5 → 실패 시 v4, 날짜형식 yyyy-MM-dd+09:00 → 실패 시 yyyy-MM-dd)
async function listSheets(ctx, state, status, fromDate, toDate) {
  const variants = [];
  const preferred = state.listVariant;
  const all = [
    { v: 'v5', tz: true },
    { v: 'v5', tz: false },
    { v: 'v4', tz: true },
    { v: 'v4', tz: false },
  ];
  if (preferred) variants.push(preferred);
  for (const a of all) if (!preferred || a.v !== preferred.v || a.tz !== preferred.tz) variants.push(a);

  let lastErr;
  for (const variant of variants) {
    try {
      const sheets = [];
      let nextToken = '';
      let guard = 0;
      do {
        const r = await api(ctx, 'GET', `${vendorPath(variant.v, ctx.creds.vendorId)}/ordersheets`, {
          query: {
            createdAtFrom: variant.tz ? `${fromDate}+09:00` : fromDate,
            createdAtTo: variant.tz ? `${toDate}+09:00` : toDate,
            status,
            maxPerPage: 50,
            nextToken: nextToken || undefined,
          },
        });
        const data = Array.isArray(r?.data) ? r.data : [];
        sheets.push(...data);
        nextToken = r?.nextToken || '';
      } while (nextToken && guard++ < 100);
      state.listVariant = variant;
      return sheets;
    } catch (e) {
      lastErr = e;
      // 인증/IP 문제는 형식을 바꿔도 소용없음
      if (e.status === 401 || e.status === 403 || e.status === 429 || !e.status) throw e;
    }
  }
  throw lastErr;
}

async function getSheet(ctx, state, shipmentBoxId) {
  const v = state.listVariant?.v || 'v5';
  const versions = v === 'v5' ? ['v5', 'v4'] : ['v4', 'v5'];
  let lastErr;
  for (const ver of versions) {
    try {
      const r = await api(ctx, 'GET', `${vendorPath(ver, ctx.creds.vendorId)}/ordersheets/${encodeURIComponent(shipmentBoxId)}`);
      const d = Array.isArray(r?.data) ? r.data[0] : r?.data;
      return d || null;
    } catch (e) {
      lastErr = e;
      if (e.status === 401 || e.status === 403 || !e.status) throw e;
    }
  }
  throw lastErr;
}

// 쿠팡 일괄처리 응답(responseList)을 상품 단위 결과로 변환
function resultForItems(items, r, defaultMessage) {
  const data = r?.data || {};
  const list = Array.isArray(data.responseList) ? data.responseList : null;
  const okBoxes = new Set();
  const failMsg = new Map();
  if (list) {
    for (const x of list) {
      const id = String(x.shipmentBoxId);
      if (x.succeed) okBoxes.add(id);
      else failMsg.set(id, `${x.resultMessage || ''} (${x.resultCode || ''})`.trim());
    }
  } else if (Number(data.responseCode ?? 0) === 0) {
    items.forEach((i) => okBoxes.add(i.extra?.shipmentBoxId));
  }
  const fallback = data.responseMessage || defaultMessage;
  return {
    ok: items.filter((i) => okBoxes.has(i.extra?.shipmentBoxId)).map((i) => i.itemKey),
    failed: items
      .filter((i) => !okBoxes.has(i.extra?.shipmentBoxId))
      .map((i) => ({ itemKey: i.itemKey, message: failMsg.get(i.extra?.shipmentBoxId) || fallback })),
  };
}

const meta = {
  type: 'coupang',
  label: '쿠팡',
  short: 'C',
  color: '#e52528',
  beta: false,
  fields: [
    { key: 'vendorId', label: '업체코드 (Vendor ID)', placeholder: '예) A00012345', required: true },
    { key: 'accessKey', label: 'Access Key', required: true },
    { key: 'secretKey', label: 'Secret Key', required: true, secret: true },
  ],
  guide: [
    '쿠팡 Wing(wing.coupang.com)에 로그인 → 우측 상단 [판매자명] → [추가판매정보]로 이동합니다.',
    '[OPEN API 키 발급] → 연동 방식은 "자체개발(직접입력)"을 선택합니다.',
    'IP 주소 칸에 아래 표시된 이 서버의 IP를 입력합니다. (여러 개면 쉼표로 구분)',
    '발급된 업체코드(A로 시작), Access Key, Secret Key를 아래에 입력하고 [연결 테스트]를 누릅니다.',
    '참고: 쿠팡 OPEN API 키는 약 180일마다 재발급이 필요합니다.',
  ],
};

module.exports = {
  ...meta,

  async test(ctx) {
    const state = {};
    const today = kstDate(new Date());
    const from = kstDate(new Date(Date.now() - 86400000));
    await listSheets(ctx, state, 'ACCEPT', from, today);
    return { ok: true, message: '쿠팡 연결 성공 (발주서 조회 권한 확인)' };
  },

  async fetch(ctx) {
    const state = { ...(ctx.state || {}) };
    const now = new Date();
    const runCount = (state.runCount || 0) + 1;
    state.runCount = runCount;
    const days = ctx.initialDays && !state.initialized ? Math.max(ctx.initialDays, 3) : 7;
    const from = kstDate(new Date(now.getTime() - days * 86400000));
    const to = kstDate(now);

    const statuses = ['ACCEPT', 'INSTRUCT'];
    // 30분마다(6회에 1번) 배송 단계 상태도 동기화
    if (runCount % 6 === 1) statuses.push('DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY');
    const sheets = new Map();
    for (const st of statuses) {
      const fromForStatus = st === 'FINAL_DELIVERY' || st === 'DELIVERING' ? kstDate(new Date(now.getTime() - 14 * 86400000)) : from;
      for (const s of await listSheets(ctx, state, st, fromForStatus, to)) sheets.set(str(s.shipmentBoxId), s);
    }

    // 목록에서 사라진 미처리 주문(고객 취소 등)은 단건 조회로 최신 상태 확인
    const open = ctx.openGroups ? ctx.openGroups() : [];
    const missing = open.filter((g) => !sheets.has(g.group_key)).slice(0, 30);
    for (const g of missing) {
      try {
        const s = await getSheet(ctx, state, g.group_key);
        if (s) sheets.set(str(s.shipmentBoxId), s);
      } catch (e) {
        ctx.log?.(`쿠팡 단건 조회 실패(${g.group_key}): ${e.message}`);
      }
    }
    state.initialized = true;
    return { groups: [...sheets.values()].map(normalizeSheet), state };
  },

  async refresh(ctx, items) {
    const state = { ...(ctx.state || {}) };
    const boxIds = [...new Set(items.map((i) => i.extra?.shipmentBoxId).filter(Boolean))];
    const out = [];
    for (const id of boxIds) {
      const s = await getSheet(ctx, state, id);
      if (s) out.push(normalizeSheet(s));
    }
    return out;
  },

  // 발주확인 = 상품준비중 처리 (ACCEPT → INSTRUCT)
  async confirm(ctx, order, items) {
    const boxIds = [...new Set(items.map((i) => i.extra?.shipmentBoxId).filter(Boolean))];
    const ok = [];
    const failed = [];
    for (const part of chunk(boxIds, 50)) {
      const partItems = items.filter((i) => part.includes(i.extra?.shipmentBoxId));
      const path = `${vendorPath('v4', ctx.creds.vendorId)}/ordersheets/acknowledgement`;
      const body = { vendorId: ctx.creds.vendorId, shipmentBoxIds: part.map(BIG) };
      let r;
      try {
        r = await api(ctx, 'PUT', path, { body });
      } catch (e) {
        if (e.status === 405) r = await api(ctx, 'PATCH', path, { body });
        else throw e;
      }
      const res = resultForItems(partItems, r, '상품준비중 처리 실패');
      ok.push(...res.ok);
      failed.push(...res.failed);
    }
    return { ok, failed };
  },

  // 송장 업로드 (INSTRUCT → DEPARTURE)
  async dispatch(ctx, order, items, { courierKey, trackingNo }) {
    const code = courierCode(courierKey, 'coupang');
    if (!code) throw new Error('이 택배사는 쿠팡 코드가 없습니다. 택배사를 다시 선택하거나 직접 코드를 입력해주세요.');
    const dtos = items
      .filter((i) => i.extra?.shipmentBoxId && i.extra?.vendorItemId)
      .map((i) => ({
        shipmentBoxId: BIG(i.extra.shipmentBoxId),
        orderId: BIG(i.extra.orderId),
        vendorItemId: BIG(i.extra.vendorItemId),
        deliveryCompanyCode: code,
        invoiceNumber: String(trackingNo).trim(),
        splitShipping: false,
        preSplitShipped: false,
        estimatedShippingDate: '',
      }));
    const r = await api(ctx, 'POST', `${vendorPath('v4', ctx.creds.vendorId)}/orders/invoices`, {
      body: { vendorId: ctx.creds.vendorId, orderSheetInvoiceApplyDtos: dtos },
    });
    return resultForItems(items, r, '송장 등록 실패');
  },

  _internal: { sign, signedDate, buildQuery, normalizeSheet, mapState },
};
