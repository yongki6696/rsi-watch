'use strict';
// 테스트용 가짜 ESM(G마켓·옥션) / 롯데ON 서버 - 인증(JWT 서명, Bearer 키)을 실제처럼 검증
const crypto = require('node:crypto');

const ESM = { masterId: 'master01', secretKey: 'esm-secret', gmarketId: 'gseller', auctionId: 'aseller' };
const LOTTEON = { apiKey: 'lotteonKey' };
const ESM_COURIERS = new Set([10001, 10003, 10005, 10006, 10007, 10008, 10013]);
const LOTTEON_COURIERS = new Set(['0001', '0002', '0004', '0005', '0006']);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function kstStamp(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function createEsmLotteonState() {
  return {
    esm: { orders: new Map(), calls: { list: [], check: [], ship: [] }, minIntervalMs: 0, lastCall: new Map(), rateLimited: 0 },
    lotteon: { items: new Map(), calls: { orders: 0, progress: 0, inform: [] } },
  };
}

// ---------- ESM ----------
// site: 'G' | 'A', status: 1 결제완료 / 2 배송준비중 / 3 배송중
function esmAddOrder(state, { orderNo, site = 'G', status = 1, name = '최지마', product = '무선 충전기', option = '화이트', qty = 1, price = 21000 }) {
  state.esm.orders.set(String(orderNo), {
    site,
    status,
    data: {
      OrderNo: Number(orderNo),
      PayNo: Number(orderNo) - 1000,
      GroupNo: 0,
      GoodsNo: 'B123456789',
      GoodsName: product,
      ItemOptionSelectList: [{ OptionName: '색상', OptionValue: option }],
      SalePrice: price,
      ContrAmount: qty,
      OrderAmount: price * qty,
      BuyerName: name,
      BuyerMobileTel: '010-5555-6666',
      ReceiverName: name,
      HpNo: '010-5555-6666',
      TelNo: '',
      ZipCode: '04783',
      DelFullAddress: '서울특별시 성동구 왕십리로 83-21 아크로서울포레스트 D동 101호',
      DelMemo: '경비실에 맡겨주세요',
      OrderDate: '2026-11-22 09:10:00',
      PaymentDate: '2026-11-22 09:11:00',
      TransDueDate: '2026-11-25',
      ShippingFee: 0,
    },
  });
}

function verifyEsmToken(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/);
  if (!m) return { error: 'missing bearer token' };
  const header = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8'));
  const expected = crypto.createHmac('sha256', ESM.secretKey).update(`${m[1]}.${m[2]}`).digest('base64url');
  if (expected !== m[3]) return { error: 'invalid signature' };
  if (header.alg !== 'HS256' || header.kid !== ESM.masterId) return { error: 'invalid kid' };
  if (payload.aud !== 'sa.esmplus.com' || payload.sub !== 'sell' || !payload.iss) return { error: 'invalid claims' };
  const sm = String(payload.ssi || '').match(/^([AG]):(\w+)$/);
  if (!sm) return { error: 'invalid ssi' };
  const want = sm[1] === 'G' ? ESM.gmarketId : ESM.auctionId;
  if (sm[2] !== want) return { error: 'unknown seller' };
  return { site: sm[1], sellerId: sm[2] };
}

async function handleEsm(state, req, res, url) {
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  const auth = verifyEsmToken(req);
  if (auth.error) return send(401, { ResultCode: 401, Message: auth.error });
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) : {};
  let m;
  if (url.pathname === '/shipping/v1/Order/RequestOrders' && req.method === 'POST') {
    const key = `${auth.site}:${auth.sellerId}`;
    const last = state.esm.lastCall.get(key) || 0;
    if (Date.now() - last < state.esm.minIntervalMs) {
      state.esm.rateLimited++;
      return send(200, { ResultCode: 3000, Message: '주문 조회는 5초당 1회 호출 가능합니다.' });
    }
    state.esm.lastCall.set(key, Date.now());
    state.esm.calls.list.push({ site: auth.site, ...body });
    if ((auth.site === 'G' ? 2 : 1) !== body.siteType) return send(200, { ResultCode: 3000, Message: 'siteType 불일치' });
    if (!/^\d{4}-\d{2}-\d{2}/.test(body.requestDateFrom || '') || !/^\d{4}-\d{2}-\d{2}/.test(body.requestDateTo || '')) return send(200, { ResultCode: 3000, Message: '조회 기간 형식 오류' });
    const list = [...state.esm.orders.values()].filter((o) => o.site === auth.site && o.status === body.orderStatus).map((o) => o.data);
    // OrderNo 는 숫자로 내보냄 (실제 API 처럼)
    return send(200, { ResultCode: 0, Message: '성공', Data: { RequestOrders: list, TotalCount: list.length, PageIndex: body.pageIndex || 1, PageSize: body.pageSize || 100 } });
  }
  if ((m = url.pathname.match(/^\/shipping\/v1\/Order\/OrderCheck\/(\d+)$/)) && req.method === 'POST') {
    state.esm.calls.check.push(m[1]);
    const o = state.esm.orders.get(m[1]);
    if (!o || o.site !== auth.site) return send(200, { ResultCode: 3000, Message: '주문을 찾을 수 없습니다' });
    if (o.status !== 1) return send(200, { ResultCode: 3000, Message: '주문확인 대상이 아닙니다' });
    o.status = 2;
    return send(200, { ResultCode: 0, Message: '성공', Data: { OrderNo: Number(m[1]) } });
  }
  if (url.pathname === '/shipping/v1/Delivery/ShippingInfo' && req.method === 'POST') {
    state.esm.calls.ship.push(raw);
    if (!/"OrderNo":\d+/.test(raw)) return send(200, { ResultCode: 3000, Message: 'OrderNo 자릿수 오류' });
    const o = state.esm.orders.get(String(body.OrderNo));
    if (!o || o.site !== auth.site) return send(200, { ResultCode: 3000, Message: '주문을 찾을 수 없습니다' });
    if (o.status !== 2) return send(200, { ResultCode: 3000, Message: '발송처리 가능한 상태가 아닙니다 (주문확인 필요)' });
    if (!ESM_COURIERS.has(body.DeliveryCompanyCode)) return send(200, { ResultCode: 3000, Message: '택배사 코드 오류' });
    if (!/^\d{9,14}$/.test(body.InvoiceNo || '')) return send(200, { ResultCode: 3000, Message: '송장번호 규칙 오류' });
    o.status = 3;
    o.data.InvoiceNo = body.InvoiceNo;
    o.data.DeliveryCompanyCode = body.DeliveryCompanyCode;
    return send(200, { ResultCode: 0, Message: '성공', Data: { OrderNo: body.OrderNo } });
  }
  return send(404, { ResultCode: 404, Message: `no route ${url.pathname}` });
}

