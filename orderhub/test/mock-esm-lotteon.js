'use strict';
// 테스트용 가짜 ESM(G마켓·옥션) / 롯데ON 서버 - 인증(JWT 서명, Bearer 키)을 실제처럼 검증
const crypto = require('node:crypto');

const ESM = { masterId: 'master01', secretKey: 'esm-secret', gmarketId: 'gseller', auctionId: 'aseller' };
const LOTTEON = { apiKey: 'lotteonKey', trNo: 'LO10012345' };
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
    esm: { orders: new Map(), qnas: [], calls: { list: [], check: [], ship: [], qna: [] }, minIntervalMs: 0, lastCall: new Map(), rateLimited: 0 },
    lotteon: { items: new Map(), qnas: [], sellerInquiries: [], calls: { orders: 0, progress: 0, inform: [], qna: [], sellerInquiry: [] } },
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
  // 판매자 문의(게시판): 옥션 qnaType 1·2, G마켓 3 / 기간 7일 이내 / G마켓은 배열 그대로, 옥션은 Data 로 감싸서 (두 모양 모두 처리하는지 확인)
  if (url.pathname === '/item/v1/communications/customer/bulletin-board' && req.method === 'POST') {
    state.esm.calls.qna.push({ site: auth.site, ...body });
    const okType = auth.site === 'G' ? body.qnaType === 3 : [1, 2].includes(body.qnaType);
    if (!okType) return send(200, { ResultCode: 3000, Message: 'qnaType 이 올바르지 않습니다.' });
    if (body.status !== 1 || body.type !== 1) return send(200, { ResultCode: 3000, Message: 'status/type 오류' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate || '')) return send(200, { ResultCode: 3000, Message: '조회 기간 형식 오류' });
    if (Date.parse(body.endDate) - Date.parse(body.startDate) > 8 * 86400000) return send(200, { ResultCode: 3000, Message: '조회 기간은 7일 이내로 입력해주세요.' });
    const list = state.esm.qnas.filter((q) => q.site === auth.site && q.qnaType === body.qnaType && q.day >= body.startDate && q.day < body.endDate).map((q) => q.data);
    return auth.site === 'G' ? send(200, list) : send(200, { ResultCode: 0, Message: '성공', Data: list });
  }
  return send(404, { ResultCode: 404, Message: `no route ${url.pathname}` });
}

// ---------- 롯데ON ----------
// 실제 API 처럼: 출고/회수지시 목록(209)에는 odSeq 가 없고 진행단계는 11 고정, 현재 단계·odSeq 는 배송상태 조회(140)로
function lotteonAddItem(state, { odNo, odSeq = 1, step = '11', name = '정롯데', product = '캠핑 랜턴', option = '블랙', qty = 1, price = 33000, linked = false, instructAt = new Date() }) {
  state.lotteon.items.set(`${odNo}-${odSeq}`, {
    step,
    odSeq: String(odSeq),
    linked, // 다른 프로그램이 연동완료 처리한 주문 (ifCplYN=Y 로만 조회됨)
    instructAt, // 출고지시 생성 시각
    returnInstructed: false,
    data: {
      odNo: String(odNo),
      procSeq: '1',
      spdNo: `LO${100000 + Number(odSeq)}`,
      sitmNo: `LO${100000 + Number(odSeq)}_1`,
      spdNm: product,
      sitmNm: option,
      odQty: qty,
      slPrc: price,
      actualAmt: price * qty,
      dvCst: 0,
      odrNm: name,
      mphnNo: '010-7777-8888',
      dvpCustNm: name,
      dvpMphnNo: '010-7777-8888',
      dvpZipNo: '07335',
      dvpStnmZipAddr: '서울특별시 영등포구 여의대로 108',
      dvpStnmDtlAddr: '파크원 타워1 20층',
      dvMsg: '문 앞에 놓아주세요',
      odAccpDttm: kstStamp(instructAt),
      odCmptDttm: kstStamp(instructAt),
      odTypCd: '10',
      odPrgsStepCd: '11',
    },
  });
}

