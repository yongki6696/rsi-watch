'use strict';
// 쿠팡 Wing - Open API (https://developers.coupangcorp.com)
// 인증: CEA HMAC-SHA256  message = signedDate + METHOD + path + query
// 주문 수집: 발주서 목록(ordersheets) ACCEPT(결제완료) / INSTRUCT(상품준비중) …
const crypto = require('node:crypto');
const { request, parseJsonBig, stringifyBig, BIG } = require('./http');
const { kstDate, kstDateWindows, toIso, toInt, str, chunk, sleep } = require('../util');
const { courierCode } = require('../couriers');
const { COUPANG_FAULT, faultFromText, money } = require('../claims');

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
      extra: { shipmentBoxId: boxId, orderId: orderNo, vendorItemId: str(it.vendorItemId), displayProductId: str(it.productId) },
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

// 지난 주문 불러오기: 모든 배송 단계를 7일씩 나눠 조회 (매출 집계용)
async function backfill(ctx) {
  const state = { ...(ctx.state || {}) };
  const sheets = new Map();
  const warnings = [];
  let okStatuses = 0;
  for (const st of ['ACCEPT', 'INSTRUCT', 'DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY', 'NONE_TRACKING']) {
    try {
      for (const w of kstDateWindows(ctx.backfillDays, 7)) {
        for (const s of await listSheets(ctx, state, st, w.from, w.to)) sheets.set(str(s.shipmentBoxId), s);
        await sleep(ctx.config.backfillGapMs ?? 150);
      }
      okStatuses++;
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.network) throw e;
      warnings.push(`${STATUS_LABEL[st] || st} 조회 실패: ${e.message}`);
    }
  }
  if (!okStatuses) throw new Error(warnings.join(' / '));
  return { groups: [...sheets.values()].map(normalizeSheet), state, warnings };
}

const meta = {
  type: 'coupang',
  label: '쿠팡',
  short: 'C',
  color: '#e52528',
  beta: false,
  inquiries: true, // 상품 문의 + 고객센터 문의
  answerable: true, // 오더허브에서 답변 (답변자 = Wing 로그인 아이디)
  backfill: true,
  sellerCenter: 'https://wing.coupang.com/',
  fields: [
    { key: 'vendorId', label: '업체코드 (Vendor ID)', placeholder: '예) A00012345', required: true },
    { key: 'accessKey', label: 'Access Key', required: true },
    { key: 'secretKey', label: 'Secret Key', required: true, secret: true },
    { key: 'wingId', label: 'Wing 로그인 아이디 (문의 답변용)', placeholder: '쿠팡 Wing에 로그인하는 아이디 - 오더허브에서 문의에 답변할 때 필요' },
  ],
  guide: [
    '쿠팡 Wing(wing.coupang.com)에 로그인 → 우측 상단 [판매자명] → [추가판매정보]로 이동합니다.',
    '[OPEN API 키 발급] → 연동 방식은 "자체개발(직접입력)"을 선택합니다.',
    'IP 주소 칸에 아래 표시된 이 서버의 IP를 입력합니다. (여러 개면 쉼표로 구분)',
    '발급된 업체코드(A로 시작), Access Key, Secret Key를 아래에 입력하고 [연결 테스트]를 누릅니다.',
    '오더허브에서 쿠팡 문의에 답변하려면 Wing 로그인 아이디도 넣어주세요. (쿠팡이 답변한 사람을 이 아이디로 기록합니다)',
    '참고: 쿠팡 OPEN API 키는 약 180일마다 재발급이 필요합니다.',
  ],
};

// ---------- 반품·출고중지 접수 (반품/취소 요청 목록 v6) ----------
// 조회 status: RU 출고중지요청 / UC 반품접수 / PR 쿠팡확인요청 / CC 반품완료 (최대 31일, 페이지당 50건)
// 접수 상태(receiptStatus) → 오더허브 표시
const RECEIPT = {
  RELEASE_STOP_UNCHECKED: { claim: 'CANCEL', label: '출고중지요청' },
  RETURNS_UNCHECKED: { claim: 'RETURN', label: '반품접수' },
  VENDOR_WAREHOUSE_CONFIRM: { claim: 'RETURN', label: '반품 입고완료' },
  REQUEST_COUPANG_CHECK: { claim: 'RETURN', label: '반품 쿠팡확인요청' },
  RETURNS_COMPLETED: { claim: null, state: 'RETURNED', label: '반품완료' },
};

