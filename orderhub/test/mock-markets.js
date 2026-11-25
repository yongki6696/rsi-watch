'use strict';
// 테스트용 가짜 마켓 서버: 네이버 커머스API / 쿠팡 Wing / 11번가 / 텔레그램 / ntfy
// 실제 API 와 같은 방식으로 인증(서명)을 검증한다.
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { createEsmLotteonState, handleEsm, handleLotteon } = require('./mock-esm-lotteon');

const NAVER = { clientId: 'naverClient', secret: '$2a$04$abcdefghijklmnopqrstuu' };
const COUPANG = { vendorId: 'A00012345', accessKey: 'coupangAccess', secretKey: 'coupangSecret' };
const ELEVEN = { apiKey: 'elevenKey' };

const NAVER_COURIERS = new Set(['CJGLS', 'HYUNDAI', 'HANJIN', 'KGB', 'EPOST', 'KDEXP']);
const COUPANG_COURIERS = new Set(['CJGLS', 'HYUNDAI', 'HANJIN', 'KGB', 'EPOST', 'KDEXP', 'DIRECT']);
const ELEVEN_COURIERS = new Set(['00034', '00012', '00011', '00007', '00002']);

// 11번가 응답용 EUC-KR 바이트 (Python 으로 미리 인코딩)
const EUCKR = {
  '김십일': 'b1e8bdcac0cf',
  '무선 마우스': 'b9abbcb120b8b6bfecbdba',
  '서울특별시 마포구 월드컵로 1': 'bcadbfefc6afbab0bdc320b8b6c6f7b1b820bff9b5e5c4c5b7ce2031',
  '101동 202호': '313031b5bf20323032c8a3',
};

// 임의의 한글을 EUC-KR 바이트로 (11번가 응답 흉내용)
let EUC_TABLE = null;
function eucKr(text) {
  if (!EUC_TABLE) {
    EUC_TABLE = new Map();
    const dec = new TextDecoder('euc-kr');
    for (let a = 0x81; a <= 0xfe; a++) {
      for (let b = 0x41; b <= 0xfe; b++) {
        const ch = dec.decode(Uint8Array.of(a, b));
        if (ch.length === 1 && ch !== '\ufffd' && !EUC_TABLE.has(ch)) EUC_TABLE.set(ch, [a, b]);
      }
    }
  }
  const out = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else out.push(...(EUC_TABLE.get(ch) || [0x3f]));
  }
  return Buffer.from(out);
}

function kstIso(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600000);
  return k.toISOString().replace('Z', '+09:00');
}

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// 큰 숫자 ID 를 따옴표 없는 숫자로 내보내기 (실제 쿠팡처럼)
function jsonRawIds(obj) {
  return JSON.stringify(obj).replace(/"#(\d+)"/g, '$1');
}

function createState() {
  return {
    naver: { tokens: new Set(), orders: new Map(), changes: [], inquiries: [], qnas: [], failInquiries: false, calls: { confirm: [], dispatch: [], token: 0, answers: [], qnaAnswers: [], claimApprove: [] } },
    coupang: { sheets: new Map(), inquiries: [], callCenter: [], returns: [], calls: { ack: [], invoices: [], list: [], single: [], inquiries: [], callCenter: [], replies: [], returnLists: [], returnActions: [] }, rejectAuth: false },
    eleven: { orders: new Map(), cancelReq: [], canceled: [], qnas: [], calls: { pack: [], deliver: [], qna: [], answers: [] } },
    telegram: { messages: [] },
    ntfy: { messages: [] },
  };
}

// ---------------- 네이버 ----------------
function naverAddOrder(state, { productOrderId, orderId, packageNumber = null, name = '홍길동', product = '블루투스 이어폰', option = '화이트', qty = 1, amount = 39900, status = 'PAYED', place = 'NOT_YET', claimType = null, claimStatus = null, at = new Date() }) {
  const detail = {
    order: { orderId, orderDate: kstIso(at), paymentDate: kstIso(at), ordererName: name, ordererTel: '010-1111-2222' },
    productOrder: {
      productOrderId,
      packageNumber,
      productOrderStatus: status,
      placeOrderStatus: place,
      claimType,
      claimStatus,
      productName: product,
      productOption: option,
      quantity: qty,
      unitPrice: amount / qty,
      totalPaymentAmount: amount,
      deliveryFeeAmount: 0,
      shippingDueDate: kstIso(new Date(Date.now() + 2 * 86400000)),
      shippingMemo: '문 앞에 놓아주세요',
      shippingAddress: { name, tel1: '010-1111-2222', tel2: '', zipCode: '06236', baseAddress: '서울특별시 강남구 테헤란로 152', detailedAddress: '21층' },
    },
    delivery: {},
  };
  state.naver.orders.set(productOrderId, detail);
  naverChange(state, productOrderId, at);
  return detail;
}

let changeSeq = 0;
function naverChange(state, productOrderId, at = new Date()) {
  const d = state.naver.orders.get(productOrderId);
  state.naver.changes.push({
    seq: ++changeSeq,
    orderId: d.order.orderId,
    productOrderId,
    lastChangedType: 'PAYED',
    lastChangedDate: kstIso(at),
    productOrderStatus: d.productOrder.productOrderStatus,
  });
}