function stampToDate(s) {
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+09:00`);
}

async function handleLotteon(state, req, res, url) {
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  // 방화벽 흉내: 'node' = Node 기본 요청만 차단, 'all' = IP 미등록처럼 전부 차단 (빈 응답 403)
  const ua = req.headers['user-agent'] || '';
  const blocked = state.lotteon.block === 'all' || (state.lotteon.block === 'node' && (ua === 'node' || req.headers['sec-fetch-mode']));
  (state.lotteon.uas ||= []).push(ua);
  if (blocked) {
    res.writeHead(403, { Server: 'nginx' });
    return res.end();
  }
  if (req.headers.authorization !== `Bearer ${LOTTEON.apiKey}`) return send(401, { returnCode: '401', message: '등록되지 않은 OpenAPI Key 입니다.' });
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) : {};
  const stamp = (v) => /^\d{14}$/.test(String(v || ''));
  const trOk = body.trGrpCd === 'SR' && body.trNo === LOTTEON.trNo;
  const trFail = () => send(200, { returnCode: '9001', message: '입력하신 API 인증키에서 확인된 거래처번호와 입력하신 거래처번호가 일치하지 않습니다.' });
  // 기간 조건 검사: 형식 + 1일 초과 불가
  const range = () => {
    if (!stamp(body.srchStrtDt) || !stamp(body.srchEndDt)) return { error: send(200, { returnCode: '9000', message: '검색일시 형식 오류' }) };
    const from = stampToDate(body.srchStrtDt);
    const to = stampToDate(body.srchEndDt);
    if (to - from > 86400000) return { error: send(200, { returnCode: '2003', message: '조회기간은 1일을 초과할 수 없습니다.' }) };
    return { from, to };
  };

  // 주문정보 조회는 일반 판매자 키로는 접근 거부
  if (url.pathname === '/v1/openapi/order/v1/getOrderList') {
    res.writeHead(403);
    return res.end();
  }
  if (url.pathname === '/v1/openapi/delivery/v1/SellerDeliveryOrdersSearch' && req.method === 'POST') {
    state.lotteon.calls.orders++;
    (state.lotteon.calls.orderBodies ||= []).push(body);
    if (!trOk) return trFail();
    const r = range();
    if (r.error) return r.error;
    const linkedOnly = body.ifCplYN === 'Y';
    const list = [];
    const sec = (d) => Math.floor(d.getTime() / 1000) * 1000; // 실제처럼 초 단위로 비교
    for (const it of state.lotteon.items.values()) {
      if (sec(it.instructAt) < r.from.getTime() || sec(it.instructAt) > r.to.getTime()) continue;
      if (linkedOnly !== !!it.linked) continue;
      list.push({ ...it.data });
      if (it.returnInstructed) list.push({ ...it.data, odTypCd: '40', odPrgsStepCd: '23', procSeq: '2' });
    }
    return send(200, { returnCode: '0000', message: '정상', data: { deliveryOrderList: list } });
  }
  if (url.pathname === '/v1/openapi/delivery/v1/SellerDeliveryProgressStateSearch' && req.method === 'POST') {
    state.lotteon.calls.progress++;
    if (!trOk) return trFail();
    let items = [...state.lotteon.items.values()];
    if (body.odNo) items = items.filter((i) => i.data.odNo === String(body.odNo));
    else {
      const r = range();
      if (r.error) return r.error;
      const sec = (d) => Math.floor(d.getTime() / 1000) * 1000;
      items = items.filter((i) => sec(i.instructAt) >= r.from.getTime() && sec(i.instructAt) <= r.to.getTime());
    }
    return send(200, {
      returnCode: '0000',
      message: '정상',
      data: items.map((i) => ({
        odNo: i.data.odNo,
        odSeq: i.odSeq,
        procSeq: '1',
        spdNo: i.data.spdNo,
        sitmNo: i.data.sitmNo,
        odPrgsStepCd: i.step,
        dvTrcStatDttm: kstStamp(),
        dvCoCd: i.data.dvCoCd || '',
        invcNo: i.data.invcNo || '',
      })),
    });
  }
  if (url.pathname === '/v1/openapi/delivery/v1/SellerDeliveryProgressStateInform' && req.method === 'POST') {
    state.lotteon.calls.inform.push(body);
    const list = body.deliveryProgressStateList;
    if (!Array.isArray(list) || !list.length) return send(200, { returnCode: '9000', message: 'deliveryProgressStateList 필수' });
    const results = list.map((x) => {
      const it = state.lotteon.items.get(`${x.odNo}-${x.odSeq}`);
      const fail = (msg) => ({ odNo: x.odNo, odSeq: x.odSeq, spdNo: x.spdNo, resultCode: '9999', resultMessage: msg });
      if (!it) return fail('주문 없음');
      if (x.dvRtrvDvsCd !== 'DV' || !stamp(x.dvTrcStatDttm) || !x.procSeq) return fail('필수값 누락');
      if (x.spdNo !== it.data.spdNo || x.sitmNo !== it.data.sitmNo || !Number(x.slQty)) return fail('상품정보(spdNo/sitmNo/slQty) 불일치');
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
      return { odNo: x.odNo, odSeq: x.odSeq, spdNo: x.spdNo, resultCode: '0000', resultMessage: '성공' };
    });
    return send(200, { returnCode: '0000', message: '정상', data: results });
  }
  // 상품 Q&A (apiNo 99): 거래처번호 + 등록일시(yyyyMMddHHmmss) + 처리상태 + 페이지
  if (url.pathname === '/v1/openapi/product/v1/product/qna/list' && req.method === 'POST') {
    state.lotteon.calls.qna.push(body);
    if (!trOk) return trFail();
    if (!stamp(body.regStrDttm) || !stamp(body.regEndDttm)) return send(200, { returnCode: '9000', message: '등록일시 형식 오류' });
    if (!['ALL', 'NPROC', 'PROC', 'CC_TCTL'].includes(body.qnaStatCd) || !(body.rowsPerPage > 0 && body.rowsPerPage <= 100) || !(body.pageNo >= 1)) return send(200, { returnCode: '9000', message: '조회 조건 오류' });
    const from = stampToDate(body.regStrDttm);
    const to = stampToDate(body.regEndDttm);
    if (to - from > 7 * 86400000) return send(200, { returnCode: '2003', message: '조회기간은 7일을 초과할 수 없습니다.' });
    const all = state.lotteon.qnas.filter((q) => stampToDate(q.regDttm) >= from && stampToDate(q.regDttm) <= to && (body.qnaStatCd === 'ALL' || q.qnaStatCd === body.qnaStatCd));
    return send(200, { returnCode: '0000', message: '정상', data: all.slice((body.pageNo - 1) * body.rowsPerPage, body.pageNo * body.rowsPerPage) });
  }
  // 판매자 문의 (apiNo 179): 거래처번호 불필요, 접수일(yyyymmdd) / 없으면 '조회된 데이터가 없습니다' 오류 / deny 면 403
  if (url.pathname === '/v1/openapi/customer/v1/getSellerInquiryList' && req.method === 'POST') {
    state.lotteon.calls.sellerInquiry.push(body);
    if (state.lotteon.denySellerInquiry) {
      res.writeHead(403);
      return res.end();
    }
    if (!/^\d{8}$/.test(body.scStrtDt || '') || !/^\d{8}$/.test(body.scEndDt || '')) return send(200, { returnCode: '9000', message: '조회기간 형식 오류' });
    const list = state.lotteon.sellerInquiries.filter((q) => q.accpDttm.slice(0, 8) >= body.scStrtDt && q.accpDttm.slice(0, 8) <= body.scEndDt);
    if (!list.length) return send(200, { returnCode: '9999', message: '조회된 데이터가 없습니다.' });
    return send(200, { returnCode: '0000', message: '정상', data: { rsltList: list.slice((body.pageNo - 1) * body.rowsPerPage, body.pageNo * body.rowsPerPage), totCnt: list.length } });
  }
  return send(404, { returnCode: '404', message: `no route ${url.pathname}` });
}

module.exports = { createEsmLotteonState, handleEsm, handleLotteon, esmAddOrder, lotteonAddItem, ESM, LOTTEON };
