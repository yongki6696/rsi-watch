'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toIso, kstIso, kstDate, kstCompact, formatPhone, toInt } = require('../src/util');
const { parseJsonBig, stringifyBig, BIG } = require('../src/connectors/http');
const naver = require('../src/connectors/naver');
const coupang = require('../src/connectors/coupang');
const elevenst = require('../src/connectors/elevenst');
const { derive, nextStatus } = require('../src/orders');
const { courierCode, findCourier } = require('../src/couriers');
const { ordersToCsv } = require('../src/csv');

test('KST 시간 포맷', () => {
  const d = new Date('2026-11-22T05:03:04.005Z');
  assert.equal(kstIso(d), '2026-11-22T14:03:04.005+09:00');
  assert.equal(kstDate(d), '2026-11-22');
  assert.equal(kstCompact(d), '202611221403');
  // 자정 경계
  assert.equal(kstDate(new Date('2026-11-22T15:30:00Z')), '2026-11-23');
});

test('toIso: 시간대 없는 값은 KST 로 해석', () => {
  assert.equal(toIso('2017-09-12T20:53:41'), '2017-09-12T11:53:41.000Z');
  assert.equal(toIso('2024-01-15 13:22:10'), '2024-01-15T04:22:10.000Z');
  assert.equal(toIso('20240115132210'), '2024-01-15T04:22:10.000Z');
  assert.equal(toIso('2023-01-16T17:14:51.794+09:00'), '2023-01-16T08:14:51.794Z');
  assert.equal(toIso(''), null);
  assert.equal(toIso('not a date'), null);
});

test('전화번호/금액 정리', () => {
  assert.equal(formatPhone('01012345678'), '010-1234-5678');
  assert.equal(formatPhone('0212345678'), '02-1234-5678');
  assert.equal(formatPhone('050412345678'), '0504-1234-5678');
  assert.equal(toInt({ currencyCode: 'KRW', units: 12900, nanos: 0 }), 12900);
  assert.equal(toInt('12,900원'), 12900);
});

test('큰 정수 ID 를 정밀도 손실 없이 처리', () => {
  const text = '{"data":[{"shipmentBoxId":642538970006401429,"orderId":7000001234,"price":12900,"memo":"번호 1234567890123456789 문앞"}],"neg":-12345678901234567890}';
  const j = parseJsonBig(text);
  assert.equal(j.data[0].shipmentBoxId, '642538970006401429');
  assert.equal(j.data[0].orderId, 7000001234);
  assert.equal(j.data[0].price, 12900);
  assert.equal(j.data[0].memo, '번호 1234567890123456789 문앞');
  assert.equal(j.neg, '-12345678901234567890');
  const out = stringifyBig({ shipmentBoxIds: [BIG('642538970006401429')], vendorId: 'A001' });
  assert.equal(out, '{"shipmentBoxIds":[642538970006401429],"vendorId":"A001"}');
  assert.throws(() => BIG('12a'));
});

test('쿠팡 HMAC 서명 (Python hmac 으로 만든 기준값과 일치)', () => {
  const { sign, buildQuery, signedDate } = coupang._internal;
  const query = buildQuery({ createdAtFrom: '2025-11-15+09:00', createdAtTo: '2025-11-22+09:00', status: 'ACCEPT', maxPerPage: 50 });
  assert.equal(query, 'createdAtFrom=2025-11-15%2B09%3A00&createdAtTo=2025-11-22%2B09%3A00&status=ACCEPT&maxPerPage=50');
  const now = new Date('2025-11-22T06:15:00Z');
  assert.equal(signedDate(now), '251122T061500Z');
  const auth = sign({
    method: 'GET',
    path: '/v2/providers/openapi/apis/api/v5/vendors/A00012345/ordersheets',
    query,
    accessKey: 'AK',
    secretKey: 'test-secret-key',
    now,
  });
  assert.equal(
    auth,
    'CEA algorithm=HmacSHA256, access-key=AK, signed-date=251122T061500Z, signature=b8a2ce0e551b51396164009ea42e391979e4f026966e930918e8dbb8003871f0'
  );
});

test('네이버 전자서명 (Python bcrypt 기준값과 일치)', () => {
  const sign = naver._internal.makeSign('testClientId', '$2a$04$abcdefghijklmnopqrstuu', 1700000000000);
  assert.equal(sign, 'JDJhJDA0JGFiY2RlZmdoaWprbG1ub3BxcnN0dXV5SVp3R2U4S2cvWW0zeVFzNzZqeXRRL0FYZmNkUmVp');
  assert.throws(() => naver._internal.makeSign('id', 'not-a-salt', 1), /시크릿 형식/);
});