async function handleNaver(state, req, res, url) {
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const path = url.pathname.replace('/external', '');
  if (path === '/v1/oauth2/token' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const ts = Number(form.get('timestamp'));
    if (form.get('client_id') !== NAVER.clientId) return send(400, { code: 'BadRequest', message: 'invalid client_id' });
    if (!ts || Math.abs(Date.now() - ts) > 5 * 60000) return send(400, { code: 'BadRequest', message: 'timestamp expired' });
    const expected = Buffer.from(bcrypt.hashSync(`${NAVER.clientId}_${ts}`, NAVER.secret)).toString('base64');
    if (form.get('client_secret_sign') !== expected) return send(401, { code: 'Unauthorized', message: 'invalid client_secret_sign' });
    if (form.get('grant_type') !== 'client_credentials' || form.get('type') !== 'SELF') return send(400, { code: 'BadRequest', message: 'bad grant/type' });
    const token = `tok-${crypto.randomBytes(6).toString('hex')}`;
    state.naver.tokens.add(token);
    state.naver.calls.token++;
    return send(200, { access_token: token, expires_in: 10800, token_type: 'Bearer' });
  }
  const auth = req.headers.authorization || '';
  if (!state.naver.tokens.has(auth.replace('Bearer ', ''))) return send(401, { code: 'GW.AUTHN', message: 'invalid token' });

  if (path === '/v1/pay-order/seller/product-orders/last-changed-statuses' && req.method === 'GET') {
    const from = new Date(url.searchParams.get('lastChangedFrom'));
    const to = url.searchParams.get('lastChangedTo') ? new Date(url.searchParams.get('lastChangedTo')) : new Date(from.getTime() + 86400000);
    if (isNaN(from) || isNaN(to)) return send(400, { code: '4000', message: 'bad date' });
    if (to - from > 24 * 3600000) return send(400, { code: '104139', message: '조회 가능한 날짜 범위를 초과' });
    if (!url.searchParams.get('moreSequence')) (state.naver.calls.windows ||= []).push({ from: from.toISOString(), to: to.toISOString() });
    // 실제 API 처럼: moreSequence 이상인 항목만, 2건씩 끊어서 more 페이지 동작 검증
    const minSeq = Number(url.searchParams.get('moreSequence') || 0);
    const all = state.naver.changes.filter((c) => {
      const t = new Date(c.lastChangedDate);
      return t >= from && t <= to && c.seq >= minSeq;
    });
    const page = all.slice(0, 2).map(({ seq, ...rest }) => rest);
    const data = { lastChangeStatuses: page, count: page.length };
    if (all.length > 2) data.more = { moreFrom: all[2].lastChangedDate, moreSequence: String(all[2].seq) };
    return send(200, { timestamp: kstIso(), traceId: 't', data });
  }
  if (path === '/v1/pay-order/seller/product-orders/query' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.productOrderIds) || body.productOrderIds.length > 300) return send(400, { code: '4000', message: 'bad ids' });
    const data = body.productOrderIds.map((id) => state.naver.orders.get(id)).filter(Boolean);
    return send(200, { timestamp: kstIso(), traceId: 't', data });
  }
  if (path === '/v1/pay-order/seller/product-orders/confirm' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    state.naver.calls.confirm.push(body);
    const ok = [];
    for (const id of body.productOrderIds) {
      const d = state.naver.orders.get(id);
      if (d) {
        d.productOrder.placeOrderStatus = 'OK';
        ok.push({ productOrderId: id, isReceiverAddressChanged: false });
      }
    }
    return send(200, { timestamp: kstIso(), traceId: 't', data: { successProductOrderInfos: ok, failProductOrderInfos: [] } });
  }
  // 취소 요청 승인 / 반품 승인: 취소는 취소요청 상태에서, 반품은 수거완료 뒤에만
  let cm;
  if ((cm = path.match(/^\/v1\/pay-order\/seller\/product-orders\/([^/]+)\/claim\/(cancel|return)\/approve$/)) && req.method === 'POST') {
    const raw = await readBody(req);
    state.naver.calls.claimApprove.push({ productOrderId: cm[1], kind: cm[2], raw });
    const d = state.naver.orders.get(cm[1]);
    if (!d) return send(404, { code: '104105', message: '상품 주문을 찾을 수 없음' });
    const p = d.productOrder;
    if (cm[2] === 'cancel') {
      if (!['CANCEL_REQUEST', 'CANCELING'].includes(p.claimStatus)) return send(400, { code: '104403', message: '취소 요청 상태가 아닙니다' });
      p.productOrderStatus = 'CANCELED';
      p.claimStatus = 'CANCEL_DONE';
    } else {
      if (p.claimStatus !== 'COLLECT_DONE') return send(400, { code: '104404', message: '수거 완료된 반품만 승인할 수 있습니다' });
      p.productOrderStatus = 'RETURNED';
      p.claimStatus = 'RETURN_DONE';
    }
    naverChange(state, cm[1]);
    return send(200, { timestamp: kstIso(), traceId: 't', data: { successProductOrderIds: [cm[1]], failProductOrderInfos: [] } });
  }
  if (path === '/v1/pay-order/seller/product-orders/dispatch' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    state.naver.calls.dispatch.push(body);
    const ok = [];
    const fail = [];
    for (const x of body.dispatchProductOrders || []) {
      const d = state.naver.orders.get(x.productOrderId);
      if (!d) fail.push({ productOrderId: x.productOrderId, code: '100001', message: '상품 주문을 찾을 수 없음' });
      else if (x.deliveryMethod === 'DIRECT_DELIVERY') {
        // 직접전달: 택배사·송장 없이
        if (x.deliveryCompanyCode || x.trackingNumber) fail.push({ productOrderId: x.productOrderId, code: '4000', message: '직접전달에는 택배사/송장을 넣지 않음' });
        else {
          d.productOrder.productOrderStatus = 'DELIVERING';
          d.delivery = { deliveryMethod: 'DIRECT_DELIVERY' };
          ok.push(x.productOrderId);
        }
      } else if (x.deliveryMethod !== 'DELIVERY' || !NAVER_COURIERS.has(x.deliveryCompanyCode)) fail.push({ productOrderId: x.productOrderId, code: '104119', message: '택배사 코드 확인' });
      else if (!/^\d{8,}$/.test(x.trackingNumber) || x.trackingNumber.startsWith('000')) fail.push({ productOrderId: x.productOrderId, code: '104122', message: '배송 송장 오류(비유효 송장)' });
      else if (!/\+09:00$/.test(x.dispatchDate)) fail.push({ productOrderId: x.productOrderId, code: '4000', message: 'dispatchDate' });
      else {
        d.productOrder.productOrderStatus = 'DELIVERING';
        d.delivery = { deliveryCompany: x.deliveryCompanyCode, trackingNumber: x.trackingNumber };
        ok.push(x.productOrderId);
        naverChange(state, x.productOrderId);
      }
    }
    return send(200, { timestamp: kstIso(), traceId: 't', data: { successProductOrderIds: ok, failProductOrderInfos: fail } });
  }
  if (path === '/v1/pay-user/inquiries' && req.method === 'GET') {
    if (state.naver.failInquiries) return send(403, { code: 'GW.AUTHZ', message: '문의 API 권한 없음' });
    const s = url.searchParams;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.get('startSearchDate') || '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.get('endSearchDate') || '')) return send(400, { code: '4001', message: 'date format' });
    const size = Number(s.get('size'));
    if (size < 10 || size > 200) return send(400, { code: '4006', message: 'size' });
    return send(200, { content: state.naver.inquiries, totalElements: state.naver.inquiries.length, last: true, first: true });
  }
  if (path === '/v1/contents/qnas' && req.method === 'GET') {
    const s = url.searchParams;
    if (isNaN(new Date(s.get('fromDate'))) || isNaN(new Date(s.get('toDate'))) || Number(s.get('size')) > 100) return send(400, { code: 'BAD_REQUEST', message: 'bad params' });
    return send(200, { contents: state.naver.qnas, page: 1, size: 100, totalElements: state.naver.qnas.length, totalPages: 1, first: true, last: true });
  }
  let am;
  if ((am = path.match(/^\/v1\/pay-merchant\/inquiries\/(\d+)\/answer$/)) && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const q = state.naver.inquiries.find((x) => String(x.inquiryNo) === am[1]);
    if (!q || !body.answerComment) return send(400, { code: '4001', message: 'bad answer' });
    q.answered = true;
    q.answerContent = body.answerComment;
    state.naver.calls.answers.push({ inquiryNo: am[1], ...body });
    return send(200, { code: 'SUCCESS', data: { inquiryNo: Number(am[1]), inquiryCommentNo: 1 } });
  }
  if ((am = path.match(/^\/v1\/contents\/qnas\/(\d+)$/)) && req.method === 'PUT') {
    const body = JSON.parse(await readBody(req));
    const q = state.naver.qnas.find((x) => String(x.questionId) === am[1]);
    if (!q || !body.commentContent) return send(400, { code: 'BAD_REQUEST', message: 'bad answer' });
    q.answered = true;
    q.answer = body.commentContent;
    state.naver.calls.qnaAnswers.push({ questionId: am[1], ...body });
    res.writeHead(200);
    return res.end();
  }
  return send(404, { code: 'NotFound', message: path });
}