async function listReturns(ctx, status, days = 31) {
  const now = new Date();
  const base = { createdAtFrom: kstDate(new Date(now.getTime() - (days - 1) * 86400000)), createdAtTo: kstDate(now), status, cancelType: 'RETURN', maxPerPage: 50 };
  const out = [];
  let nextToken = '';
  for (let page = 0; page < 20; page++) {
    const r = await api(ctx, 'GET', `${vendorPath('v6', ctx.creds.vendorId)}/returnRequests`, { query: { ...base, ...(nextToken ? { nextToken } : {}) } });
    const list = Array.isArray(r?.data) ? r.data : Array.isArray(r?.data?.content) ? r.data.content : [];
    out.push(...list);
    nextToken = str(r?.nextToken ?? r?.data?.nextToken);
    if (!nextToken || !list.length) break;
  }
  return out;
}

// 접수 사유 → 오더허브 사유 정보
function receiptInfo(rc, type) {
  const reason = str(rc.reasonCodeText) || [str(rc.cancelReasonCategory1), str(rc.cancelReasonCategory2)].filter(Boolean).join(' > ');
  const detail = str(rc.cancelReason);
  const fault = COUPANG_FAULT[str(rc.faultByType).toUpperCase()] || faultFromText(`${reason} ${detail}`);
  const enclose = money(rc.enclosePrice);
  return {
    market: 'coupang',
    type,
    reasonCode: str(rc.reasonCode),
    reason: reason || detail,
    detail: detail !== reason ? detail : '',
    fault,
    faultBy: str(rc.faultByType),
    feeAmount: money(rc.returnShippingCharge),
    feeNote: enclose > 0 ? `동봉 ${enclose.toLocaleString('ko-KR')}원` : '',
    at: toIso(rc.createdAt),
  };
}

// 접수에 들어있는 상품의 오더허브 키 (묶음배송번호-옵션ID)
function receiptKeys(rc) {
  return (rc.returnItems || []).filter((ri) => ri && ri.shipmentBoxId && ri.vendorItemId).map((ri) => `${str(ri.shipmentBoxId)}-${str(ri.vendorItemId)}`);
}

// 반품·출고중지 접수 → 상품별 요청 표시. 반품완료는 30분마다, 또는 열려 있던 접수가 목록에서 빠졌을 때 확인
async function collectReturns(ctx, state, runCount) {
  const updates = new Map(); // itemKey → { claim, marketState?, label, vanished? }
  const open = {};
  for (const status of ['RU', 'UC', 'PR']) {
    for (const rc of await listReturns(ctx, status)) {
      const info = RECEIPT[str(rc.receiptStatus)] || (status === 'RU' ? RECEIPT.RELEASE_STOP_UNCHECKED : RECEIPT.RETURNS_UNCHECKED);
      const keys = receiptKeys(rc);
      if (!info.claim || !keys.length) continue;
      open[str(rc.receiptId)] = { keys, claim: info.claim };
      const why = receiptInfo(rc, info.claim);
      for (const k of keys) updates.set(k, { claim: info.claim, label: info.label, info: why });
    }
  }
  const prev = state.openReceipts || {};
  const vanished = Object.keys(prev).filter((id) => !open[id]);
  if (runCount % 6 === 1 || vanished.length) {
    for (const rc of await listReturns(ctx, 'CC')) {
      for (const k of receiptKeys(rc)) if (!updates.has(k)) updates.set(k, { claim: null, marketState: 'RETURNED', label: '반품완료', info: receiptInfo(rc, 'RETURN') });
    }
  }
  // 반품완료도 아닌데 목록에서 빠진 접수 = 고객 철회 또는 처리 끝남 → 요청 표시만 지움
  for (const id of vanished) {
    for (const k of prev[id].keys || []) {
      if (!updates.has(k)) updates.set(k, { claim: null, label: prev[id].claim === 'CANCEL' ? '출고중지요청 종료' : '반품요청 철회', vanished: true });
    }
  }
  state.openReceipts = open;
  return updates;
}