// ---------- 롯데ON ----------
function lotteonAddItem(state, { odNo, odSeq = 1, step = '11', name = '정롯데', product = '캠핑 랜턴', option = '블랙', qty = 1, price = 33000 }) {
  state.lotteon.items.set(`${odNo}-${odSeq}`, {
    step,
    data: {
      odNo: String(odNo),
      odSeq,
      procSeq: 1,
      spdNo: 'LO123456',
      spdNm: product,
      sitmNm: option,
      odQty: qty,
      slPrc: price,
      odAmt: price * qty,
      odrNm: name,
      odrMphnNo: '010-7777-8888',
      dvpCustNm: name,
      dvpMphnNo: '010-7777-8888',
      dvpZipNo: '07335',
      dvpStnmZipAddr: '서울특별시 영등포구 여의대로 108',
      dvpStnmDtlAddr: '파크원 타워1 20층',
      dvMsg: '문 앞에 놓아주세요',
      odAcptDttm: kstStamp(),
    },
  });
}

async function handleLotteon(state, req, res, url) {
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.headers.authorization !== `Bearer ${LOTTEON.apiKey}`) return send(401, { returnCode: '401', message: 'Unauthorized' });
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) : {};
  const stamp = (v) => /^\d{14}$/.test(String(v || ''));
  if (url.pathname === '/v1/openapi/order/v1/getOrderList' && req.method === 'POST') {
    state.lotteon.calls.orders++;
    if (!stamp(body.srchStrtDtm) || !stamp(body.srchEndDtm)) return send(200, { returnCode: '9000', message: '검색일시 형식 오류' });
    // 주문정보에는 진행단계가 없다고 가정 → 배송상태 조회와 합쳐야 함
    return send(200, { returnCode: '0000', message: '정상', data: [...state.lotteon.items.values()].map((i) => ({ ...i.data })) });
  }
  if (url.pathname === '/v1/openapi/delivery/v1/SellerDeliveryProgressStateSearch' && req.method === 'POST') {
    state.lotteon.calls.progress++;
    if (!stamp(body.srchStrtDt) || !stamp(body.srchEndDt)) return send(200, { returnCode: '9000', message: '검색일시 형식 오류' });
    return send(200, {
      returnCode: '0000',
      message: '정상',
      data: [...state.lotteon.items.values()].map((i) => ({ odNo: i.data.odNo, odSeq: i.data.odSeq, procSeq: 1, odPrgsStepCd: i.step })),
    });
  }
  if (url.pathname === '/v1/openapi/delivery/v1/SellerDeliveryProgressStateInform' && req.method === 'POST') {
    state.lotteon.calls.inform.push(body);
    const list = body.deliveryProgressStateList;
    if (!Array.isArray(list) || !list.length) return send(200, { returnCode: '9000', message: 'deliveryProgressStateList 필수' });
    const results = list.map((x) => {
      const it = state.lotteon.items.get(`${x.odNo}-${x.odSeq}`);
      const fail = (msg) => ({ odNo: x.odNo, odSeq: x.odSeq, resultCode: '9999', resultMessage: msg });
      if (!it) return fail('주문 없음');
      if (!stamp(x.dvTrcStatDttm) || !x.procSeq) return fail('필수값 누락');
      if (x.odPrgsStepCd === '12') {
        if (it.step !== '11') return fail('출고지시 상태가 아님');
        it.step = '12';
      } else if (x.odPrgsStepCd === '13') {
        if (!['11', '12'].includes(it.step)) return fail('발송 가능 상태가 아님');
        if (!x.invcNbr || !LOTTEON_COURIERS.has(x.dvCoCd) || !x.invcNo) return fail('택배사/송장 필수');
        it.step = '13';
        it.data.invcNo = x.invcNo;
        it.data.dvCoCd = x.dvCoCd;
      } else return fail('지원하지 않는 단계');
      return { odNo: x.odNo, odSeq: x.odSeq, resultCode: '0000', resultMessage: '성공' };
    });
    return send(200, { returnCode: '0000', message: '정상', data: results });
  }
  return send(404, { returnCode: '404', message: `no route ${url.pathname}` });
}

module.exports = { createEsmLotteonState, handleEsm, handleLotteon, esmAddOrder, lotteonAddItem, ESM, LOTTEON };