test('네이버 상태 매핑', () => {
  const { mapState, mapClaim } = naver._internal;
  assert.equal(mapState({ productOrderStatus: 'PAYED', placeOrderStatus: 'NOT_YET' }), 'NEW');
  assert.equal(mapState({ productOrderStatus: 'PAYED', placeOrderStatus: 'OK' }), 'CONFIRMED');
  assert.equal(mapState({ productOrderStatus: 'DELIVERING' }), 'SHIPPED');
  assert.equal(mapState({ productOrderStatus: 'PURCHASE_DECIDED' }), 'DELIVERED');
  assert.equal(mapState({ productOrderStatus: 'CANCELED' }), 'CANCELED');
  assert.equal(mapState({ productOrderStatus: 'PAYMENT_WAITING' }), 'PENDING');
  assert.equal(mapClaim({ claimType: 'CANCEL', claimStatus: 'CANCEL_REQUEST' }), 'CANCEL');
  assert.equal(mapClaim({ claimType: 'RETURN', claimStatus: 'COLLECTING' }), 'RETURN');
  assert.equal(mapClaim({ claimType: 'CANCEL', claimStatus: 'CANCEL_REJECT' }), null);
  assert.equal(mapClaim({ claimType: 'EXCHANGE', claimStatus: 'EXCHANGE_DONE' }), null);
});

test('11번가 XML(EUC-KR) 파싱', () => {
  const { parseList, resultOf } = elevenst._internal;
  const xml = `<?xml version="1.0" encoding="euc-kr"?><ns2:orders xmlns:ns2="http://skt.tmall"><ns2:order><ordNo>2024011512345</ordNo><ordPrdSeq>1</ordPrdSeq>
    <prdNm><![CDATA[무선 이어폰 & 케이스]]></prdNm><rcvrNm>홍길동</rcvrNm><ordDlvReqCont>문앞 &lt;부재시&gt;</ordDlvReqCont></ns2:order>
    <ns2:order><ordNo>2024011512346</ordNo><ordPrdSeq>2</ordPrdSeq><prdNm>텀블러</prdNm></ns2:order></ns2:orders>`;
  const list = parseList(xml, 'order');
  assert.equal(list.length, 2);
  assert.equal(list[0].prdNm, '무선 이어폰 & 케이스');
  assert.equal(list[0].ordDlvReqCont, '문앞 <부재시>');
  assert.equal(list[1].ordPrdSeq, '2');
  assert.deepEqual(resultOf('<ResultOrder><result_code>-1</result_code><result_text>잘못된 키</result_text></ResultOrder>'), { code: '-1', text: '잘못된 키' });
  const g = elevenst._internal.normalizeOrder({ ordNo: '1', ordPrdSeq: '1', dlvNo: '99', prdNm: 'x', etcField: 'P123456789012' }, 'NEW', '결제완료');
  assert.equal(g.groupKey, '99');
  assert.equal(g.customsCode, 'P123456789012');
  assert.equal(g.items[0].extra.addPrdNo, 'null');
});

test('묶음 상태 판단', () => {
  const it = (market_state, claim = null) => ({ market_state, claim });
  assert.deepEqual(derive([it('NEW'), it('CONFIRMED')]), { market: 'OPEN', confirmed: false, claim: null });
  assert.deepEqual(derive([it('CONFIRMED'), it('CANCELED')]), { market: 'OPEN', confirmed: true, claim: null });
  assert.equal(derive([it('CANCELED'), it('CANCELED')]).market, 'CANCELED');
  assert.equal(derive([it('SHIPPED'), it('DELIVERED')]).market, 'SHIPPED');
  assert.equal(derive([it('DELIVERED')]).market, 'DELIVERED');
  assert.equal(derive([it('CONFIRMED', 'CANCEL')]).claim, 'CANCEL');
  assert.equal(nextStatus('PURCHASED', { market: 'OPEN' }), 'PURCHASED');
  assert.equal(nextStatus('PURCHASED', { market: 'CANCELED' }), 'CANCELED');
  assert.equal(nextStatus('CANCELED', { market: 'OPEN' }), 'NEW');
  assert.equal(nextStatus('INVOICED', { market: 'SHIPPED' }), 'SHIPPED');
  assert.equal(nextStatus('DELIVERED', { market: 'SHIPPED' }), 'DELIVERED');
});

