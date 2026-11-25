'use strict';
// G마켓·옥션(ESM) / 롯데ON 연동 흐름 테스트
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../src/config');
const { createApp } = require('../server');
const { startMock } = require('./mock-markets');
const { esmAddOrder, lotteonAddItem, ESM, LOTTEON } = require('./mock-esm-lotteon');
const { makeToken, gmarket } = require('../src/connectors/esm');
const lotteon = require('../src/connectors/lotteon');
const { courierCode } = require('../src/couriers');

test('ESM JWT 토큰 (Python hmac 기준값과 일치)', () => {
  const token = makeToken({ masterId: 'master01', secretKey: 'esm-secret', sellerId: 'gseller', siteCode: 'G', iss: 'shop.example.com', now: 1700000000000 });
  assert.equal(
    token,
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Im1hc3RlcjAxIn0.eyJpc3MiOiJzaG9wLmV4YW1wbGUuY29tIiwic3ViIjoic2VsbCIsImF1ZCI6InNhLmVzbXBsdXMuY29tIiwic3NpIjoiRzpnc2VsbGVyIiwiaWF0IjoxNzAwMDAwMDAwfQ.tPMi98BQwaU3gzA5vGNTVaEwO698jwVVXY9q-XBR9jk'
  );
});

test('ESM/롯데ON 응답 필드 유연 매칭 + 택배사 코드', () => {
  const g = gmarket._internal.normalize(
    { OrderNo: 3012345678, GoodsName: '충전기', ItemOptionSelectList: [{ OptionName: '색상', OptionValue: '블랙' }], ContrAmount: 2, SalePrice: 10000, ReceiverName: '김', HpNo: '010-1-2', ZipCode: '01234', DelFullAddress: '서울 어딘가 1', DelMemo: '문앞', PaymentDate: '2026-11-22 10:00:00', customsNo: 'P123456789012' },
    2
  );
  assert.equal(g.groupKey, '3012345678');
  assert.equal(g.items[0].optionName, '색상: 블랙');
  assert.equal(g.items[0].quantity, 2);
  assert.equal(g.items[0].amount, 20000);
  assert.equal(g.items[0].marketState, 'CONFIRMED');
  assert.equal(g.receiverPhone, '010-1-2');
  assert.equal(g.customsCode, 'P123456789012');
  assert.equal(g.paidAt, '2026-11-22T01:00:00.000Z');

  const { group, item } = lotteon._internal.normalizeItem({ odNo: 'L1', odSeq: 2, odPrgsStepCd: '12', spdNm: '랜턴', sitmNm: '블랙', odQty: 1, slPrc: 5000, dvpCustNm: '정', dvpZipNo: '07335', dvpStnmZipAddr: '여의대로 108', dvpStnmDtlAddr: '20층' });
  assert.equal(item.itemKey, 'L1-2');
  // 출고지시 목록 형식: 상품번호로 라인 구분, 상품명 HTML 문자 정리, 주문일은 주문번호 앞 8자리
  const li = lotteon._internal.normalizeItem({ odNo: '2026112012345678', spdNo: 'P1', sitmNo: 'S1', spdNm: '&lt;정품&gt; 코트', odQty: 2, slPrc: 5000, actualAmt: 9000, odPrgsStepCd: '11', indvCstmPclrNo: 'P123456789012' });
  assert.equal(li.item.itemKey, '2026112012345678-P1-S1');
  assert.equal(li.item.productName, '<정품> 코트');
  assert.equal(li.item.amount, 9000);
  assert.equal(li.group.customsCode, 'P123456789012');
  assert.equal(li.group.orderedAt, '2026-11-19T15:00:00.000Z');
  assert.equal(lotteon._internal.dayWindows(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-04T00:00:00Z')).length, 3);
  assert.equal(item.marketState, 'CONFIRMED');
  assert.equal(group.receiverName, '정');
  assert.equal(group.address2, '20층');
  assert.match(lotteon._internal.dttm(new Date('2026-11-22T05:03:04Z')), /^20261122140304$/);

  assert.equal(courierCode('CJ', 'gmarket'), '10013');
  assert.equal(courierCode('LOTTE', 'auction'), '10008');
  assert.equal(courierCode('HANJIN', 'lotteon'), '0006');
  assert.equal(courierCode('KDEXP', 'gmarket'), null);
});

test('G마켓·옥션·롯데ON: 수집 → 알림 → 주문확인 → 발송처리', async (t) => {
  const mock = await startMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orderhub-esm-'));
  const app = createApp({
    ...baseConfig,
    dataDir: dir,
    dbFile: path.join(dir, 'test.db'),
    secretKey: 'unit-test-secret',
    adminPassword: '',
    publicUrl: 'https://shop.example.com',
    esmApiBase: mock.url,
    lotteonApiBase: mock.url,
    telegramApiBase: `${mock.url}/tg`,
    esmOrderIntervalMs: 0,
    disableScheduler: true,
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    app.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let cookie = '';
  async function call(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: { 'X-OrderHub': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status} ${data.error}`), { status: res.status });
    return data;
  }
  const byNo = async (no) => (await call('GET', `/api/orders?tab=all&q=${encodeURIComponent(no)}`)).orders.find((o) => o.order_no === String(no));
  const tg = () => mock.state.telegram.messages.map((m) => m.text);

  await call('POST', '/api/auth/setup', { password: 'secret1234' });
  await call('PUT', '/api/settings', { notify: { telegram: { enabled: true, botToken: 'TGTOKEN', chatId: '12345' }, webpush: { enabled: false } } });

  await t.test('연결 테스트: 잘못된 키는 친절한 오류, 올바른 키는 성공 + 진단정보', async () => {
    await assert.rejects(call('POST', '/api/stores/test', { type: 'gmarket', credentials: { masterId: ESM.masterId, sellerId: ESM.gmarketId, secretKey: 'wrong' } }), (e) => e.status === 400 && /G마켓 인증 실패/.test(e.message));
    await assert.rejects(call('POST', '/api/stores/test', { type: 'lotteon', credentials: { apiKey: 'wrong', trNo: LOTTEON.trNo } }), /롯데ON 인증 실패/);
    // 거래처번호가 다르면 알려줌
    await assert.rejects(call('POST', '/api/stores/test', { type: 'lotteon', credentials: { apiKey: LOTTEON.apiKey, trNo: 'LO99999999' } }), (e) => /거래처번호/.test(e.message));
    // 거래처번호 없이는 저장/테스트 불가
    await assert.rejects(call('POST', '/api/stores/test', { type: 'lotteon', credentials: { apiKey: LOTTEON.apiKey } }), (e) => e.status === 400 && /거래처번호/.test(e.message));
    const g = await call('POST', '/api/stores/test', { type: 'gmarket', credentials: { masterId: ESM.masterId, sellerId: ESM.gmarketId, secretKey: ESM.secretKey } });
    assert.match(g.message, /G마켓 연결 성공/);
    assert.match(g.diagnostic, /RequestOrders:\[\] \(0건\)/);
    // 롯데ON 방화벽이 Node 기본 요청을 막는 경우 → 일반 HTTP 요청으로 다시 시도해서 성공
    lotteon._internal.rawMode.clear();
    mock.state.lotteon.block = 'node';
    const viaRaw = await call('POST', '/api/stores/test', { type: 'lotteon', credentials: LOTTEON });
    assert.equal(viaRaw.ok, true);
    assert.ok(mock.state.lotteon.uas.some((u) => /OrderHub\//.test(u)));
    // IP 미등록처럼 모두 막히면 해결 방법과 원인 파악용 정보를 보여줌
    mock.state.lotteon.block = 'all';
    await assert.rejects(call('POST', '/api/stores/test', { type: 'lotteon', credentials: LOTTEON }), (e) => /롯데ON 접속 거부\(403\)/.test(e.message) && /직접입력/.test(e.message) && /server=nginx/.test(e.message));
    mock.state.lotteon.block = null;
    lotteon._internal.rawMode.clear();
    mock.state.lotteon.calls.orderBodies = [];
    const l = await call('POST', '/api/stores/test', { type: 'lotteon', credentials: LOTTEON });
    assert.match(l.message, /롯데ON 연결 성공/);
    assert.match(l.diagnostic, /orders: .*progress: /);
    // 일반 판매자 키로 막힌 주문정보 조회(getOrderList)는 쓰지 않고, 하루 이내 기간으로만 조회
    for (const b of mock.state.lotteon.calls.orderBodies) {
      assert.equal(b.trGrpCd, 'SR');
      assert.equal(b.trNo, LOTTEON.trNo);
      assert.ok(['', 'Y'].includes(b.ifCplYN));
    }
  });

  await t.test('스토어 연결 + 첫 수집 (유연한 필드 매칭으로 주문자 정보 채움)', async () => {
    esmAddOrder(mock.state, { orderNo: 3000000001, site: 'G', name: '최지마' });
    esmAddOrder(mock.state, { orderNo: 3000000002, site: 'A', name: '한옥션', product: '보온병' });
    lotteonAddItem(mock.state, { odNo: 'LO2026112200001', name: '정롯데' });
    await call('POST', '/api/stores', { type: 'gmarket', name: '내 G마켓', credentials: { masterId: ESM.masterId, sellerId: ESM.gmarketId, secretKey: ESM.secretKey } });
    await call('POST', '/api/stores', { type: 'auction', name: '내 옥션', credentials: { masterId: ESM.masterId, sellerId: ESM.auctionId, secretKey: ESM.secretKey } });
    await call('POST', '/api/stores', { type: 'lotteon', name: '내 롯데ON', credentials: LOTTEON });
    await call('POST', '/api/sync', {});
    const stores = (await call('GET', '/api/stores')).stores;
    for (const s of stores) assert.equal(s.lastError, null, `${s.name}: ${s.lastError}`);

    const g = await call('GET', `/api/orders/${(await byNo('3000000001')).id}`);
    assert.equal(g.store_type, 'gmarket');
    assert.equal(g.receiver_name, '최지마');
    assert.equal(g.receiver_phone, '010-5555-6666');
    assert.equal(g.zipcode, '04783');
    assert.match(g.address1, /왕십리로/);
    assert.equal(g.delivery_memo, '경비실에 맡겨주세요');
    assert.equal(g.items[0].option_name, '색상: 화이트');
    assert.equal(g.total_amount, 21000);
    assert.ok(g.ship_due);
    const a = await byNo('3000000002');
    assert.equal(a.store_type, 'auction');
    assert.equal(a.items[0].product_name, '보온병');
    const l = await call('GET', `/api/orders/${(await byNo('LO2026112200001')).id}`);
    assert.equal(l.receiver_name, '정롯데');
    assert.equal(l.address2, '파크원 타워1 20층');
    assert.equal(l.items[0].option_name, '블랙');
    assert.equal(l.items[0].market_state, 'NEW');
    // 옥션 스토어는 옥션(siteType 1)만, G마켓은 siteType 2만 조회
    assert.ok(mock.state.esm.calls.list.every((c) => (c.site === 'G' ? c.siteType === 2 : c.siteType === 1)));
  });

  await t.test('연결 테스트 진단정보에 주문 필드 이름이 보임', async () => {
    const stores = (await call('GET', '/api/stores')).stores;
    const g = await call('POST', `/api/stores/${stores.find((x) => x.type === 'gmarket').id}/test`, {});
    assert.match(g.diagnostic, /RequestOrders:\[\{OrderNo, PayNo, GroupNo/);
    const l = await call('POST', `/api/stores/${stores.find((x) => x.type === 'lotteon').id}/test`, {});
    assert.match(l.diagnostic, /orders: .*deliveryOrderList:\[\{odNo, procSeq, spdNo.*progress: .*odPrgsStepCd/);
  });

  await t.test('신규주문 알림', async () => {
    esmAddOrder(mock.state, { orderNo: 3000000003, site: 'G', name: '신지마', product: '블루투스 스피커' });
    lotteonAddItem(mock.state, { odNo: 'LO2026112200002', name: '신롯데', product: '텐트' });
    const before = tg().length;
    const r = await call('POST', '/api/sync', {});
    assert.equal(r.newOrders, 2);
    const texts = tg().slice(before).join('\n');
    assert.match(texts, /🛒 신규주문 · 내 G마켓[\s\S]*신지마/);
    assert.match(texts, /🛒 신규주문 · 내 롯데ON[\s\S]*신롯데/);
  });

  await t.test('G마켓: 발주완료(주문확인) → 송장 → 발송처리', async () => {
    const o = await byNo('3000000003');
    const p = await call('POST', '/api/orders/purchase', { ids: [o.id] });
    assert.equal(p.results[0].warning, null, p.results[0].warning);
    assert.deepEqual(mock.state.esm.calls.check, ['3000000003']);
    const r = await call('POST', `/api/orders/${o.id}/invoice`, { courierKey: 'CJ', trackingNo: '689012345678', dispatch: true });
    assert.equal(r.ok, true, r.message);
    assert.match(mock.state.esm.calls.ship.at(-1), /"OrderNo":3000000003,"ShippingDate":"\d{4}-\d{2}-\d{2}","DeliveryCompanyCode":10013,"InvoiceNo":"689012345678"/);
    assert.equal((await call('GET', `/api/orders/${o.id}`)).status, 'SHIPPED');
  });

  await t.test('옥션: 신규주문에서 바로 발송 → 자동 주문확인 후 롯데택배(10008)', async () => {
    const o = await byNo('3000000002');
    const r = await call('POST', `/api/orders/${o.id}/invoice`, { courierKey: 'LOTTE', trackingNo: '412345678901', dispatch: true });
    assert.equal(r.ok, true, r.message);
    assert.ok(mock.state.esm.calls.check.includes('3000000002'));
    assert.match(mock.state.esm.calls.ship.at(-1), /"DeliveryCompanyCode":10008/);
    // 다음 수집에서 배송중으로 보여도 발송완료 유지
    await call('POST', '/api/sync', {});
    assert.equal((await byNo('3000000002')).status, 'SHIPPED');
  });

  await t.test('롯데ON: 상품준비(12) → 발송완료(13) 통보', async () => {
    const o = await byNo('LO2026112200002');
    await call('POST', '/api/orders/purchase', { ids: [o.id] });
    const c = mock.state.lotteon.calls.inform.at(-1).deliveryProgressStateList[0];
    assert.equal(c.odPrgsStepCd, '12');
    // 배송상태 통보 필수값: 주문순번(배송상태 조회로 얻음)·상품번호·단품번호·수량
    assert.equal(c.dvRtrvDvsCd, 'DV');
    assert.equal(c.odSeq, '1');
    assert.equal(c.spdNo, 'LO100001');
    assert.equal(c.sitmNo, 'LO100001_1');
    assert.equal(c.slQty, '1');
    assert.equal(c.odNo, 'LO2026112200002');
    assert.match(c.dvTrcStatDttm, /^\d{14}$/);
    const r = await call('POST', `/api/orders/${o.id}/invoice`, { courierKey: 'HANJIN', trackingNo: '451234567890', dispatch: true });
    assert.equal(r.ok, true, r.message);
    const d = mock.state.lotteon.calls.inform.at(-1).deliveryProgressStateList[0];
    assert.equal(d.odPrgsStepCd, '13');
    assert.equal(d.dvCoCd, '0006');
    assert.equal(d.invcNo, '451234567890');
    assert.equal(d.invcNbr, '1');
    await call('POST', '/api/sync', {});
    assert.equal((await byNo('LO2026112200002')).status, 'SHIPPED');
  });

  await t.test('롯데ON: 샵모아 등이 이미 연동완료한 주문(ifCplYN=Y)도 수집 + 회수지시는 반품요청으로', async () => {
    lotteonAddItem(mock.state, { odNo: 'LO2026112200003', name: '연동완료', product: '의자', linked: true });
    await call('POST', '/api/sync', {});
    const o = await byNo('LO2026112200003');
    assert.ok(o, '연동완료 주문도 수집');
    assert.equal(o.status, 'NEW');
    mock.state.lotteon.items.get('LO2026112200003-1').returnInstructed = true;
    await call('POST', '/api/sync', {});
    const o2 = await byNo('LO2026112200003');
    assert.equal(o2.claim, 'RETURN');
    assert.equal((await call('GET', '/api/orders?tab=all&q=LO2026112200003')).orders.length, 1, '회수지시 행이 새 주문으로 생기지 않음');
  });

  await t.test('롯데ON 취소완료(21) 반영 + 알림', async () => {
    const it = mock.state.lotteon.items.get('LO2026112200001-1');
    it.step = '21';
    const before = tg().length;
    await call('POST', '/api/sync', {});
    assert.equal((await byNo('LO2026112200001')).status, 'CANCELED');
    assert.match(tg().slice(before).join('\n'), /🚫 주문취소 · 내 롯데ON/);
  });

  await t.test('G마켓: ESM PLUS 에서 직접 발송한 주문은 배송중으로 반영 (취소 오탐 없음)', async () => {
    esmAddOrder(mock.state, { orderNo: 3000000004, site: 'G', name: '직접발송' });
    await call('POST', '/api/sync', {});
    mock.state.esm.orders.get('3000000004').status = 3;
    await call('POST', '/api/sync', {});
    await call('POST', '/api/sync', {});
    const o = await byNo('3000000004');
    assert.equal(o.status, 'SHIPPED');
    assert.equal(o.claim, null);
  });

  await t.test('G마켓: 목록에서 사라진 주문은 2회 연속이면 취소 확인 필요 알림 → 취소로 표시', async () => {
    const o = await byNo('3000000001');
    mock.state.esm.orders.delete('3000000001'); // 고객 취소로 목록에서 사라짐
    const before = tg().length;
    await call('POST', '/api/sync', {});
    assert.equal((await byNo('3000000001')).claim, null, '한 번 사라진 것으로는 표시하지 않음');
    await call('POST', '/api/sync', {});
    const d = await byNo('3000000001');
    assert.equal(d.claim, 'CANCEL');
    assert.equal(d.status, 'NEW');
    assert.match(tg().slice(before).join('\n'), /⚠️ 취소요청 · 내 G마켓/);
    await call('POST', `/api/orders/${o.id}/cancel-local`, {});
    assert.equal((await byNo('3000000001')).status, 'CANCELED');
  });

  await t.test('지난 주문 불러오기: G마켓·옥션은 1~5단계를 7일씩, 롯데ON도 7일씩 나눠 조회', async () => {
    esmAddOrder(mock.state, { orderNo: 3000000009, site: 'A', name: '지난옥션', status: 5 }); // 구매결정완료된 지난 주문
    const listBefore = mock.state.esm.calls.list.length;
    const lotteBefore = mock.state.lotteon.calls.orders;
    await call('POST', '/api/sales/backfill', { days: 31 });
    let bf;
    for (let i = 0; i < 400; i++) {
      bf = (await call('GET', '/api/sales/backfill')).backfill;
      if (bf && !bf.running) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(bf && !bf.running);
    for (const r of bf.results) assert.equal(r.error, null, `${r.name}: ${r.error}`);
    const calls = mock.state.esm.calls.list.slice(listBefore);
    for (const site of ['G', 'A']) {
      const mine = calls.filter((c) => c.site === site && c.pageIndex === 1);
      assert.deepEqual([...new Set(mine.map((c) => c.orderStatus))].sort(), [1, 2, 3, 4, 5]);
      assert.equal(mine.filter((c) => c.orderStatus === 1).length, 5, '31일을 7일씩 5구간');
      for (const c of mine) assert.ok(c.requestDateFrom < c.requestDateTo);
    }
    // 롯데ON 출고지시 조회는 하루씩 (31일 → 32구간) × 신규/연동완료 2번
    assert.ok(mock.state.lotteon.calls.orders - lotteBefore >= 62, `롯데ON 조회 ${mock.state.lotteon.calls.orders - lotteBefore}번`);
    const o = await byNo('3000000009');
    assert.equal(o.status, 'DELIVERED');
    assert.equal(bf.results.find((r) => r.type === 'auction').added, 1);
  });

  await t.test('주문조회 5초 제한: 호출 간격을 지켜서 제한에 걸리지 않음', async () => {
    mock.state.esm.minIntervalMs = 250;
    app.config.esmOrderIntervalMs = 300;
    const stores = (await call('GET', '/api/stores')).stores;
    const g = stores.find((s) => s.type === 'gmarket');
    await call('POST', '/api/sync', { storeId: g.id });
    await call('POST', '/api/sync', { storeId: g.id });
    assert.equal(mock.state.esm.rateLimited, 0);
    assert.equal((await call('GET', '/api/stores')).stores.find((s) => s.id === g.id).lastError, null);
    // 다른 프로그램(샵모아 등)이 같은 판매자 ID로 방금 조회한 경우 → 잠시 후 다시 시도해서 성공
    await new Promise((r) => setTimeout(r, 400));
    mock.state.esm.lastCall.set(`G:${ESM.gmarketId}`, Date.now());
    await call('POST', '/api/sync', { storeId: g.id });
    assert.ok(mock.state.esm.rateLimited >= 1, '제한에 한 번 걸려야 함');
    assert.equal((await call('GET', '/api/stores')).stores.find((s) => s.id === g.id).lastError, null);
  });

  await t.test('문의 수집: G마켓·옥션 판매자 문의 + 롯데ON 상품 Q&A·판매자 문의', async () => {
    const kstDay = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const stamp = (d = new Date()) => new Date(d.getTime() + 9 * 3600000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    // 첫 문의 수집: 최근 30일을 7일씩 - G마켓은 qnaType 3, 옥션은 일반(1)·비밀글(2) 각각
    const g0 = mock.state.esm.calls.qna.filter((c) => c.site === 'G');
    assert.ok(g0.length >= 5 && g0.every((c) => c.qnaType === 3 && c.status === 1 && c.type === 1));
    const a0 = mock.state.esm.calls.qna.filter((c) => c.site === 'A');
    assert.deepEqual([...new Set(a0.map((c) => c.qnaType))].sort(), [1, 2]);
    assert.ok(a0.length >= 10);
    assert.ok(mock.state.lotteon.calls.qna.length >= 5 && mock.state.lotteon.calls.qna.every((c) => c.trGrpCd === 'SR' && c.trNo === LOTTEON.trNo && c.qnaStatCd === 'ALL' && c.rowsPerPage === 100));
    assert.ok(mock.state.lotteon.calls.sellerInquiry.length >= 5 && mock.state.lotteon.calls.sellerInquiry.every((c) => /^\d{8}$/.test(c.scStrtDt) && c.scStrtDt <= c.scEndDt));
    let stores = (await call('GET', '/api/stores')).stores;
    for (const st of stores) assert.equal(st.inquiryError, null, `${st.name}: ${st.inquiryError}`);

    const today = kstDay();
    mock.state.esm.qnas.push(
      { site: 'G', qnaType: 3, day: today, data: { messageNo: 504346613, informStatus: '미처리', contractType: '상품', title: '상품 문의입니다.', details: '사이즈 크게 나왔나요?', receiveDate: `${today}T09:28:00+09:00`, inquirerName: '박정희', siteGoodsNo: 'B123456789', token: 'tk' } },
      { site: 'A', qnaType: 2, day: today, data: { messageNo: 604000001, informStatus: '미처리', contractType: '배송', title: '배송 문의', details: '오늘 출발하나요?', receiveDate: `${today}T08:00:00+09:00`, inquirerName: '한옥션', orderNo: '3000000002', reAsking: false } },
      // 주문 없는 문의(옥션 "0") + 재문의
      { site: 'A', qnaType: 1, day: today, data: { messageNo: 604000003, informStatus: '미처리', contractType: '상품(성능/사이즈)', title: '사이즈', details: '[처리완료내역][문의번호: 604000000]지난번 문의\n[미처리][문의번호: 604000003]다시 여쭤봐요', receiveDate: `${today}T06:00:00+09:00`, inquirerName: '재문의', orderNo: '0', reAsking: true, answerDate: '0001-01-01T00:00:00+09:00' } },
      // 문서 표기(PascalCase)로 와도 처리
      { site: 'A', qnaType: 1, day: today, data: { MessageNo: 604000002, InformStatus: '처리완료', ContractType: '상품', Title: '재입고', Details: '언제 들어오나요', ReceiveDate: `${today} 07:00:00`, AnswerDate: `${today} 07:30:00` } }
    );
    mock.state.lotteon.qnas.push(
      { pdQnaNo: 'Q1', qstTypCd: 'PD', qnaStatCd: 'NPROC', spdNo: 'LO100001', sitmNo: 'LO100001_1', qstCnts: '사이즈 문의드려요', regDttm: stamp() },
      { pdQnaNo: 'Q0', qstTypCd: 'PD', qnaStatCd: 'CC_TCTL', spdNo: 'LO999999', qstCnts: '고객센터로 넘어간 문의', regDttm: stamp() }
    );
    mock.state.lotteon.sellerInquiries.push({ slrInqNo: 779, vocTypNm: '반품', slrInqProcStatCd: 'ANS', inqTtl: '반품 문의', inqCnts: '반품하려면?', odNo: 'LO2026112200001', pdNm: '캠핑 랜턴', ansCnts: '안내드립니다', accpDttm: stamp(), procDttm: stamp() });
    const before = tg().length;
    const r = await call('POST', '/api/sync', {});
    assert.equal(r.inquiries, 4, '새 미답변: G마켓 1 + 옥션 2 + 롯데ON 상품 Q&A 1');
    assert.match(tg().slice(before).join('\n'), /💬 새 문의 4건/, '4건 이상이면 한 번에 알림');

    const list = (await call('GET', '/api/inquiries?filter=all')).inquiries;
    const g = list.find((q) => q.store_type === 'gmarket');
    assert.equal(g.kind, 'product');
    assert.equal(g.title, '상품 문의입니다.');
    assert.equal(g.content, '사이즈 크게 나왔나요?');
    assert.equal(g.writer, '박정희');
    assert.doesNotMatch(g.product_name, /^상품번호/, '받은 주문의 상품명으로 표시');
    assert.equal(g.asked_at, `${today}T00:28:00.000Z`);
    const a2 = list.find((q) => q.title === '배송 문의');
    assert.equal(a2.store_type, 'auction');
    assert.equal(a2.category, '배송 · 비밀글');
    assert.ok(a2.order_id, '옥션 주문과 연결');
    assert.equal(a2.answered, 0);
    assert.equal(list.find((q) => q.title === '재입고').answered, 1);
    const re = list.find((q) => q.title === '사이즈');
    assert.equal(re.order_no, '', '옥션 주문번호 "0" 은 비움');
    assert.equal(re.category, '상품(성능/사이즈) · 재문의');
    assert.equal(re.kind, 'product');
    assert.equal(re.answered, 0);
    const lq = list.find((q) => q.store_type === 'lotteon' && q.content === '사이즈 문의드려요');
    assert.equal(lq.kind, 'product');
    assert.doesNotMatch(lq.product_name, /^상품번호/);
    const lc = list.find((q) => q.content === '고객센터로 넘어간 문의');
    assert.equal(lc.answered, 1);
    assert.equal(lc.category, '고객센터 이관');
    assert.equal(lc.product_name, '상품번호 LO999999');
    const ls = list.find((q) => q.title === '반품 문의');
    assert.equal(ls.kind, 'customer');
    assert.equal(ls.category, '반품');
    assert.equal(ls.answered, 1);
    assert.equal(ls.answer, '안내드립니다');
    assert.ok(ls.order_id, '롯데ON 주문과 연결');
    await assert.rejects(call('POST', `/api/inquiries/${lq.id}/answer`, { text: '답변' }), /셀러센터에서 답변/);

    // 롯데ON 판매자 문의 권한이 없어도 상품 Q&A 는 계속 수집, 스토어 화면에 안내
    const lotte = stores.find((x) => x.type === 'lotteon');
    mock.state.lotteon.denySellerInquiry = true;
    mock.state.lotteon.qnas.push({ pdQnaNo: 'Q2', qstTypCd: 'PD', qnaStatCd: 'NPROC', spdNo: 'LO100001', qstCnts: '두 번째 문의', regDttm: stamp() });
    const r2 = await call('POST', '/api/sync', { storeId: lotte.id });
    assert.equal(r2.inquiries, 1);
    stores = (await call('GET', '/api/stores')).stores;
    const l2 = stores.find((x) => x.id === lotte.id);
    assert.equal(l2.lastError, null);
    assert.match(l2.inquiryError, /판매자 문의 - 이 인증키로는 조회 권한이 없습니다\(403\)/);
    mock.state.lotteon.denySellerInquiry = false;
    await call('POST', '/api/sync', { storeId: lotte.id });
    assert.equal((await call('GET', '/api/stores')).stores.find((x) => x.id === lotte.id).inquiryError, null);

    // G마켓 문의에 오더허브에서 답변: 답변 직전에 다시 조회해서 받은 최신 토큰으로, 처리완료(2)
    assert.equal(list.find((q) => q.id === g.id).can_answer, true);
    const seqBefore = mock.state.esm.tokenSeq;
    await call('POST', `/api/inquiries/${g.id}/answer`, { text: '정사이즈로 나왔습니다. 감사합니다.' });
    const sent = mock.state.esm.calls.answers.at(-1);
    assert.equal(sent.site, 'G');
    assert.equal(sent.messageNo, '504346613');
    assert.equal(sent.answerStatus, 2);
    assert.equal(sent.title, 'RE: 상품 문의입니다.');
    assert.equal(sent.comments, '정사이즈로 나왔습니다. 감사합니다.');
    assert.ok(mock.state.esm.tokenSeq > seqBefore && sent.token === `tk-504346613-${mock.state.esm.tokenSeq}`, '최신 토큰');
    assert.equal((await call('GET', '/api/inquiries?filter=all')).inquiries.find((q) => q.id === g.id).answered, 1);
    await call('POST', '/api/sync', {});
    assert.equal((await call('GET', '/api/inquiries?filter=all')).inquiries.find((q) => q.id === g.id).answer, '정사이즈로 나왔습니다. 감사합니다.');

    // 옥션에서 답변하면 다음 수집 때 자동으로 답변 완료
    mock.state.esm.qnas[1].data.informStatus = '처리완료';
    await call('POST', '/api/sync', {});
    assert.equal((await call('GET', '/api/inquiries?filter=all')).inquiries.find((q) => q.id === a2.id).answered, 1);
  });
});