// 발주서 상품에 접수 내용을 반영하고, 이번에 발주서를 받지 않은 상품은 상태만 바꾸는 묶음으로
function applyReturns(groups, updates) {
  const seen = new Set();
  for (const g of groups) {
    for (const it of g.items) {
      const u = updates.get(it.itemKey);
      if (!u) continue;
      seen.add(it.itemKey);
      if (u.vanished || it.marketState === 'CANCELED') continue; // 방금 받은 발주서가 최신
      if (u.marketState) it.marketState = u.marketState;
      it.claim = u.claim;
      if (u.info) it.claimInfo = u.info;
      it.marketStatus = u.marketState ? u.label : it.marketStatus.includes(u.label) ? it.marketStatus : `${it.marketStatus} · ${u.label}`;
    }
  }
  const byBox = new Map();
  for (const [key, u] of updates) {
    if (seen.has(key)) continue;
    const box = key.split('-')[0];
    if (!byBox.has(box)) byBox.set(box, []);
    byBox.get(box).push({ itemKey: key, partial: true, claim: u.claim, marketState: u.marketState || null, marketStatus: u.label, ...(u.info ? { claimInfo: u.info } : {}) });
  }
  return [...groups, ...[...byBox].map(([box, items]) => ({ groupKey: box, partial: true, items }))];
}

// 쿠팡 응답의 처리 결과 확인 (data.resultCode SUCCESS)
function checkResult(r) {
  const d = r?.data;
  if (d && typeof d === 'object' && d.resultCode && String(d.resultCode).toUpperCase() !== 'SUCCESS') throw new Error(str(d.resultMessage) || str(d.resultCode));
}

// 출고중지요청 → 출고중지완료(취소완료) / 반품접수 → 입고확인 + 반품승인(반품완료)
//   PATCH v4 …/returnRequests/{receiptId}/stoppedShipment {vendorId, receiptId, cancelCount(접수 전체 수량)}
//   PATCH v4 …/returnRequests/{receiptId}/receiveConfirmation {vendorId, receiptId}
//   PATCH v4 …/returnRequests/{receiptId}/approval {vendorId, receiptId, cancelCount}
async function approveClaim(ctx, order, items, type) {
  const vendorId = ctx.creds.vendorId;
  const keys = new Set(items.map((i) => i.itemKey));
  const vendorItems = new Set(items.map((i) => str(i.extra?.vendorItemId)).filter(Boolean));
  const receipts = [];
  for (const s of type === 'CANCEL' ? ['RU'] : ['UC', 'PR']) {
    receipts.push(...(await listReturns(ctx, s)).filter((rc) => str(rc.orderId) === str(order.order_no)));
  }
  const ok = new Set();
  const failed = new Map();
  const v4 = `${vendorPath('v4', vendorId)}/returnRequests`;
  for (const rc of receipts) {
    const rcKeys = receiptKeys(rc);
    const mine = rcKeys.length ? rcKeys.filter((k) => keys.has(k)) : (rc.returnItems || []).some((ri) => vendorItems.has(str(ri.vendorItemId))) ? [...keys] : [];
    if (!mine.length) continue;
    const receiptId = str(rc.receiptId);
    const count =
      toInt(rc.cancelCountSum, 0) ||
      (rc.returnItems || []).reduce((n, ri) => n + toInt(ri.cancelCount, 0), 0) ||
      items.filter((i) => mine.includes(i.itemKey)).reduce((n, i) => n + (toInt(i.quantity, 0) || 1), 0);
    const st = str(rc.receiptStatus);
    try {
      if (type === 'CANCEL') {
        if (st && st !== 'RELEASE_STOP_UNCHECKED') throw new Error(`출고중지요청 상태가 아닙니다 (${RECEIPT[st]?.label || st})`);
        checkResult(await api(ctx, 'PATCH', `${v4}/${encodeURIComponent(receiptId)}/stoppedShipment`, { body: { vendorId, receiptId: BIG(receiptId), cancelCount: count } }));
      } else {
        if (st === 'REQUEST_COUPANG_CHECK') throw new Error('쿠팡이 확인 중인 반품이라 쿠팡 처리를 기다려야 합니다 (Wing에서 확인)');
        // 반품 상품을 받았다는 입고 확인 → 반품 승인
        if (st === 'RETURNS_UNCHECKED' || !st) checkResult(await api(ctx, 'PATCH', `${v4}/${encodeURIComponent(receiptId)}/receiveConfirmation`, { body: { vendorId, receiptId: BIG(receiptId) } }));
        checkResult(await api(ctx, 'PATCH', `${v4}/${encodeURIComponent(receiptId)}/approval`, { body: { vendorId, receiptId: BIG(receiptId), cancelCount: count } }));
      }
      for (const k of mine) ok.add(k);
    } catch (e) {
      if (e.network) throw e;
      for (const k of mine) failed.set(k, e.message);
    }
  }
  for (const k of keys) {
    if (!ok.has(k) && !failed.has(k)) {
      failed.set(k, type === 'CANCEL' ? '쿠팡에서 이 상품의 출고중지요청을 찾지 못했습니다 (이미 처리됐거나 고객이 철회했을 수 있어요)' : '쿠팡에서 이 상품의 반품 접수를 찾지 못했습니다 (이미 처리됐거나 고객이 철회했을 수 있어요)');
    }
  }
  return { ok: [...ok], failed: [...failed].map(([itemKey, message]) => ({ itemKey, message })) };
}