test('택배사 코드 변환', () => {
  assert.equal(courierCode('CJ', 'naver'), 'CJGLS');
  assert.equal(courierCode('LOTTE', 'coupang'), 'HYUNDAI');
  assert.equal(courierCode('LOGEN', 'naver'), 'KGB');
  assert.equal(courierCode('CJ', 'elevenst'), '00034');
  assert.equal(courierCode('CUSTOM:ABC', 'coupang'), 'ABC');
  assert.equal(courierCode('CHUNIL', 'elevenst'), null);
  assert.equal(findCourier('CJ대한통운'), 'CJ');
  assert.equal(findCourier('롯데택배'), 'LOTTE');
  assert.equal(findCourier(' 우체국 '), 'EPOST');
  assert.equal(findCourier('알수없음'), null);
});

test('CSV: 수식 주입 방지 + 긴 숫자 보존', () => {
  const csv = ordersToCsv([{ store_type: 'naver', store_name: 'S', status: 'NEW', items: [{ item_key: '2022040521691281', product_name: '=HYPERLINK("x")', quantity: 1 }] }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"=""2022040521691281"""'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
});

test('DB 업데이트: 예전 DB에 확인(seen_at) 칸 추가 + 기존 주문은 확인한 것으로', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { Db } = require('../src/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orderhub-mig-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new Db(file);
    old.db.exec('ALTER TABLE orders DROP COLUMN seen_at'); // 예전 버전 DB 흉내
    old.run("INSERT INTO stores(type, name, created_at) VALUES('demo', 'd', '2026-11-01T00:00:00Z')");
    old.run("INSERT INTO orders(store_id, group_key, status, created_at, updated_at) VALUES(1, 'g1', 'NEW', 'x', 'x')");
    old.close();
    const db = new Db(file);
    assert.ok(db.get('SELECT seen_at FROM orders WHERE group_key = ?', 'g1').seen_at, '기존 신규주문은 확인한 것으로');
    db.run("INSERT INTO orders(store_id, group_key, status, created_at, updated_at) VALUES(1, 'g2', 'NEW', 'x', 'x')");
    assert.equal(db.get('SELECT seen_at FROM orders WHERE group_key = ?', 'g2').seen_at, null);
    db.close();
    const again = new Db(file); // 두 번째 실행에서는 그대로
    assert.equal(again.get('SELECT seen_at FROM orders WHERE group_key = ?', 'g2').seen_at, null);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('택배사 이름 → 직접발송', () => {
  const { findCourier, courierCode, isDirect } = require('../src/couriers');
  for (const n of ['업체직송', '직접발송', '직접 전달', '직접배송']) assert.equal(findCourier(n), 'DIRECT', n);
  assert.equal(courierCode('DIRECT', 'naver'), 'DIRECT_DELIVERY');
  assert.equal(courierCode('DIRECT', 'coupang'), 'DIRECT');
  assert.equal(courierCode('DIRECT', 'elevenst'), null);
  assert.equal(isDirect('DIRECT'), true);
  assert.equal(findCourier('CJ대한통운'), 'CJ');
});

test('문의 공통: HTML 정리 · 0건 응답 · 날짜 구간 · 날짜 형식', () => {
  const { plainText, isNoData, dateRanges } = require('../src/connectors/inquiry-util');
  assert.equal(plainText('사이즈<br/>문의 &amp; <b>급해요</b>&nbsp;!'), '사이즈\n문의 & 급해요 !');
  assert.equal(plainText('<문의> 색상 있나요?'), '<문의> 색상 있나요?', '한글 꺾쇠는 그대로');
  assert.equal(plainText({ a: 1 }), '');
  assert.equal(isNoData(new Error('롯데ON API 오류 [9999] 조회된 데이터가 없습니다.')), true);
  assert.equal(isNoData(new Error('11번가 API 오류 (-1): 조회 결과가 없습니다')), true);
  assert.equal(isNoData(new Error('API 사용 권한이 없습니다')), false, '권한 오류는 0건이 아님');
  assert.equal(isNoData(Object.assign(new Error('데이터가 없습니다'), { status: 404 })), false);
  // 최근 7일 = 1구간, 30일 = 7일씩 5구간 (빈틈 없이)
  const now = new Date('2026-11-24T03:00:00Z');
  assert.deepEqual(dateRanges(7, 7, now), [{ from: '2026-11-18', to: '2026-11-24' }]);
  const r30 = dateRanges(30, 7, now);
  assert.equal(r30.length, 5);
  assert.equal(r30[0].from, '2026-10-26');
  assert.equal(r30.at(-1).to, '2026-11-24');
  for (let i = 1; i < r30.length; i++) assert.equal(Date.parse(r30[i].from) - Date.parse(r30[i - 1].to), 86400000);
  assert.equal(toIso('2026.07.16 12:34:56'), '2026-07-16T03:34:56.000Z');
  assert.equal(toIso('2026/7/6'), '2026-07-05T15:00:00.000Z');
});

test('문의 응답 필드: ESM 실제(camelCase)·문서(PascalCase), 롯데ON 처리상태', () => {
  const { gmarket, auction } = require('../src/connectors/esm');
  const lotteon = require('../src/connectors/lotteon');
  const g = gmarket._internal.normalizeQna({ messageNo: '504346613', informStatus: '미처리', contractType: '상품', title: '상품 문의입니다.', details: '사이즈 크게 나왔나요?', receiveDate: '2026-07-20T22:28:00+09:00', inquirerName: '박정희', siteGoodsNo: '4761998630', token: 'tk' }, 3);
  assert.equal(g.key, 'b-504346613');
  assert.equal(g.kind, 'product');
  assert.equal(g.answered, false);
  assert.equal(g.productId, '4761998630');
  assert.equal(g.askedAt, '2026-07-20T13:28:00.000Z');
  assert.equal(g.extra.token, 'tk', '답변할 때 쓰는 토큰');
  const a = auction._internal.normalizeQna({ MessageNo: 'M1', InformStatus: '처리완료', ContractType: '배송', Title: '언제', ReceiveDate: '2026-07-21' }, 2);
  assert.equal(a.answered, true);
  assert.equal(a.kind, 'customer');
  assert.equal(a.category, '배송 · 비밀글');
  assert.equal(auction._internal.normalizeQna({ messageNo: 'M2', informStatus: '처리중' }, 1).answered, false);
  assert.equal(auction._internal.normalizeQna({ title: '번호 없음' }, 1), null);
  assert.equal(gmarket._internal.normalizeQna({ messageNo: 'M3', informStatus: '미처리', orderNo: '-' }, 3).orderNo, '');

  const { normalizeProductQna, normalizeSellerInquiry } = lotteon._internal;
  assert.equal(normalizeProductQna({ pdQnaNo: 'Q1', qnaStatCd: 'NPROC', qstCnts: '사이즈', spdNo: 'LO1', regDttm: '20260716120000' }).answered, false);
  assert.equal(normalizeProductQna({ pdQnaNo: 'Q2', qnaStatCd: 'PROC', qstCnts: '색상' }).answered, true);
  const cc = normalizeProductQna({ pdQnaNo: 'Q3', qnaStatCd: 'CC_TCTL', qstCnts: '이관' });
  assert.equal(cc.answered, true);
  assert.equal(cc.category, '고객센터 이관');
  const s = normalizeSellerInquiry({ slrInqNo: 779, inqCnts: '반품하려면?', pdNm: '테스트상품', slrInqProcStatCd: 'ANS', ansCnts: '안내드립니다', accpDttm: '20260716', procDttm: '20260716' });
  assert.equal(s.key, 's-779');
  assert.equal(s.answered, true);
  assert.equal(s.answer, '안내드립니다');
  assert.equal(s.askedAt, '2026-07-15T15:00:00.000Z');
  assert.equal(normalizeSellerInquiry({ slrInqNo: 780, slrInqProcStatCd: 'UNANS', ansCnts: '' }).answered, false);
});

test('쿠팡 반품·출고중지 접수 반영: 받은 발주서는 덮어쓰고, 나머지는 상태만', () => {
  const { applyReturns, receiptKeys } = coupang._internal;
  assert.deepEqual(receiptKeys({ returnItems: [{ shipmentBoxId: '642538970006401429', vendorItemId: 70000000001 }, { vendorItemId: 1 }] }), ['642538970006401429-70000000001']);
  const groups = [
    { groupKey: 'B1', items: [{ itemKey: 'B1-1', marketState: 'DELIVERED', marketStatus: '배송완료', claim: null }, { itemKey: 'B1-2', marketState: 'CANCELED', marketStatus: '취소', claim: null }] },
  ];
  const updates = new Map([
    ['B1-1', { claim: 'RETURN', label: '반품접수' }],
    ['B1-2', { claim: 'CANCEL', label: '출고중지요청' }],
    ['B2-9', { claim: null, marketState: 'RETURNED', label: '반품완료' }],
    ['B3-7', { claim: null, label: '반품요청 철회', vanished: true }],
  ]);
  const out = applyReturns(groups, updates);
  assert.equal(out[0].items[0].claim, 'RETURN');
  assert.equal(out[0].items[0].marketStatus, '배송완료 · 반품접수');
  assert.equal(out[0].items[1].claim, null, '발주서에서 이미 취소된 상품은 그대로');
  const b2 = out.find((g) => g.groupKey === 'B2');
  assert.deepEqual(b2.items[0], { itemKey: 'B2-9', partial: true, claim: null, marketState: 'RETURNED', marketStatus: '반품완료' });
  assert.equal(b2.partial, true);
  assert.equal(out.find((g) => g.groupKey === 'B3').items[0].marketStatus, '반품요청 철회');
});

test('주문 상품 링크: 마켓 판매 페이지 + 상품코드로 도매매 상품 페이지', () => {
  const { itemLinks, supplierOf } = require('../src/links');
  assert.equal(itemLinks('naver', { product_id: '6597568247' }).product_url, 'https://smartstore.naver.com/main/products/6597568247');
  assert.equal(itemLinks('coupang', { product_id: '70000000001', extra: JSON.stringify({ displayProductId: '307227331', vendorItemId: '70000000001' }) }).product_url, 'https://www.coupang.com/vp/products/307227331?vendorItemId=70000000001');
  assert.equal(itemLinks('coupang', { product_id: '7', extra: '{}' }).product_url, '', '노출상품ID 가 없으면 링크 없음');
  assert.equal(itemLinks('elevenst', { product_id: '5550001' }).product_url, 'https://www.11st.co.kr/products/5550001');
  assert.equal(itemLinks('gmarket', { product_id: '1527058123' }).product_url, 'https://item.gmarket.co.kr/Item?goodscode=1527058123');
  assert.equal(itemLinks('auction', { product_id: 'B642025679' }).product_url, 'https://itempage3.auction.co.kr/DetailView.aspx?itemno=B642025679');
  assert.equal(itemLinks('lotteon', { product_id: 'LO100001', extra: { spdNo: 'LO100001' } }).product_url, 'https://www.lotteon.com/p/product/LO100001');
  assert.equal(itemLinks('demo', { product_id: '1' }).product_url, '');
  assert.deepEqual(supplierOf('dmm41674420'), { name: '도매매', url: 'https://domeme.domeggook.com/s/41674420' });
  assert.deepEqual(supplierOf('DMM-41674420'), { name: '도매매', url: 'https://domeme.domeggook.com/s/41674420' });
  assert.equal(supplierOf('W287E35'), null);
  assert.equal(supplierOf(''), null);
  assert.equal(itemLinks('naver', { product_id: '1', product_code: 'dmm123456' }).supplier_url, 'https://domeme.domeggook.com/s/123456');
});

test('11번가 접속 진단 결론: API 만 막힘(허용 IP 목록) / 서버 IP 통째로 막힘', () => {
  const { blockConclusion } = elevenst._internal;
  const ok = '연결됨 (IPv4)';
  assert.match(blockConclusion({ tcp: '실패 (ETIMEDOUT)', apiTls: '건너뜀', webTls: null }), /연결 자체가 안 됩니다/);
  assert.match(blockConclusion({ tcp: ok, apiTls: '실패 (ECONNRESET)', webTls: '성공 (TLSv1.3, x)' }), /쇼핑몰은 이 서버에서 열리는데 API만 막힙니다[\s\S]*\[수정하기\]로 한 번 더 저장/);
  assert.match(blockConclusion({ tcp: ok, apiTls: '실패 (ECONNRESET)', webTls: '실패 (ECONNRESET)' }), /쇼핑몰\(www\)까지 이 서버 IP를 막고[\s\S]*국내 중계 서버/);
  assert.match(blockConclusion({ tcp: ok, apiTls: '실패 (ECONNRESET)', webTls: null }), /방화벽이 이 서버 IP를 막고/);
  assert.match(blockConclusion({ tcp: ok, apiTls: '성공 (TLSv1.3, x)', webTls: null }), /IP 등록이 아직 반영되지 않음/);
});

test('취소·반품 사유 → 반품배송비 부담 (스마트스토어 코드, 글자 사유, 쿠팡 귀책)', () => {
  const { naverReason, faultFromText, claimSummary } = require('../src/claims');
  assert.deepEqual(naverReason('COLOR_AND_SIZE'), { reason: '색상·사이즈 변경', fault: 'BUYER' });
  assert.deepEqual(naverReason('WRONG_DELIVERY'), { reason: '오배송', fault: 'SELLER' });
  assert.deepEqual(naverReason('PRODUCT_UNSATISFIED'), { reason: '서비스·상품 불만족', fault: 'SELLER' });
  assert.equal(naverReason('NEW_CODE').fault, 'UNKNOWN');
  assert.equal(faultFromText('상품 불량'), 'SELLER');
  assert.equal(faultFromText('상품정보와 상이'), 'SELLER');
  assert.equal(faultFromText('단순변심'), 'BUYER');
  assert.equal(faultFromText('사이즈를 잘못 골랐어요'), 'BUYER');
  assert.equal(faultFromText(''), 'UNKNOWN');
  // 스마트스토어는 청구액이 있으면 구매자 부담
  assert.equal(claimSummary({ market: 'naver', type: 'RETURN', reason: '기타', fault: 'UNKNOWN', feeAmount: 3000 }).payer, 'BUYER');
  assert.match(claimSummary({ market: 'naver', type: 'RETURN', reason: '단순 변심', fault: 'BUYER', feeAmount: 0 }).payerText, /청구액 0원/);
  assert.equal(claimSummary({ market: 'coupang', type: 'RETURN', reason: '배송 중 분실', fault: 'MARKET' }).payerText, '반품배송비 쿠팡 부담');
  assert.equal(claimSummary({ market: 'naver', type: 'CANCEL', reason: '주문 실수', fault: 'BUYER' }, { shipped: false }).payerText, '배송 전 취소라 반품배송비 없음');
  assert.equal(claimSummary({ market: 'naver', type: 'CANCEL', reason: '주문 실수', fault: 'BUYER' }, { shipped: true }).payerText, '반품배송비 구매자 부담');
  assert.equal(claimSummary(null), null);
});

test('마켓별 사유 읽기: 스마트스토어 상세 · 쿠팡 접수 · 11번가 · 롯데ON', () => {
  const lotteon = require('../src/connectors/lotteon');
  const n = naver._claimInfoOf({ productOrder: { claimType: 'RETURN' }, return: { returnReason: 'BROKEN', returnDetailedReason: '깨져서 왔어요', claimDeliveryFeeDemandAmount: 0 } });
  assert.deepEqual([n.type, n.reason, n.detail, n.fault, n.feeAmount], ['RETURN', '상품 파손', '깨져서 왔어요', 'SELLER', 0]);
  assert.equal(naver._claimInfoOf({ productOrder: { claimType: 'ADMIN_CANCEL' }, cancel: { cancelReason: 'SOLD_OUT' } }).fault, 'UNKNOWN', '직권취소는 귀책 확인 필요');
  assert.equal(naver._claimInfoOf({ productOrder: {} }), undefined);
  const c = coupang._internal.receiptInfo({ reasonCodeText: '', cancelReasonCategory1: '고객변심', cancelReasonCategory2: '색상변경', cancelReason: '다른 색이 좋아요', faultByType: 'GENERAL', returnShippingCharge: { units: 5000 }, enclosePrice: { units: 2500 } }, 'RETURN');
  assert.deepEqual([c.reason, c.detail, c.fault, c.feeAmount, c.feeNote], ['고객변심 > 색상변경', '다른 색이 좋아요', 'BUYER', 5000, '동봉 2,500원']);
  assert.equal(coupang._internal.receiptInfo({ reasonCodeText: '파손', faultByType: 'COUPANG' }, 'RETURN').fault, 'MARKET');
  const e = elevenst._internal.claimInfoOf({ ordCnRsnCd: '101', ordCnDtlsRsn: '단순변심' }, 'CANCEL');
  assert.deepEqual([e.reason, e.reasonCode, e.fault], ['단순변심', '101', 'BUYER']);
  assert.equal(elevenst._internal.claimInfoOf({}, 'CANCEL'), undefined);
  const l = lotteon._internal.claimInfoOf({ clmRsnCd: '305', clmRsnCnts: '상품이 설명과 달라요(상이)' }, 'DELIVERED', 'RETURN');
  assert.deepEqual([l.type, l.reason, l.fault], ['RETURN', '상품이 설명과 달라요(상이)', 'SELLER']);
  assert.equal(lotteon._internal.claimInfoOf({ clmRsnCd: '101' }, 'CANCELED', null).reason, '사유 코드 101');
  assert.equal(lotteon._internal.claimInfoOf({}, 'CANCELED', null), undefined);
});
