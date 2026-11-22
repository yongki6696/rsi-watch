'use strict';
// 매출 집계 + 지난 주문 불러오기 테스트
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../src/config');
const { createApp } = require('../server');
const { kstDate } = require('../src/util');
const { startMock, naverAddOrder, coupangAddSheet, NAVER, COUPANG } = require('./mock-markets');

const WD = ['일', '월', '화', '수', '목', '금', '토'];
const kst = (s) => new Date(`${s}+09:00`).toISOString(); // '2026-11-20T10:00:00' (KST) → UTC ISO

async function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orderhub-sales-'));
  const app = createApp({
    ...baseConfig,
    dataDir: dir,
    dbFile: path.join(dir, 'test.db'),
    secretKey: 'unit-test-secret',
    adminPassword: '',
    disableScheduler: true,
    backfillGapMs: 0,
    ...extra,
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    app.sync.stop();
    await new Promise((r) => server.close(r));
    app.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let cookie = '';
  async function call(method, p, body, { raw = false } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { 'X-OrderHub': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status} ${data.error}`), { status: res.status });
    return data;
  }
  await call('POST', '/api/auth/setup', { password: 'secret1234' });
  return { app, call };
}

function addStore(app, type, name, state = {}, createdAt = new Date().toISOString()) {
  const r = app.db.run(
    'INSERT INTO stores(type, name, enabled, credentials, state, created_at) VALUES(?, ?, 1, ?, ?, ?)',
    type,
    name,
    app.secrets.encrypt({}),
    JSON.stringify(state),
    createdAt
  );
  return app.db.get('SELECT * FROM stores WHERE id = ?', Number(r.lastInsertRowid));
}

function group(key, { orderNo = key, paidAt, shippingFee = 0, items }) {
  return {
    groupKey: key,
    orderNo,
    paidAt,
    orderedAt: paidAt,
    receiverName: '홍길동',
    address1: '서울',
    shippingFee,
    items: items.map(([amount, state = 'DELIVERED', qty = 1], i) => ({
      itemKey: `${key}-${i + 1}`,
      orderNo,
      productName: `상품${i + 1}`,
      quantity: qty,
      unitPrice: amount / qty,
      amount,
      marketState: state,
      marketStatus: state,
    })),
  };
}

async function waitBackfill(call) {
  for (let i = 0; i < 200; i++) {
    const { backfill } = await call('GET', '/api/sales/backfill');
    if (backfill && !backfill.running) return backfill;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('지난 주문 불러오기가 끝나지 않음');
}

test('매출: 마켓별·일자별 집계 (취소·반품 제외, KST 날짜, 배송비 별도)', async (t) => {
  const { app, call } = await setup(t);
  const A = addStore(app, 'naver', '내스마트스토어', { _syncedOnce: true, coverageFrom: '2026-11-21' });
  const B = addStore(app, 'coupang', '내쿠팡', { _syncedOnce: true }, '2026-11-20T03:00:00.000Z');
  const apply = (store, g) => assert.ok(app.orders.applyGroup(store, g));

  apply(A, group('A1', { paidAt: kst('2026-11-20T10:00:00'), shippingFee: 3000, items: [[10000], [5000]] }));
  apply(A, group('A2', { paidAt: kst('2026-11-20T23:30:00'), items: [[20000]] })); // 한국시간 20일 밤
  apply(A, group('A3', { paidAt: kst('2026-11-21T00:10:00'), items: [[7000]] })); // UTC 로는 20일이지만 한국시간 21일
  apply(A, group('A4', { paidAt: kst('2026-11-21T09:00:00'), shippingFee: 3000, items: [[8000, 'CANCELED']] }));
  apply(A, group('A5', { paidAt: kst('2026-11-21T12:00:00'), items: [[3000, 'RETURNED'], [9000]] }));
  apply(A, group('A6', { paidAt: kst('2026-11-22T08:00:00'), items: [[12000, 'NEW']] }));
  const a6 = app.db.get("SELECT id FROM orders WHERE group_key = 'A6'");
  app.actions.cancelLocal(a6.id); // 내 목록에서 취소 처리한 주문도 제외
  // 쿠팡: 주문번호 하나에 배송 묶음 2개 → 주문 1건
  apply(B, group('B1', { orderNo: 'CP-1', paidAt: kst('2026-11-22T09:00:00'), shippingFee: 2500, items: [[4000, 'SHIPPED']] }));
  apply(B, group('B2', { orderNo: 'CP-1', paidAt: kst('2026-11-22T09:00:00'), shippingFee: 2500, items: [[6000, 'CONFIRMED']] }));
  apply(B, group('B3', { paidAt: kst('2026-10-30T09:00:00'), items: [[99000]] })); // 기간 밖

  const r = await call('GET', '/api/sales?from=2026-11-19&to=2026-11-22');
  assert.equal(r.days, 4);
  assert.deepEqual(
    r.daily.map((d) => d.date),
    ['2026-11-22', '2026-11-21', '2026-11-20', '2026-11-19']
  );
  assert.equal(r.daily[0].weekday, WD[new Date('2026-11-22T00:00:00Z').getUTCDay()]);
  const day = Object.fromEntries(r.daily.map((d) => [d.date, d]));
  assert.equal(day['2026-11-20'].orders, 2);
  assert.equal(day['2026-11-20'].amount, 35000);
  assert.equal(day['2026-11-20'].shipping, 3000);
  assert.equal(day['2026-11-21'].orders, 2);
  assert.equal(day['2026-11-21'].amount, 16000);
  assert.equal(day['2026-11-21'].shipping, 0, '취소된 주문의 배송비는 제외');
  assert.equal(day['2026-11-22'].orders, 1);
  assert.equal(day['2026-11-22'].amount, 10000);
  assert.equal(day['2026-11-22'].shipping, 5000);
  assert.deepEqual(day['2026-11-22'].stores[B.id], { orders: 1, amount: 10000, shipping: 5000, qty: 2 });
  assert.equal(day['2026-11-22'].stores[A.id], undefined);
  assert.equal(day['2026-11-19'].orders, 0);

  const sa = r.stores.find((s) => s.id === A.id);
  const sb = r.stores.find((s) => s.id === B.id);
  assert.equal(sa.orders, 4);
  assert.equal(sa.amount, 51000);
  assert.equal(sa.coverageFrom, '2026-11-21');
  assert.equal(sb.orders, 1);
  assert.equal(sb.amount, 10000);
  assert.equal(sb.coverageFrom, '2026-11-13', '정보가 없으면 연결일 - 첫 연결 기간(7일)');
  assert.deepEqual(r.total, { orders: 5, amount: 61000, shipping: 8000, qty: 7 });

  // 시작/종료 순서가 바뀌어도 동작, 날짜 검증
  const swapped = await call('GET', '/api/sales?from=2026-11-22&to=2026-11-20');
  assert.equal(swapped.from, '2026-11-20');
  await assert.rejects(call('GET', '/api/sales?from=2026-13-01&to=2026-11-22'), (e) => e.status === 400);
  await assert.rejects(call('GET', '/api/sales?from=2025-01-01&to=2026-11-22'), (e) => e.status === 400);

  // 엑셀(CSV)
  const csvText = async (qs) => {
    const res = await call('GET', `/api/sales/export.csv?${qs}`, undefined, { raw: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /orderhub_sales_/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 3).toString('hex'), 'efbbbf');
    return buf.toString('utf8').slice(1).trim().split('\r\n');
  };
  const byStore = await csvText('from=2026-11-19&to=2026-11-22&view=stores');
  assert.equal(byStore[0], '판매처,마켓,주문건수,매출');
  assert.ok(byStore.includes('내스마트스토어,스마트스토어,4,51000'));
  assert.ok(byStore.includes('내쿠팡,쿠팡,1,10000'));
  assert.equal(byStore.at(-1), '합계,,5,61000');
  const withShip = await csvText('from=2026-11-19&to=2026-11-22&view=stores&shipping=1');
  assert.equal(withShip[0], '판매처,마켓,주문건수,매출(배송비 포함)');
  assert.equal(withShip.at(-1), '합계,,5,69000');
  const daily = await csvText(`from=2026-11-19&to=2026-11-22&view=daily&stores=${A.id}`);
  assert.equal(daily[0], '날짜,요일,주문건수,매출,내스마트스토어 주문건수,내스마트스토어 매출');
  assert.equal(daily[1], `2026-11-22,${WD[new Date('2026-11-22T00:00:00Z').getUTCDay()]},0,0,0,0`);
  assert.ok(daily.some((l) => l.startsWith('2026-11-20,') && l.endsWith(',2,35000,2,35000')));
  assert.equal(daily.at(-1), '합계,,4,51000,4,51000');
});

test('지난 주문 불러오기: 데모 스토어 (중복 없이, 알림 없이, 수집 시작일 갱신)', async (t) => {
  const { app, call } = await setup(t);
  const sent = [];
  app.notifier.send = async (m) => sent.push(m);
  const { store } = await call('POST', '/api/stores', { type: 'demo', name: '데모' });
  await call('POST', '/api/sync', {});
  const before = app.db.get('SELECT COUNT(*) AS n FROM orders').n;
  sent.length = 0;

  await assert.rejects(call('POST', '/api/sales/backfill', { days: 40 }), (e) => e.status === 400);
  const started = await call('POST', '/api/sales/backfill', { days: 5 });
  assert.equal(started.backfill.running, true);
  const bf = await waitBackfill(call);
  assert.equal(bf.results.length, 1);
  const added = bf.results[0].added;
  assert.ok(added > 0, '지난 주문이 추가되어야 함');
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM orders').n, before + added);
  assert.equal(sent.filter((m) => m.type === 'newOrder').length, 0, '지난 주문은 알림 없음');
  const st = JSON.parse(app.db.get('SELECT state FROM stores WHERE id = ?', store.id).state);
  // 첫 연결 때 이미 7일 전부터 있으므로 5일 불러오기로는 앞당겨지지 않음
  assert.equal(st.coverageFrom, kstDate(new Date(Date.now() - 7 * 86400000)));
  assert.ok(st._syncedOnce);

  // 다시 불러와도 중복 없음
  await call('POST', '/api/sales/backfill', { days: 5 });
  const bf2 = await waitBackfill(call);
  assert.equal(bf2.results[0].added, 0);
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM orders').n, before + added);

  // 지난 기간 매출에 반영 (취소 주문 제외)
  const today = kstDate();
  const from = kstDate(new Date(Date.now() - 5 * 86400000));
  const r = await call('GET', `/api/sales?from=${from}&to=${today}`);
  const expected = app.db.get(
    `SELECT SUM(i.amount) AS amt FROM orders o JOIN order_items i ON i.order_id = o.id
     WHERE o.status NOT IN ('CANCELED','RETURNED') AND i.market_state NOT IN ('CANCELED','RETURNED','PENDING')`
  ).amt;
  assert.equal(r.total.amount, expected);
  assert.ok(r.daily.filter((d) => d.orders > 0).length >= 3);
  const sync = await call('GET', '/api/sync/status');
  assert.equal(sync.backfill.running, false);
  assert.equal(sync.stores[0].last_error, null);
});

test('지난 주문 불러오기: 스마트스토어·쿠팡 (기간을 나눠 조회, 오래된 주문 포함)', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { app, call } = await setup(t, { naverApiBase: `${mock.url}/external`, coupangApiBase: mock.url });
  const sent = [];
  app.notifier.send = async (m) => sent.push(m);

  // 20일 전 결제 → 배송완료된 주문 (첫 연결 7일 범위 밖)
  const old = new Date(Date.now() - 20 * 86400000);
  naverAddOrder(mock.state, { productOrderId: '2026110100000001', orderId: '2026110100000000', amount: 45000, status: 'DELIVERED', place: 'OK', at: old });
  naverAddOrder(mock.state, { productOrderId: '2026112200000001', orderId: '2026112200000000', amount: 12000 });
  const { store: nv } = await call('POST', '/api/stores', { type: 'naver', name: '스마트', credentials: { clientId: NAVER.clientId, clientSecret: NAVER.secret } });
  coupangAddSheet(mock.state, { shipmentBoxId: '700000000001', orderId: '9100000001', vendorItemId: '1', price: 30000, status: 'FINAL_DELIVERY' });
  coupangAddSheet(mock.state, { shipmentBoxId: '700000000002', orderId: '9100000002', vendorItemId: '2', price: 15000, status: 'NONE_TRACKING' });
  const { store: cp } = await call('POST', '/api/stores', {
    type: 'coupang',
    name: '쿠팡',
    credentials: { vendorId: COUPANG.vendorId, accessKey: COUPANG.accessKey, secretKey: COUPANG.secretKey },
  });
  await call('POST', '/api/sync', {});
  const has = (key) => !!app.db.get('SELECT 1 FROM order_items WHERE item_key = ?', key);
  assert.equal(has('2026110100000001'), false, '첫 연결(7일)에는 20일 전 주문 없음');
  assert.equal(has('2026112200000001'), true);
  assert.equal(has('700000000002-2'), false, '평소 수집은 업체직송 상태를 조회하지 않음');

  mock.state.naver.calls.windows = [];
  mock.state.coupang.calls.list = [];
  sent.length = 0;
  await call('POST', '/api/sales/backfill', { days: 31 });
  const bf = await waitBackfill(call);
  const res = Object.fromEntries(bf.results.map((r) => [r.storeId, r]));
  assert.equal(res[nv.id].error, null);
  assert.equal(res[cp.id].error, null);
  assert.equal(has('2026110100000001'), true, '20일 전 주문을 불러옴');
  assert.equal(has('700000000002-2'), true);
  assert.equal(res[nv.id].added, 1);
  assert.equal(res[cp.id].added, 1);
  assert.equal(sent.filter((m) => m.type === 'newOrder' || m.type === 'error').length, 0);

  // 네이버: 24시간 이하 구간으로 31일을 빠짐없이
  const w = mock.state.naver.calls.windows;
  assert.ok(w.length >= 31 && w.length <= 33, `구간 수 ${w.length}`);
  for (let i = 1; i < w.length; i++) assert.ok(Date.parse(w[i].from) - Date.parse(w[i - 1].to) <= 1000, '구간 사이 빈틈 없음');
  assert.ok(Date.now() - Date.parse(w[0].from) >= 31 * 86400000 - 60000);
  // 쿠팡: 6개 상태 × 7일 구간
  const firstPages = mock.state.coupang.calls.list.filter((c) => !c.page);
  const statuses = [...new Set(firstPages.map((c) => c.status))].sort();
  assert.deepEqual(statuses, ['ACCEPT', 'DELIVERING', 'DEPARTURE', 'FINAL_DELIVERY', 'INSTRUCT', 'NONE_TRACKING']);
  for (const c of firstPages) assert.ok((Date.parse(c.to) - Date.parse(c.from)) / 86400000 <= 6, `${c.from}~${c.to}`);
  assert.equal(new Set(firstPages.filter((c) => c.status === 'ACCEPT').map((c) => c.from)).size, 5);

  // 매출에 20일 전 주문 포함
  const from = kstDate(old);
  const r = await call('GET', `/api/sales?from=${from}&to=${from}`);
  assert.equal(r.stores.find((s) => s.id === nv.id).amount, 45000);
  const nvState = JSON.parse(app.db.get('SELECT state FROM stores WHERE id = ?', nv.id).state);
  assert.equal(nvState.coverageFrom, kstDate(new Date(Date.now() - 31 * 86400000)));
});
