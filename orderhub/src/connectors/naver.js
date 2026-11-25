'use strict';
// 네이버 스마트스토어 - 커머스API (https://apicenter.commerce.naver.com)
// 인증: client_secret_sign = base64(bcrypt(clientId + "_" + timestamp, clientSecret))
// 주문 수집: 변경 상품 주문 내역(last-changed-statuses) → 상품 주문 상세(query)
const bcrypt = require('bcryptjs');
const { request, parseJsonBig } = require('./http');
const { kstIso, toIso, toInt, str, chunk, sleep } = require('../util');
const { courierCode } = require('../couriers');

const tokenCache = new Map(); // clientId -> { token, expiresAt }

const STATUS_LABEL = {
  PAYMENT_WAITING: '결제대기',
  PAYED: '결제완료',
  DELIVERING: '배송중',
  DELIVERED: '배송완료',
  PURCHASE_DECIDED: '구매확정',
  EXCHANGED: '교환완료',
  CANCELED: '취소',
  RETURNED: '반품',
  CANCELED_BY_NOPAYMENT: '미결제취소',
};

const CLAIM_LABEL = {
  CANCEL_REQUEST: '취소요청',
  CANCELING: '취소처리중',
  RETURN_REQUEST: '반품요청',
  EXCHANGE_REQUEST: '교환요청',
  COLLECTING: '수거중',
  COLLECT_DONE: '수거완료',
  EXCHANGE_REDELIVERING: '교환재배송중',
  ADMIN_CANCELING: '직권취소중',
};

function baseUrl(ctx) {
  return ctx.config.naverApiBase;
}

function friendlyError(status, body, fallbackText) {
  const code = body?.code || '';
  const msg = body?.message || fallbackText || '';
  if (/IP_NOT_ALLOWED/i.test(code) || /IP_NOT_ALLOWED/i.test(msg)) {
    return '등록되지 않은 IP에서 호출했습니다. 커머스API센터 > 애플리케이션 > [API 호출 IP]에 이 서버의 IP를 등록해주세요.';
  }
  if (status === 401 || /invalid_client|client_secret/i.test(msg)) {
    return `인증 실패: 애플리케이션 ID/시크릿을 확인해주세요. (${code || status} ${msg})`.trim();
  }
  if (status === 403) return `권한 없음: 애플리케이션에 '주문' API 권한이 있는지 확인해주세요. (${code} ${msg})`;
  if (status === 429) return '호출 한도 초과 - 잠시 후 다시 시도합니다.';
  const detail = body?.invalidInputs ? ` ${JSON.stringify(body.invalidInputs)}` : '';
  return `스마트스토어 API 오류 (HTTP ${status}${code ? ' ' + code : ''}): ${msg}${detail}`;
}

function makeSign(clientId, clientSecret, timestamp) {
  try {
    const hashed = bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret);
    return Buffer.from(hashed, 'utf8').toString('base64');
  } catch (e) {
    throw new Error('애플리케이션 시크릿 형식이 올바르지 않습니다. 커머스API센터에서 복사한 값($2a$로 시작)을 그대로 넣어주세요.');
  }
}