// ---------------- 쿠팡 ----------------
function coupangAddSheet(state, { shipmentBoxId, orderId, vendorItemId, name = '이쿠팡', product = '스테인리스 텀블러', option = '실버', qty = 1, price = 18900, status = 'ACCEPT' }) {
  const sheet = {
    shipmentBoxId: `#${shipmentBoxId}`,
    orderId: `#${orderId}`,
    orderedAt: '2026-11-22T14:00:00',
    paidAt: '2026-11-22T14:00:30',
    status,
    orderer: { name, email: 'a***@x.com', safeNumber: '0504-1234-5678' },
    receiver: { name, safeNumber: '0504-1234-5678', addr1: '경기도 성남시 분당구 판교역로 166', addr2: 'A동 3층', postCode: '13529' },
    parcelPrintMessage: '부재 시 경비실',
    shippingPrice: { currencyCode: 'KRW', units: 0, nanos: 0 },
    remotePrice: 0,
    orderItems: [
      {
        vendorItemId: `#${vendorItemId}`,
        vendorItemName: `${product}, ${option}`,
        sellerProductName: product,
        sellerProductItemName: option,
        shippingCount: qty,
        cancelCount: 0,
        holdCountForCancel: 0,
        salesPrice: { currencyCode: 'KRW', units: price, nanos: 0 },
        orderPrice: { currencyCode: 'KRW', units: price * qty, nanos: 0 },
        externalVendorSkuCode: 'TMB-01',
        estimatedShippingDate: '2026-11-24',
      },
    ],
    overseaShippingInfoDto: { personalCustomsClearanceCode: '' },
    deliveryCompanyName: '',
    invoiceNumber: '',
  };
  state.coupang.sheets.set(String(shipmentBoxId), sheet);
  return sheet;
}