// 상품별 고객문의 (답변은 Wing 에서)
async function fetchOnline(ctx) {
  const now = new Date();
  const query = {
    vendorId: ctx.creds.vendorId,
    answeredType: 'ALL',
    inquiryStartAt: kstDate(new Date(now.getTime() - 6 * 86400000)),
    inquiryEndAt: kstDate(now),
    pageSize: 50,
    pageNum: 1,
  };
  let r;
  try {
    r = await api(ctx, 'GET', `${vendorPath('v5', ctx.creds.vendorId)}/onlineInquiries`, { query });
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    r = await api(ctx, 'GET', `${vendorPath('v4', ctx.creds.vendorId)}/onlineInquiries`, { query });
  }
  const list = Array.isArray(r?.data?.content) ? r.data.content : Array.isArray(r?.data) ? r.data : [];
  return list.map((q) => {
    const comments = q.commentDtoList || q.comments || q.answers || [];
    const answered = (Array.isArray(comments) && comments.length > 0) || q.answeredType === 'ANSWERED' || q.answered === true;
    const last = Array.isArray(comments) && comments.length ? comments[comments.length - 1] : null;
    return {
      key: `o-${str(q.inquiryId)}`,
      kind: 'product',
      category: '상품',
      title: '',
      content: str(q.content),
      productName: str(q.sellerProductName) || str(q.productName) || str(q.vendorItemName),
      productId: str(q.vendorItemId),
      orderNo: Array.isArray(q.orderIds) && q.orderIds.length ? str(q.orderIds[0]) : '',
      writer: str(q.buyerEmail) || str(q.customerName),
      askedAt: toIso(q.inquiryAt || q.createdAt),
      answered,
      answer: last ? str(last.content) : '',
      extra: { inquiryId: str(q.inquiryId) },
    };
  });
}