async function getToken(ctx, force = false) {
  const { clientId, clientSecret } = ctx.creds;
  if (!clientId || !clientSecret) throw new Error('애플리케이션 ID와 시크릿을 입력해주세요');
  const cached = tokenCache.get(clientId);
  if (!force && cached && cached.expiresAt - 5 * 60000 > Date.now()) return cached.token;
  const timestamp = Date.now() - 3000; // 서버 시계 오차 여유
  const form = new URLSearchParams({
    client_id: clientId,
    timestamp: String(timestamp),
    grant_type: 'client_credentials',
    client_secret_sign: makeSign(clientId, clientSecret, timestamp),
    type: 'SELF',
  });
  const res = await request(`${baseUrl(ctx)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  const text = res.buffer.toString('utf8');
  let body = null;
  try {
    body = parseJsonBig(text);
  } catch {}
  if (!res.ok || !body?.access_token) throw new Error(friendlyError(res.status, body, text.slice(0, 200)));
  const token = body.access_token;
  tokenCache.set(clientId, { token, expiresAt: Date.now() + (Number(body.expires_in) || 10800) * 1000 });
  return token;
}

async function api(ctx, method, path, { query, body } = {}, attempt = 0) {
  const token = await getToken(ctx, attempt > 0 && attempt < 2);
  const url = new URL(baseUrl(ctx) + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await request(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = res.buffer.toString('utf8');
  let json = null;
  try {
    json = text ? parseJsonBig(text) : null;
  } catch {}
  if (res.status === 401 && attempt === 0) {
    tokenCache.delete(ctx.creds.clientId);
    return api(ctx, method, path, { query, body }, 1);
  }
  if (res.status === 429 && attempt < 3) {
    await sleep(1000 * (attempt + 1));
    return api(ctx, method, path, { query, body }, attempt + 2);
  }
  if (!res.ok) throw new Error(friendlyError(res.status, json, text.slice(0, 300)));
  return json;
}

function mapState(p) {
  switch (p.productOrderStatus) {
    case 'PAYMENT_WAITING':
      return 'PENDING';
    case 'PAYED':
      return p.placeOrderStatus === 'OK' ? 'CONFIRMED' : 'NEW';
    case 'DELIVERING':
      return 'SHIPPED';
    case 'DELIVERED':
    case 'PURCHASE_DECIDED':
    case 'EXCHANGED':
      return 'DELIVERED';
    case 'CANCELED':
    case 'CANCELED_BY_NOPAYMENT':
      return 'CANCELED';
    case 'RETURNED':
      return 'RETURNED';
    default:
      return 'NEW';
  }
}

function mapClaim(p) {
  const s = p.claimStatus || '';
  // 끝난 클레임만 제외 (수거완료 COLLECT_DONE 은 반품·교환 진행 중)
  if (!s || /^(CANCEL|RETURN|EXCHANGE|ADMIN_CANCEL)_DONE$|_REJECT$|^PURCHASE_DECISION/.test(s)) return null;
  const t = p.claimType || '';
  if (t === 'CANCEL' || t === 'ADMIN_CANCEL' || s.startsWith('CANCEL') || s.startsWith('ADMIN_CANCEL')) return 'CANCEL';
  if (t === 'RETURN' || s.startsWith('RETURN')) return 'RETURN';
  if (t === 'EXCHANGE' || s.startsWith('EXCHANGE')) return 'EXCHANGE';
  return null;
}

function normalize(detail) {
  const o = detail.order || {};
  const p = detail.productOrder || {};
  const d = detail.delivery || {};
  const addr = p.shippingAddress || {};
  const claim = mapClaim(p);
  let marketStatus = STATUS_LABEL[p.productOrderStatus] || p.productOrderStatus || '';
  if (p.productOrderStatus === 'PAYED') marketStatus = p.placeOrderStatus === 'OK' ? '발주확인' : '신규주문';
  if (claim && CLAIM_LABEL[p.claimStatus]) marketStatus += ` · ${CLAIM_LABEL[p.claimStatus]}`;
  return {
    groupKey: str(p.packageNumber) || str(p.productOrderId),
    group: {
      orderNo: str(o.orderId),
      orderedAt: toIso(o.orderDate),
      paidAt: toIso(o.paymentDate),
      shipDue: toIso(p.shippingDueDate),
      ordererName: str(o.ordererName),
      ordererPhone: str(o.ordererTel),
      receiverName: str(addr.name),
      receiverPhone: str(addr.tel1),
      receiverPhone2: str(addr.tel2),
      zipcode: str(addr.zipCode),
      address1: str(addr.baseAddress),
      address2: str(addr.detailedAddress),
      deliveryMemo: str(p.shippingMemo),
      customsCode: str(p.individualCustomUniqueCode),
      shippingFee: toInt(p.deliveryFeeAmount, 0),
      marketCourierCode: str(d.deliveryCompany),
      marketTrackingNo: str(d.trackingNumber),
      addressChanged: false,
    },
    item: {
      itemKey: str(p.productOrderId),
      orderNo: str(o.orderId),
      productName: str(p.productName),
      optionName: str(p.productOption),
      quantity: toInt(p.quantity, 1),
      unitPrice: toInt(p.unitPrice),
      amount: toInt(p.totalPaymentAmount),
      productCode: str(p.sellerProductCode) || str(p.optionManageCode),
      productId: str(p.productId),
      marketState: mapState(p),
      marketStatus,
      claim,
      extra: { productOrderId: str(p.productOrderId), orderId: str(o.orderId), claimType: str(p.claimType), claimStatus: str(p.claimStatus) },
      raw: detail,
    },
  };
}

function toGroups(details) {
  const map = new Map();
  for (const d of details) {
    const n = normalize(d);
    if (!n.item.itemKey) continue;
    if (!map.has(n.groupKey)) map.set(n.groupKey, { groupKey: n.groupKey, ...n.group, items: [] });
    map.get(n.groupKey).items.push(n.item);
  }
  return [...map.values()];
}

async function queryDetails(ctx, ids) {
  const out = [];
  for (const part of chunk(ids, 300)) {
    const r = await api(ctx, 'POST', '/v1/pay-order/seller/product-orders/query', { body: { productOrderIds: part } });
    if (Array.isArray(r?.data)) out.push(...r.data);
  }
  return out;
}

async function fetchChangedIds(ctx, fromDate, toDate, { gapMs = 0 } = {}) {
  const ids = new Set();
  let from = new Date(fromDate);
  const end = new Date(toDate);
  let guard = 0;
  while (from < end && guard++ < 200) {
    const windowEnd = new Date(Math.min(from.getTime() + 24 * 3600000 - 1000, end.getTime()));
    let moreFrom = null;
    let moreSequence = null;
    let pageGuard = 0;
    do {
      const r = await api(ctx, 'GET', '/v1/pay-order/seller/product-orders/last-changed-statuses', {
        query: {
          lastChangedFrom: kstIso(moreFrom ? new Date(moreFrom) : from),
          lastChangedTo: kstIso(windowEnd),
          moreSequence: moreSequence || undefined,
        },
      });
      const data = r?.data || {};
      for (const s of data.lastChangeStatuses || []) {
        if (s.productOrderId) ids.add(String(s.productOrderId));
      }
      moreFrom = data.more?.moreFrom || null;
      moreSequence = data.more?.moreSequence || null;
    } while (moreFrom && pageGuard++ < 100);
    from = new Date(windowEnd.getTime() + 1);
    if (gapMs && from < end) await sleep(gapMs); // 지난 주문 불러오기처럼 여러 날을 조회할 때 호출 간격
  }
  return [...ids];
}

const meta = {
  type: 'naver',
  label: '스마트스토어',
  short: 'N',
  color: '#03c75a',
  beta: false,
  inquiries: true, // 고객/상품 문의 수집
  answerable: true, // 오더허브에서 답변 가능
  backfill: true, // 지난 주문 불러오기 지원
  sellerCenter: 'https://sell.smartstore.naver.com/',
  fields: [
    { key: 'clientId', label: '애플리케이션 ID', placeholder: '예) 7dMvteboKNHwyRremLXXXX', required: true },
    { key: 'clientSecret', label: '애플리케이션 시크릿', placeholder: '$2a$04$... 형식', required: true, secret: true },
  ],
  guide: [
    '네이버 커머스API센터(apicenter.commerce.naver.com)에 스마트스토어 판매자 계정으로 로그인합니다.',
    '[애플리케이션 등록] → 직접 사용(내 스토어용)으로 애플리케이션을 만듭니다.',
    'API 그룹에서 "주문" 관련 권한(주문 조회·발주/발송 처리)을 선택합니다.',
    '[API 호출 IP]에 아래 표시된 이 서버의 IP를 등록합니다. (IP가 다르면 호출이 거부됩니다)',
    '발급된 애플리케이션 ID와 시크릿을 아래에 붙여넣고 [연결 테스트]를 누릅니다.',
  ],
};

module.exports = {
  ...meta,

  async test(ctx) {
    await getToken(ctx, true);
    const now = new Date();
    await fetchChangedIds(ctx, new Date(now.getTime() - 3600000), now);
    return { ok: true, message: '스마트스토어 연결 성공 (인증 + 주문 조회 권한 확인)' };
  },

  async fetch(ctx) {
    const state = { ...(ctx.state || {}) };
    const now = new Date();
    let from;
    if (ctx.backfillDays) {
      // 지난 주문 불러오기: 지정한 기간 동안 상태가 바뀐(결제 포함) 모든 상품주문
      from = new Date(now.getTime() - ctx.backfillDays * 86400000);
    } else {
      const initialDays = ctx.initialDays || 7;
      from = state.cursor ? new Date(state.cursor) : new Date(now.getTime() - initialDays * 86400000);
      // 너무 오래 쉬었으면 최대 7일 전까지만
      const minFrom = new Date(now.getTime() - 7 * 86400000);
      if (from < minFrom) from = minFrom;
    }
    const ids = await fetchChangedIds(ctx, from, now, { gapMs: ctx.backfillDays ? ctx.config.backfillGapMs ?? 150 : 0 });
    const details = ids.length ? await queryDetails(ctx, ids) : [];
    // 변경 내역 반영 지연을 고려해 10분 겹쳐서 다음 조회
    state.cursor = new Date(Math.max(from.getTime(), now.getTime() - 10 * 60000)).toISOString();
    return { groups: toGroups(details), state };
  },

  // 고객의 취소 요청 승인(바로 환불) / 반품 승인(환불) - 상품주문마다
  //   POST /v1/pay-order/seller/product-orders/{productOrderId}/claim/cancel/approve
  //   POST /v1/pay-order/seller/product-orders/{productOrderId}/claim/return/approve (보통 수거완료 뒤)
  async approveClaim(ctx, order, items, type) {
    const kind = type === 'CANCEL' ? 'cancel' : 'return';
    const ok = [];
    const failed = [];
    for (const it of items) {
      const id = it.extra?.productOrderId || it.itemKey;
      try {
        const r = await api(ctx, 'POST', `/v1/pay-order/seller/product-orders/${encodeURIComponent(id)}/claim/${kind}/approve`, { body: {} });
        const fail = (r?.data?.failProductOrderInfos || []).find((f) => String(f.productOrderId) === String(id));
        if (fail) failed.push({ itemKey: it.itemKey, message: `${fail.message || ''} (${fail.code || ''})`.trim() });
        else ok.push(it.itemKey);
      } catch (e) {
        let message = e.message;
        // 반품은 수거가 끝나야 승인되는 경우가 많음
        if (type === 'RETURN' && ['RETURN_REQUEST', 'COLLECTING'].includes(it.extra?.claimStatus)) message += ' - 아직 수거 전이라면 수거가 끝난 뒤 다시 눌러주세요 (스마트스토어센터에서 수거완료 처리도 가능)';
        failed.push({ itemKey: it.itemKey, message });
      }
    }
    return { ok, failed };
  },

  // 특정 상품주문 최신 상태 다시 조회
  async refresh(ctx, items) {
    const ids = items.map((i) => i.extra?.productOrderId).filter(Boolean);
    if (!ids.length) return [];
    return toGroups(await queryDetails(ctx, ids));
  },

  async confirm(ctx, order, items) {
    const ids = items.map((i) => i.extra?.productOrderId).filter(Boolean);
    const ok = [];
    const failed = [];
    for (const part of chunk(ids, 30)) {
      const r = await api(ctx, 'POST', '/v1/pay-order/seller/product-orders/confirm', { body: { productOrderIds: part } });
      for (const s of r?.data?.successProductOrderInfos || []) ok.push(String(s.productOrderId));
      for (const f of r?.data?.failProductOrderInfos || []) {
        failed.push({ itemKey: String(f.productOrderId), message: `${f.message || ''} (${f.code || ''})`.trim() });
      }
    }
    return { ok, failed };
  },

  // 고객 문의(주문 관련) + 상품 문의(Q&A) - 최근 7일
  async fetchInquiries(ctx) {
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 86400000);
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const r = await api(ctx, 'GET', '/v1/pay-user/inquiries', {
        query: { startSearchDate: kstIso(from).slice(0, 10), endSearchDate: kstIso(now).slice(0, 10), page, size: 100 },
      });
      for (const q of r?.content || []) {
        out.push({
          key: `c-${q.inquiryNo}`,
          kind: 'customer',
          category: str(q.category),
          title: str(q.title),
          content: str(q.inquiryContent),
          productName: [str(q.productName), str(q.productOrderOption)].filter(Boolean).join(' / '),
          orderNo: str(q.orderId),
          writer: str(q.customerName),
          askedAt: toIso(q.inquiryRegistrationDateTime),
          answered: !!q.answered,
          answer: str(q.answerContent),
          extra: { inquiryNo: str(q.inquiryNo) },
        });
      }
      if (r?.last !== false || !(r?.content || []).length) break;
    }
    for (let page = 1; page <= 5; page++) {
      const r = await api(ctx, 'GET', '/v1/contents/qnas', { query: { fromDate: from.toISOString(), toDate: now.toISOString(), page, size: 100 } });
      for (const q of r?.contents || []) {
        out.push({
          key: `p-${q.questionId}`,
          kind: 'product',
          category: '상품',
          title: '',
          content: str(q.question),
          productName: str(q.productName),
          orderNo: '',
          writer: str(q.maskedWriterId),
          askedAt: toIso(q.createDate),
          answered: !!q.answered,
          answer: str(q.answer),
          extra: { questionId: str(q.questionId) },
        });
      }
      if (r?.last !== false || !(r?.contents || []).length) break;
    }
    return out;
  },

  async answerInquiry(ctx, inquiry, text) {
    const e = inquiry.extra || {};
    if (inquiry.kind === 'product' && e.questionId) {
      await api(ctx, 'PUT', `/v1/contents/qnas/${encodeURIComponent(e.questionId)}`, { body: { commentContent: text } });
    } else if (e.inquiryNo) {
      await api(ctx, 'POST', `/v1/pay-merchant/inquiries/${encodeURIComponent(e.inquiryNo)}/answer`, { body: { answerComment: text } });
    } else throw new Error('문의 번호가 없습니다');
    return { ok: true };
  },

  async dispatch(ctx, order, items, { courierKey, trackingNo }) {
    const code = courierCode(courierKey, 'naver');
    if (!code) throw new Error('이 택배사는 스마트스토어 코드가 없습니다. 택배사를 다시 선택하거나 직접 코드를 입력해주세요.');
    const dispatchDate = kstIso(new Date());
    // 직접전달(직접발송): 택배사·송장번호 없이 배송방법만
    const direct = code === 'DIRECT_DELIVERY';
    const list = items
      .filter((i) => i.extra?.productOrderId)
      .map((i) =>
        direct
          ? { productOrderId: i.extra.productOrderId, deliveryMethod: 'DIRECT_DELIVERY', dispatchDate }
          : {
              productOrderId: i.extra.productOrderId,
              deliveryMethod: 'DELIVERY',
              deliveryCompanyCode: code,
              trackingNumber: String(trackingNo).trim(),
              dispatchDate,
            }
      );
    const ok = [];
    const failed = [];
    for (const part of chunk(list, 30)) {
      const r = await api(ctx, 'POST', '/v1/pay-order/seller/product-orders/dispatch', { body: { dispatchProductOrders: part } });
      for (const id of r?.data?.successProductOrderIds || []) ok.push(String(id));
      for (const f of r?.data?.failProductOrderInfos || []) {
        failed.push({ itemKey: String(f.productOrderId), message: `${f.message || ''} (${f.code || ''})`.trim() });
      }
    }
    return { ok, failed };
  },

  _internal: { makeSign, normalize, mapState, mapClaim, tokenCache },
};