function verifyCoupang(state, req, url) {
  const m = String(req.headers.authorization || '').match(/^CEA algorithm=HmacSHA256, access-key=([^,]+), signed-date=(\d{6}T\d{6}Z), signature=([0-9a-f]{64})$/);
  if (!m) return 'malformed authorization';
  if (m[1] !== COUPANG.accessKey) return 'unknown access key';
  const sd = m[2];
  const t = Date.UTC(2000 + Number(sd.slice(0, 2)), Number(sd.slice(2, 4)) - 1, Number(sd.slice(4, 6)), Number(sd.slice(7, 9)), Number(sd.slice(9, 11)), Number(sd.slice(11, 13)));
  if (Math.abs(Date.now() - t) > 5 * 60000) return 'signed-date expired';
  const rawQuery = url.search ? url.search.slice(1) : '';
  const expected = crypto.createHmac('sha256', COUPANG.secretKey).update(sd + req.method + url.pathname + rawQuery).digest('hex');
  if (state.coupang.rejectAuth || expected !== m[3]) return 'Invalid signature';
  return null;
}

async function handleCoupang(state, req, res, url) {
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(typeof obj === 'string' ? obj : jsonRawIds(obj));
  };
  const authErr = verifyCoupang(state, req, url);
  if (authErr) return send(401, { code: 'ERROR', message: authErr });
  let m;
  if ((m = url.pathname.match(/^\/v2\/providers\/openapi\/apis\/api\/(v4|v5)\/vendors\/([^/]+)\/ordersheets$/)) && req.method === 'GET') {
    if (m[2] !== COUPANG.vendorId) return send(403, { code: 'ERROR', message: 'vendor mismatch' });
    const from = url.searchParams.get('createdAtFrom');
    const to = url.searchParams.get('createdAtTo');
    if (!/^\d{4}-\d{2}-\d{2}\+09:00$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}\+09:00$/.test(to || '')) return send(400, { code: 'ERROR', message: 'invalid createdAt format' });
    const status = url.searchParams.get('status');
    state.coupang.calls.list.push({ version: m[1], status, from: from.slice(0, 10), to: to.slice(0, 10), page: url.searchParams.get('nextToken') || '' });
    const all = [...state.coupang.sheets.values()].filter((s) => s.status === status);
    const per = Number(url.searchParams.get('maxPerPage') || 50);
    const start = Number(url.searchParams.get('nextToken') || 0);
    const page = all.slice(start, start + Math.min(per, 1)); // 1건씩 끊어서 nextToken 동작 검증
    return send(200, { code: 200, message: 'OK', data: page, nextToken: start + 1 < all.length ? String(start + 1) : '' });
  }
  if ((m = url.pathname.match(/^\/v2\/providers\/openapi\/apis\/api\/(v4|v5)\/vendors\/([^/]+)\/ordersheets\/(\d+)$/)) && req.method === 'GET') {
    state.coupang.calls.single.push(m[3]);
    const s = state.coupang.sheets.get(m[3]);
    if (!s) return send(404, { code: 'ERROR', message: 'not found' });
    return send(200, { code: 200, message: 'OK', data: s });
  }
  if ((m = url.pathname.match(/^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/ordersheets\/acknowledgement$/)) && req.method === 'PUT') {
    const raw = await readBody(req);
    state.coupang.calls.ack.push(raw);
    const ids = (raw.match(/"shipmentBoxIds":\[([0-9,]+)\]/) || [])[1];
    if (!ids) return send(400, { code: 'ERROR', message: 'shipmentBoxIds must be numbers' });
    const list = ids.split(',').map((id) => {
      const s = state.coupang.sheets.get(id);
      if (s && s.status === 'ACCEPT') s.status = 'INSTRUCT';
      return { shipmentBoxId: `#${id}`, succeed: !!s, resultCode: s ? 'OK' : 'NOT_FOUND', retryRequired: false, resultMessage: s ? '' : '없는 발주서' };
    });
    return send(200, { code: 200, message: 'OK', data: { responseCode: list.every((x) => x.succeed) ? 0 : 1, responseMessage: 'SUCCESS', responseList: list } });
  }
  if ((m = url.pathname.match(/^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/orders\/invoices$/)) && req.method === 'POST') {
    const raw = await readBody(req);
    state.coupang.calls.invoices.push(raw);
    const dtos = [...raw.matchAll(/\{"shipmentBoxId":(\d+),"orderId":(\d+),"vendorItemId":(\d+),"deliveryCompanyCode":"([A-Z]+)","invoiceNumber":"([^"]+)"/g)];
    if (!dtos.length) return send(400, { code: 'ERROR', message: 'bad orderSheetInvoiceApplyDtos' });
    const list = dtos.map(([, boxId, , , code, inv]) => {
      const s = state.coupang.sheets.get(boxId);
      let ok = !!s && s.status === 'INSTRUCT' && COUPANG_COURIERS.has(code);
      if (ok) {
        s.status = 'DEPARTURE';
        s.invoiceNumber = inv;
      }
      return { shipmentBoxId: `#${boxId}`, succeed: ok, resultCode: ok ? 'OK' : 'FAIL', retryRequired: false, resultMessage: ok ? '' : `상품준비중 상태가 아님/택배사 오류 (${s?.status})` };
    });
    return send(200, { code: 200, message: 'OK', data: { responseCode: list.every((x) => x.succeed) ? 0 : 99, responseMessage: 'done', responseList: list } });
  }
  if ((m = url.pathname.match(/^\/v2\/providers\/openapi\/apis\/api\/v5\/vendors\/([^/]+)\/onlineInquiries$/)) && req.method === 'GET') {
    const s = url.searchParams;
    state.coupang.calls.inquiries.push(Object.fromEntries(s.entries()));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.get('inquiryStartAt') || '') || s.get('vendorId') !== COUPANG.vendorId) return send(400, { code: 'ERROR', message: 'bad inquiry params' });
    return send(200, { code: 200, message: 'OK', data: { content: state.coupang.inquiries, pagination: { currentPage: 1, totalPages: 1 } } });
  }
  // 반품/취소 요청 목록 (v6): status RU·UC·PR·CC, 날짜 yyyy-MM-dd (31일 이내), 50건씩
  if ((m = url.pathname.match(/^\/v2\/providers\/openapi\/apis\/api\/v6\/vendors\/([^/]+)\/returnRequests$/)) && req.method === 'GET') {
    const s = url.searchParams;
    state.coupang.calls.returnLists.push(Object.fromEntries(s.entries()));
    const STATUS = { RU: ['RELEASE_STOP_UNCHECKED'], UC: ['RETURNS_UNCHECKED', 'VENDOR_WAREHOUSE_CONFIRM'], PR: ['REQUEST_COUPANG_CHECK'], CC: ['RETURNS_COMPLETED'] };
    const from = s.get('createdAtFrom') || '';
    const to = s.get('createdAtTo') || '';
    if (m[1] !== COUPANG.vendorId || !STATUS[s.get('status')] || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return send(400, { code: 'ERROR', message: 'bad returnRequests params' });
    if (Date.parse(to) - Date.parse(from) > 30 * 86400000) return send(400, { code: 'ERROR', message: '조회 기간은 31일 이내' });
    if (Number(s.get('maxPerPage') || 50) > 50) return send(400, { code: 'ERROR', message: 'maxPerPage <= 50' });
    const list = state.coupang.returns.filter((r) => STATUS[s.get('status')].includes(r.receiptStatus));
    return send(200, { code: 200, message: 'OK', data: list, nextToken: '' });
  }
  // 출고중지완료 / 입고확인 / 반품승인: receiptId 는 숫자, cancelCount 는 접수 전체 수량
  if ((m = url.pathname.match(/^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/returnRequests\/(\d+)\/(stoppedShipment|receiveConfirmation|approval)$/)) && req.method === 'PATCH') {
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    state.coupang.calls.returnActions.push({ action: m[3], receiptId: m[2], raw });
    const rc = state.coupang.returns.find((r) => r.receiptId === `#${m[2]}`);
    const fail = (msg) => send(200, { code: 200, message: 'OK', data: { resultCode: 'FAIL', resultMessage: msg } });
    if (!rc || body.vendorId !== COUPANG.vendorId || !new RegExp(`"receiptId":${m[2]}[,}]`).test(raw)) return send(400, { code: 'ERROR', message: '필수 값 오류 (receiptId 는 숫자)' });
    if (m[3] === 'stoppedShipment') {
      if (rc.receiptStatus !== 'RELEASE_STOP_UNCHECKED') return fail('출고중지요청 상태가 아닙니다');
      if (body.cancelCount !== rc.cancelCountSum) return fail('cancelCount 는 접수 전체 수량이어야 합니다');
      rc.receiptStatus = 'RELEASE_STOP_DONE'; // 목록에서 빠짐
      for (const ri of rc.returnItems) {
        const sheet = state.coupang.sheets.get(ri.shipmentBoxId.replace('#', ''));
        const it = sheet?.orderItems.find((x) => x.vendorItemId === ri.vendorItemId);
        if (it) {
          it.cancelCount = it.shippingCount;
          it.holdCountForCancel = 0;
        }
      }
    } else if (m[3] === 'receiveConfirmation') {
      if (rc.receiptStatus !== 'RETURNS_UNCHECKED') return fail('반품접수 상태가 아닙니다');
      rc.receiptStatus = 'VENDOR_WAREHOUSE_CONFIRM';
    } else {
      if (rc.receiptStatus !== 'VENDOR_WAREHOUSE_CONFIRM') return fail('입고완료 상태에서만 반품 승인할 수 있습니다');
      if (body.cancelCount !== rc.cancelCountSum) return fail('cancelCount 오류');
      rc.receiptStatus = 'RETURNS_COMPLETED';
    }
    return send(200, { code: 200, message: 'OK', data: { resultCode: 'SUCCESS', resultMessage: '' } });
  }
  // 상품 문의 답변: 본문 content·vendorId·replyBy(Wing 아이디) 모두 필수, 두 번 답하면 오류
  if ((m = url.pathname.match(/^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/onlineInquiries\/(\d+)\/replies$/)) && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    state.coupang.calls.replies.push({ kind: 'online', id: m[2], body });
    if (m[1] !== COUPANG.vendorId || body.vendorId !== COUPANG.vendorId || !body.replyBy || !body.content) return send(400, { code: 'ERROR', message: 'content, vendorId, replyBy 는 필수입니다' });
    const q = state.coupang.inquiries.find((x) => String(x.inquiryId) === m[2]);
    if (!q) return send(400, { code: 'ERROR', message: '문의를 찾을 수 없습니다' });
    if ((q.commentDtoList || []).length) return send(400, { code: 'ERROR', message: '동일한 답변이 존재합니다' });
    q.commentDtoList = [{ inquiryCommentId: 1, inquiryId: q.inquiryId, content: body.content, inquiryCommentAt: kstIso() }];
    return send(200, { code: 200, message: 'OK', data: null });
  }
  // 고객센터 문의 답변: parentAnswerId 는 상담원의 답변요청(requestAnswer) 글 번호, 내용 2~1000자
  if ((m = url.pathname.match(/^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/callCenterInquiries\/(\d+)\/replies$/)) && req.method === 'POST') {
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    state.coupang.calls.replies.push({ kind: 'callCenter', id: m[2], body, raw });
    const q = state.coupang.callCenter.find((x) => String(x.inquiryId) === m[2]);
    if (!q || String(body.inquiryId) !== m[2] || body.vendorId !== COUPANG.vendorId || !body.replyBy) return send(400, { code: 'ERROR', message: '필수 값 누락' });
    const target = (q.replies || []).find((r) => r.partnerTransferStatus === 'requestAnswer');
    if (!target || typeof body.parentAnswerId !== 'number' || body.parentAnswerId !== target.answerId) return send(400, { code: 'ERROR', message: 'parentAnswerId 가 올바르지 않습니다' });
    if (!(body.content?.length >= 2 && body.content.length <= 1000)) return send(400, { code: 'ERROR', message: '답변은 2~1000자' });
    q.replies.push({ answerId: target.answerId + 1, parentAnswerId: target.answerId, answerType: 'vendor', needAnswer: false, content: body.content, replyAt: kstIso() });
    q._status = 'ANSWER';
    return send(200, { code: 200, message: 'OK', data: null });
  }
  // 고객센터 문의: partnerCounselingStatus 로 걸러서 (응답에는 상태 필드를 넣지 않음 → 목록 비교로 답변 여부 판단하는지 확인)
  if ((m = url.pathname.match(/^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/callCenterInquiries$/)) && req.method === 'GET') {
    const s = url.searchParams;
    state.coupang.calls.callCenter.push(Object.fromEntries(s.entries()));
    const st = s.get('partnerCounselingStatus');
    if (!['NONE', 'ANSWER', 'NO_ANSWER', 'TRANSFER'].includes(st) || s.get('vendorId') !== COUPANG.vendorId) return send(400, { code: 'ERROR', message: 'bad call center params' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.get('inquiryStartAt') || '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.get('inquiryEndAt') || '')) return send(400, { code: 'ERROR', message: 'bad date' });
    const size = Number(s.get('pageSize')) || 10;
    const page = Number(s.get('pageNum')) || 1;
    const list = state.coupang.callCenter.filter((q) => st === 'NONE' || q._status === st).map(({ _status, ...q }) => q);
    return send(200, { code: 200, message: 'OK', data: { content: list.slice((page - 1) * size, page * size), pagination: { currentPage: page, totalPages: Math.ceil(list.length / size) || 1 } } });
  }
  return send(404, { code: 'ERROR', message: `no route ${req.method} ${url.pathname}` });
}

// ---------------- 11번가 ----------------
function elevenAddOrder(state, { ordNo, ordPrdSeq = '1', dlvNo, state: st = 'NEW', qty = 1, amount = 25000 }) {
  state.eleven.orders.set(`${ordNo}-${ordPrdSeq}`, { ordNo, ordPrdSeq, dlvNo, st, qty, amount, addPrdYn: 'N', addPrdNo: '' });
}

function elevenXml(orders, { minimal = false, noDlvNo = false } = {}) {
  const parts = [Buffer.from('<?xml version="1.0" encoding="euc-kr" standalone="yes"?><ns2:orders xmlns:ns2="http://skt.tmall.business.openapi.spring.service.client.domain/">', 'latin1')];
  if (!orders.length) parts.push(Buffer.from('<ns2:result_code>0</ns2:result_code><ns2:result_text>no data</ns2:result_text>', 'latin1'));
  for (const o of orders) {
    const field = (k, v) => Buffer.concat([Buffer.from(`<${k}>`), EUCKR[v] ? Buffer.from(EUCKR[v], 'hex') : Buffer.from(String(v)), Buffer.from(`</${k}>`)]);
    parts.push(Buffer.from('<ns2:order>'));
    if (minimal) {
      // 배송중 목록: 주문번호·순번·송장만 (상품·배송번호 없음)
      parts.push(field('ordNo', o.ordNo), field('ordPrdSeq', o.ordPrdSeq), field('invcNo', o.invcNo || '1234567890'), Buffer.from('</ns2:order>'));
      continue;
    }
    parts.push(
      field('ordNo', o.ordNo),
      field('ordPrdSeq', o.ordPrdSeq),
      noDlvNo ? Buffer.alloc(0) : field('dlvNo', o.dlvNo),
      field('prdNm', '무선 마우스'),
      field('slctPrdOptNm', 'Black'),
      field('ordQty', o.qty),
      field('selPrc', o.amount / o.qty),
      field('ordPayAmt', o.amount),
      field('ordNm', '김십일'),
      field('ordPrtblTel', '010-3333-4444'),
      field('rcvrNm', '김십일'),
      field('rcvrPrtblNo', '010-3333-4444'),
      field('rcvrMailNo', '03932'),
      field('rcvrBaseAddr', '서울특별시 마포구 월드컵로 1'),
      field('rcvrDtlsAddr', '101동 202호'),
      field('ordDt', '2026-11-22 13:10:00'),
      field('ordStlEndDt', '2026-11-22 13:11:00'),
      field('addPrdYn', o.addPrdYn),
      field('addPrdNo', o.addPrdNo || '')
    );
    parts.push(Buffer.from('</ns2:order>'));
  }
  parts.push(Buffer.from('</ns2:orders>'));
  return Buffer.concat(parts);
}

function handleEleven(state, req, res, url) {
  // 등록되지 않은 IP처럼: 응답 없이 연결을 끊음
  if (state.eleven.reset) return req.socket.destroy();
  const sendXml = (status, buf) => {
    res.writeHead(status, { 'Content-Type': 'text/xml' }); // charset 없음 → XML 선언(euc-kr)으로 판단해야 함
    res.end(buf);
  };
  const result = (code, text) => sendXml(200, Buffer.from(`<?xml version="1.0" encoding="euc-kr"?><ResultOrder><result_code>${code}</result_code><result_text>${text}</result_text></ResultOrder>`, 'latin1'));
  if (req.headers.openapikey !== ELEVEN.apiKey) return sendXml(200, Buffer.from('<ResultOrder><result_code>-1</result_code><result_text>invalid key</result_text></ResultOrder>'));
  const p = url.pathname.replace('/rest', '').split('/').filter(Boolean);
  const isRange = (a, b) => /^\d{12}$/.test(a) && /^\d{12}$/.test(b);
  const orders = [...state.eleven.orders.values()];
  // 상태별 목록: 조회기간 최대 7일
  const LIST = { complete: 'NEW', packaging: 'CONFIRMED', shipping: 'SHIPPED', dlvcompleted: 'DELIVERED', completed: 'DECIDED' };
  if (p[0] === 'ordservices' && LIST[p[1]] && p.length === 4) {
    if (!isRange(p[2], p[3])) return result('-1', 'bad range');
    const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
    if (t(p[3]) - t(p[2]) > 7 * 86400000) return result('-1', '조회기간은 최대 7일입니다');
    (state.eleven.calls.lists ||= []).push({ name: p[1], start: p[2], end: p[3] });
    return sendXml(200, elevenXml(orders.filter((o) => o.st === LIST[p[1]]), { minimal: p[1] === 'shipping', noDlvNo: p[1] === 'completed' }));
  }
  if (p[0] === 'claimservice' && p[1] === 'cancelorders') return sendXml(200, elevenXml(orders.filter((o) => state.eleven.cancelReq.includes(`${o.ordNo}-${o.ordPrdSeq}`))));
  if (p[0] === 'claimservice' && p[1] === 'canceledorders') return sendXml(200, elevenXml(orders.filter((o) => o.st === 'CANCELED')));
  if (p[0] === 'ordservices' && p[1] === 'reqpackaging' && p.length === 7) {
    const [, , ordNo, seq, addYn, addNo, dlvNo] = p;
    state.eleven.calls.pack.push({ ordNo, seq, addYn, addNo, dlvNo });
    const o = state.eleven.orders.get(`${ordNo}-${seq}`);
    if (!o || o.dlvNo !== dlvNo || addNo !== 'null') return result('-1', 'bad order');
    o.st = 'CONFIRMED';
    return result('0', 'ok');
  }
  if (p[0] === 'ordservices' && p[1] === 'reqdelivery' && p.length === 7) {
    const [, , sendDt, mthd, etprs, invc, dlvNo] = p;
    state.eleven.calls.deliver.push({ sendDt, mthd, etprs, invc, dlvNo });
    if (!/^\d{12}$/.test(sendDt) || mthd !== '01' || !ELEVEN_COURIERS.has(etprs)) return result('-1', 'bad param');
    const targets = orders.filter((o) => o.dlvNo === dlvNo && o.st === 'CONFIRMED');
    if (!targets.length) return result('-1', 'not packaging');
    targets.forEach((o) => (o.st = 'SHIPPED'));
    return result('0', 'ok');
  }
  // 상품 Q&A 답변: PUT, EUC-KR XML <ProductQna><answerCont>…</answerCont></ProductQna> → <ClientMessage> resultCode 200
  if (p[0] === 'prodqnaservices' && p[1] === 'prodqnaanswer' && p.length === 4 && req.method === 'PUT') {
    return readRaw(req).then((buf) => {
      const xml = new TextDecoder('euc-kr').decode(buf);
      const reply = (code, msg) => sendXml(200, Buffer.concat([Buffer.from(`<?xml version="1.0" encoding="euc-kr"?><ClientMessage><resultCode>${code}</resultCode><message>`), eucKr(msg), Buffer.from('</message></ClientMessage>')]));
      const m2 = xml.match(/<ProductQna>\s*<answerCont>([\s\S]*?)<\/answerCont>\s*<\/ProductQna>/);
      if (!/xml/.test(req.headers['content-type'] || '') || !m2 || !/encoding="euc-kr"/i.test(xml)) return reply(500, '요청 형식 오류');
      const text = m2[1]
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      const q = state.eleven.qnas.find((x) => x.brdInfoNo === p[2]);
      state.eleven.calls.answers.push({ brdInfoNo: p[2], prdNo: p[3], text, bytes: buf });
      if (!q || q.prdNo !== p[3]) return reply(500, '상품번호가 일치하지 않습니다');
      q.answerYn = 'Y';
      q.answerCont = text;
      return reply(200, '정상 처리되었습니다');
    });
  }
  // 상품 Q&A: YYYYMMDD 기간(최대 7일) + 답변상태 00/01/02, 없으면 '조회된 데이터가 없습니다' 결과
  if (p[0] === 'prodqnaservices' && p[1] === 'prodqnalist' && p.length === 5) {
    const [, , s, e, st] = p;
    if (!/^\d{8}$/.test(s) || !/^\d{8}$/.test(e) || !['00', '01', '02'].includes(st)) return result('-1', 'bad params');
    const d = (x) => Date.UTC(+x.slice(0, 4), +x.slice(4, 6) - 1, +x.slice(6, 8));
    if (d(e) - d(s) > 6 * 86400000) return result('-1', 'max 7 days');
    state.eleven.calls.qna.push({ s, e, st });
    const day = (q) => q.createDt.slice(0, 10).replace(/-/g, '');
    const list = state.eleven.qnas.filter((q) => day(q) >= s && day(q) <= e && (st === '00' || (st === '01') === (q.answerYn === 'Y')));
    if (!list.length) {
      return sendXml(200, Buffer.concat([Buffer.from('<?xml version="1.0" encoding="euc-kr"?><ns2:productQnas xmlns:ns2="http://skt.tmall.business.openapi.spring.service.client.domain/"><ns2:result_code>-1</ns2:result_code><ns2:result_text>'), eucKr('조회된 데이터가 없습니다.'), Buffer.from('</ns2:result_text></ns2:productQnas>')]));
    }
    const parts = [Buffer.from('<?xml version="1.0" encoding="euc-kr" standalone="yes"?><ns2:productQnas xmlns:ns2="http://skt.tmall.business.openapi.spring.service.client.domain/">')];
    for (const q of list) {
      parts.push(Buffer.from('<ns2:productQna>'));
      for (const [k, v] of Object.entries(q)) parts.push(Buffer.from(`<${k}>`), k === 'brdInfoCont' ? Buffer.concat([Buffer.from('<![CDATA['), eucKr(v), Buffer.from(']]>')]) : eucKr(v), Buffer.from(`</${k}>`));
      parts.push(Buffer.from('</ns2:productQna>'));
    }
    parts.push(Buffer.from('</ns2:productQnas>'));
    return sendXml(200, Buffer.concat(parts));
  }
  return result('-1', `no route ${url.pathname}`);
}

// ---------------- 텔레그램 / ntfy ----------------
async function handleTelegram(state, req, res, url) {
  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const m = url.pathname.match(/^\/tg\/bot([^/]+)\/(\w+)$/);
  if (!m || m[1] !== 'TGTOKEN') return send({ ok: false, description: 'Unauthorized' });
  const body = JSON.parse((await readBody(req)) || '{}');
  if (m[2] === 'sendMessage') {
    state.telegram.messages.push(body);
    return send({ ok: true, result: { message_id: state.telegram.messages.length } });
  }
  if (m[2] === 'getUpdates') return send({ ok: true, result: [{ update_id: 1, message: { chat: { id: 12345, first_name: '셀러' }, text: '안녕' } }] });
  return send({ ok: false, description: 'unknown method' });
}

async function handleNtfy(state, req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  state.ntfy.messages.push(body);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'x', topic: body.topic }));
}

function startMock() {
  const state = { ...createState(), ...createEsmLotteonState() };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/shipping/') || url.pathname.startsWith('/item/')) return await handleEsm(state, req, res, url);
      if (url.pathname.startsWith('/v1/openapi/')) return await handleLotteon(state, req, res, url);
      if (url.pathname.startsWith('/external/')) return await handleNaver(state, req, res, url);
      if (url.pathname.startsWith('/v2/providers/')) return await handleCoupang(state, req, res, url);
      if (url.pathname.startsWith('/rest/')) return handleEleven(state, req, res, url);
      if (url.pathname.startsWith('/tg/')) return await handleTelegram(state, req, res, url);
      if (url.pathname.startsWith('/ntfy')) return await handleNtfy(state, req, res);
      res.writeHead(404);
      res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'ERROR', message: e.message }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startMock, naverAddOrder, naverChange, coupangAddSheet, elevenAddOrder, NAVER, COUPANG, ELEVEN };