// 고객센터 문의 (쿠팡 고객센터가 판매자에게 넘긴 문의) - 최근 7일
//   partnerCounselingStatus: NONE 전체 / ANSWER 답변완료 / NO_ANSWER 미답변 / TRANSFER 이관
async function fetchCallCenter(ctx) {
  const now = new Date();
  const base = {
    vendorId: ctx.creds.vendorId,
    inquiryStartAt: kstDate(new Date(now.getTime() - 6 * 86400000)),
    inquiryEndAt: kstDate(now),
    pageSize: 30,
  };
  const load = async (status) => {
    const rows = [];
    for (let pageNum = 1; pageNum <= 5; pageNum++) {
      const r = await api(ctx, 'GET', `${vendorPath('v4', ctx.creds.vendorId)}/callCenterInquiries`, { query: { ...base, partnerCounselingStatus: status, pageNum } });
      const list = Array.isArray(r?.data?.content) ? r.data.content : Array.isArray(r?.data) ? r.data : [];
      rows.push(...list);
      if (list.length < base.pageSize) break;
    }
    return rows;
  };
  const all = await load('NONE');
  // 답변완료 목록에 있는 문의만 답변된 것으로 (이관·미답변 등은 확인 필요로 남김)
  let answeredIds = null;
  if (all.length) {
    try {
      answeredIds = new Set((await load('ANSWER')).map((q) => str(q.inquiryId)));
    } catch {}
  }
  return all.filter((q) => str(q.inquiryId)).map((q) => {
    const id = str(q.inquiryId);
    const replies = [q.replies, q.answers, q.commentDtoList].find(Array.isArray) || [];
    // 답변 대상: 쿠팡 상담원이 판매자 답변을 요청한 글(requestAnswer) → 답변 API 의 parentAnswerId
    const request = [...replies].reverse().find((r) => r && (r.partnerTransferStatus === 'requestAnswer' || r.needAnswer === true) && r.answerId != null);
    const vendorReplies = replies.filter((r) => r && /vendor|seller|partner/i.test(str(r.answerType || r.authorType)));
    const last = vendorReplies.length ? vendorReplies[vendorReplies.length - 1] : null;
    const st = str(q.partnerCounselingStatus || q.csPartnerCounselingStatus || q.counselingStatus);
    const cat = str(q.receiptCategory || q.inquiryCategory || q.categoryName).replace(/\s*>\s*/g, ' > ');
    const orderId = q.orderId ?? (Array.isArray(q.orderIds) ? q.orderIds[0] : '');
    const note = request ? str(request.content) : '';
    return {
      key: `cc-${id}`,
      kind: 'customer',
      category: cat ? `고객센터 · ${cat}` : '고객센터',
      title: '',
      // 고객 문의 + 쿠팡 상담원이 판매자에게 남긴 요청
      content: [str(q.content || q.inquiryContent || q.question), note ? `[쿠팡 상담원] ${note}` : ''].filter(Boolean).join('\n\n'),
      productName: str(q.vendorItemName || q.itemName || q.productName || q.sellerProductName),
      productId: str(Array.isArray(q.vendorItemId) ? q.vendorItemId[0] : q.vendorItemId),
      orderNo: str(orderId),
      writer: str(q.buyerName || q.customerName || q.buyerEmail),
      askedAt: toIso(q.inquiryAt || q.receiptAt || q.createdAt || q.inquiryDate),
      answered: answeredIds ? answeredIds.has(id) : /^(ANSWER|ANSWERED|COMPLETE|DONE)$/i.test(st),
      answer: last ? str(last.content || last.answerContent || last.reply) : '',
      extra: { inquiryId: id, callCenter: true, parentAnswerId: request ? str(request.answerId) : '' },
    };
  });
}

// 답변할 수 없는 문의면 이유 (화면에 안내)
function answerCheck(creds, inquiry) {
  if (!str(creds?.wingId)) return '쿠팡은 답변하는 사람의 Wing 로그인 아이디가 필요해요. [스토어] → 쿠팡 [키 변경]에서 Wing 로그인 아이디만 넣고 저장하면 여기서 바로 답변할 수 있어요.';
  if (inquiry.extra?.callCenter && !inquiry.extra?.parentAnswerId) return '쿠팡 상담원이 답변을 요청한 문의가 아니라서 Wing에서 확인해주세요.';
  return null;
}

