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