// 상품 문의: POST v4 …/onlineInquiries/{inquiryId}/replies {content, vendorId, replyBy}
// 고객센터 문의: POST v4 …/callCenterInquiries/{inquiryId}/replies {vendorId, inquiryId, content(2~1000자), replyBy, parentAnswerId}
async function answerInquiry(ctx, inquiry, text) {
  const reason = answerCheck(ctx.creds, inquiry);
  if (reason) throw new Error(reason);
  const e = inquiry.extra || {};
  if (!e.inquiryId) throw new Error('문의 번호가 없어 Wing에서 답변해주세요');
  const vendorId = ctx.creds.vendorId;
  const replyBy = str(ctx.creds.wingId);
  if (e.callCenter) {
    if (text.length < 2 || text.length > 1000) throw new Error('쿠팡 고객센터 문의 답변은 2~1,000자로 입력해주세요');
    await api(ctx, 'POST', `${vendorPath('v4', vendorId)}/callCenterInquiries/${encodeURIComponent(e.inquiryId)}/replies`, {
      body: { vendorId, inquiryId: BIG(e.inquiryId), content: text, replyBy, parentAnswerId: BIG(e.parentAnswerId) },
    });
  } else {
    await api(ctx, 'POST', `${vendorPath('v4', vendorId)}/onlineInquiries/${encodeURIComponent(e.inquiryId)}/replies`, {
      body: { content: text, vendorId, replyBy },
    });
  }
  return { ok: true };
}

module.exports = {
  ...meta,
  answerCheck,
  answerInquiry,
  approveClaim,

  async test(ctx) {
    const state = {};
    const today = kstDate(new Date());
    const from = kstDate(new Date(Date.now() - 86400000));
    await listSheets(ctx, state, 'ACCEPT', from, today);
    return { ok: true, message: '쿠팡 연결 성공 (발주서 조회 권한 확인)' };
  },

  async fetch(ctx) {
    if (ctx.backfillDays) return backfill(ctx);
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
    const groups = [...sheets.values()].map(normalizeSheet);
    // 반품·출고중지 접수 (실패해도 주문 수집은 정상, 마지막으로 확인한 요청 표시는 유지)
    let updates;
    try {
      updates = await collectReturns(ctx, state, runCount);
      delete state.returnsError;
    } catch (e) {
      if (e.network) throw e;
      const msg = `쿠팡 반품·출고중지 목록 조회 실패 (주문 수집은 정상): ${e.message}`;
      if (state.returnsError !== msg) ctx.log?.(msg);
      state.returnsError = msg;
      updates = new Map();
      for (const r of Object.values(state.openReceipts || {})) {
        for (const k of r.keys || []) updates.set(k, { claim: r.claim, label: r.claim === 'CANCEL' ? '출고중지요청' : '반품요청' });
      }
    }
    return { groups: applyReturns(groups, updates), state };
  },

  // 상품별 고객문의 + 고객센터 문의 (한쪽만 실패하면 나머지는 그대로 반영, 답변은 Wing 에서)
  async fetchInquiries(ctx) {
    const list = [];
    const warnings = [];
    for (const [label, fn] of [
      ['상품 문의', fetchOnline],
      ['고객센터 문의', fetchCallCenter],
    ]) {
      try {
        list.push(...(await fn(ctx)));
      } catch (e) {
        if (e.network) throw e;
        warnings.push(`${label} - ${e.message}`);
      }
    }
    if (warnings.length === 2) throw new Error(`쿠팡 문의 조회 실패: ${warnings.join(' / ')}`);
    return { list, warnings };
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
        // 업체직송(DIRECT)은 송장번호가 없으면 주문번호로 대신 등록
        invoiceNumber: String(trackingNo || '').trim() || (code === 'DIRECT' ? String(i.extra.orderId) : ''),
        splitShipping: false,
        preSplitShipped: false,
        estimatedShippingDate: '',
      }));
    const r = await api(ctx, 'POST', `${vendorPath('v4', ctx.creds.vendorId)}/orders/invoices`, {
      body: { vendorId: ctx.creds.vendorId, orderSheetInvoiceApplyDtos: dtos },
    });
    return resultForItems(items, r, '송장 등록 실패');
  },

  _internal: {
    receiptInfo,
    applyReturns,
    receiptKeys, sign, signedDate, buildQuery, normalizeSheet, mapState },
};
