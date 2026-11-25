'use strict';
// 전체 흐름 테스트: 가짜 마켓 서버 + 실제 앱 서버(HTTP API)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../src/config');
const { createApp } = require('../server');
const { setCachedPublicIp } = require('../src/publicip');
const { startMock, naverAddOrder, naverChange, coupangAddSheet, elevenAddOrder, NAVER, COUPANG, ELEVEN } = require('./mock-markets');

const BIG_BOX = '642538970006401429'; // JS Number 로는 정확히 표현 불가 (> 2^53)
const BIG_BOX2 = '642538970006401433';
const BIG_ORDER = '27000012345678901';

test('주문 수집 → 알림 → 발주 → 송장 → 발송처리 전체 흐름', async (t) => {
  const mock = await startMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orderhub-test-'));
  const app = createApp({
    ...baseConfig,
    dataDir: dir,
    dbFile: path.join(dir, 'test.db'),
    secretKey: 'unit-test-secret',
    adminPassword: '',
    publicUrl: 'https://shop.example.com',
    naverApiBase: `${mock.url}/external`,
    coupangApiBase: mock.url,
    elevenstApiBase: `${mock.url}/rest`,
    elevenstGapMs: 0,
    telegramApiBase: `${mock.url}/tg`,
    disableScheduler: true,
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    app.sync.stop();
    await new Promise((r) => server.close(r));
    await mock.close();
    app.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let cookie = '';
  async function call(method, p, body, { raw = false, headers = {} } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { 'X-OrderHub': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(`${method} ${p} → ${res.status} ${data.error}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  const orderByNo = async (no) => {
    const r = await call('GET', `/api/orders?tab=all&q=${encodeURIComponent(no)}`);
    return r.orders.find((o) => o.order_no === no || o.items.some((i) => i.order_no === no || i.item_key === no));
  };
  const tgTexts = () => mock.state.telegram.messages.map((m) => m.text);

  await t.test('인증: 최초 비밀번호 설정 / 보호된 API / CSRF', async () => {
    const st = await call('GET', '/api/auth/status');
    assert.equal(st.setupRequired, true);
    await assert.rejects(call('GET', '/api/orders'), (e) => e.status === 401);
    await call('POST', '/api/auth/setup', { password: 'secret1234' });
    assert.ok(cookie.startsWith('oh_session='));
    const st2 = await call('GET', '/api/auth/status');
    assert.equal(st2.loggedIn, true);
    // 커스텀 헤더 없는 POST 차단
    const res = await fetch(`${base}/api/sync`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
    // 두 번째 setup 불가
    await assert.rejects(call('POST', '/api/auth/setup', { password: 'other123' }), (e) => e.status === 400);
  });

  await t.test('알림 채널 설정 (텔레그램 + ntfy)', async () => {
    const det = await call('POST', '/api/notify/telegram/detect', { botToken: 'TGTOKEN' });
    assert.equal(det.chats[0].id, '12345');
    const r = await call('PUT', '/api/settings', {
      notify: { telegram: { enabled: true, botToken: 'TGTOKEN', chatId: '12345' }, ntfy: { enabled: true, server: `${mock.url}/ntfy`, topic: 'orderhub-test' }, webpush: { enabled: false } },
    });
    assert.equal(r.notify.telegram.hasBotToken, true);
    assert.ok(!JSON.stringify(r).includes('TGTOKEN'), '비밀값이 응답에 노출되면 안 됨');
    await call('POST', '/api/notify/test', { channel: 'telegram' });
    await call('POST', '/api/notify/test', { channel: 'ntfy' });
    assert.match(tgTexts().at(-1), /테스트 알림/);
    assert.equal(mock.state.ntfy.messages.at(-1).topic, 'orderhub-test');
  });

  await t.test('스토어 연결 테스트 + 등록 + 첫 수집(알림 없이 가져오기)', async () => {
    naverAddOrder(mock.state, { productOrderId: '2026112200000101', orderId: '2026112290000001', name: '홍길동' });
    naverAddOrder(mock.state, { productOrderId: '2026112200000102', orderId: '2026112290000002', name: '고길동' });
    naverAddOrder(mock.state, { productOrderId: '2026112200000103', orderId: '2026112290000003', name: '임꺽정' });
    coupangAddSheet(mock.state, { shipmentBoxId: BIG_BOX, orderId: BIG_ORDER, vendorItemId: '70000000001' });
    elevenAddOrder(mock.state, { ordNo: '202611220001', dlvNo: '9001' });

    // 잘못된 키 → 친절한 오류
    await assert.rejects(call('POST', '/api/stores/test', { type: 'coupang', credentials: { vendorId: COUPANG.vendorId, accessKey: COUPANG.accessKey, secretKey: 'wrong' } }), (e) => e.status === 400 && /쿠팡 인증 실패/.test(e.message));
    await assert.rejects(call('POST', '/api/stores/test', { type: 'naver', credentials: { clientId: NAVER.clientId } }), /시크릿/);

    const tn = await call('POST', '/api/stores/test', { type: 'naver', credentials: { clientId: NAVER.clientId, clientSecret: NAVER.secret } });
    assert.equal(tn.ok, true);
    const tc = await call('POST', '/api/stores/test', { type: 'coupang', credentials: COUPANG });
    assert.equal(tc.ok, true);
    // IP 미등록이면 11번가가 연결을 끊음 → 원인과 해결 방법 안내
    mock.state.eleven.reset = true;
    await assert.rejects(call('POST', '/api/stores/test', { type: 'elevenst', credentials: ELEVEN }), (e) => e.status === 400 && /11번가가 이 서버의 접속을 막았습니다/.test(e.message) && /상용서버 IP/.test(e.message));
    // 연결 테스트 실패 응답에는 단계별 진단 정보가 함께 옴
    const diagRes = await call('POST', '/api/stores/test', { type: 'elevenst', credentials: ELEVEN }, { raw: true });
    const diagBody = await diagRes.json();
    assert.equal(diagRes.status, 400);
    assert.match(diagBody.diagnostic, /대상: 127\.0\.0\.1/);
    assert.match(diagBody.diagnostic, /서버 연결\(TCP \d+\): 연결됨/);
    mock.state.eleven.reset = false;
    const te = await call('POST', '/api/stores/test', { type: 'elevenst', credentials: ELEVEN });
    assert.equal(te.ok, true);

    const before = tgTexts().length;
    await call('POST', '/api/stores', { type: 'naver', name: '내 스마트스토어', credentials: { clientId: NAVER.clientId, clientSecret: NAVER.secret } });
    await call('POST', '/api/stores', { type: 'coupang', name: '내 쿠팡', credentials: COUPANG });
    await call('POST', '/api/stores', { type: 'elevenst', name: '내 11번가', credentials: ELEVEN });
    await call('POST', '/api/sync', {});

    const stores = (await call('GET', '/api/stores')).stores;
    assert.equal(stores.length, 3);
    for (const s of stores) {
      assert.equal(s.lastError, null, `${s.name}: ${s.lastError}`);
      assert.ok(!JSON.stringify(s.credentials).includes(COUPANG.secretKey));
    }
    const counts = await call('GET', '/api/orders/counts');
    assert.equal(counts.new, 5);

    // 네이버 more 페이지(2건씩)도 모두 수집됐는지
    for (const no of ['2026112290000001', '2026112290000002', '2026112290000003']) assert.ok(await orderByNo(no), `naver ${no}`);
    // 쿠팡 큰 ID 정확히 보존
    const cp = await orderByNo(BIG_ORDER);
    assert.equal(cp.group_key, BIG_BOX);
    assert.equal(cp.items[0].item_key, `${BIG_BOX}-70000000001`);
    assert.equal(cp.receiver_name, '이쿠팡');
    assert.equal(cp.total_amount, 18900);
    // 11번가 EUC-KR 한글 정상 디코딩
    const el = await orderByNo('202611220001');
    assert.equal(el.receiver_name, '김십일');
    assert.equal(el.items[0].product_name, '무선 마우스');
    assert.equal(el.address2, '101동 202호');

    // 첫 수집으로 가져온 주문은 메뉴 숫자(안 본 신규주문)에 넣지 않음
    assert.equal((await call('GET', '/api/orders?tab=all')).unseen, 0);
    assert.equal((await call('GET', '/api/sync/status')).unseen, 0);

    // 첫 수집은 개별 신규주문 알림 없이 '연결 완료' 요약만
    const newTexts = tgTexts().slice(before);
    assert.ok(newTexts.some((x) => /연결 완료/.test(x)));
    assert.ok(!newTexts.some((x) => /🛒 신규주문/.test(x)));
  });

  await t.test('신규주문 수집 시 휴대폰 알림 (텔레그램·ntfy, 주문 링크 포함)', async () => {
    naverAddOrder(mock.state, { productOrderId: '2026112200000201', orderId: '2026112290000011', name: '신규자', product: '캠핑의자', option: '카키', amount: 45000 });
    coupangAddSheet(mock.state, { shipmentBoxId: BIG_BOX2, orderId: '27000012345679999', vendorItemId: '70000000002', name: '박쿠팡' });
    const before = mock.state.telegram.messages.length;
    const ntfyBefore = mock.state.ntfy.messages.length;
    const r = await call('POST', '/api/sync', {});
    assert.equal(r.newOrders, 2);
    const msgs = mock.state.telegram.messages.slice(before);
    const naverMsg = msgs.find((m) => /신규자/.test(m.text));
    assert.ok(naverMsg, '네이버 신규주문 텔레그램 알림');
    assert.match(naverMsg.text, /🛒 신규주문 · 내 스마트스토어/);
    assert.match(naverMsg.text, /캠핑의자 \(카키\) ×1/);
    assert.match(naverMsg.text, /45,000원/);
    assert.match(naverMsg.reply_markup.inline_keyboard[0][0].url, /^https:\/\/shop\.example\.com\/#\/order\/\d+$/);
    assert.ok(msgs.some((m) => /박쿠팡/.test(m.text)), '쿠팡 신규주문 알림');
    const nt = mock.state.ntfy.messages.slice(ntfyBefore);
    assert.equal(nt.length, 2);
    assert.match(nt[0].click, /^https:\/\/shop\.example\.com\/#\/order\/\d+$/);
    // 같은 주문을 다시 수집해도 중복 알림 없음
    const again = await call('POST', '/api/sync', {});
    assert.equal(again.newOrders, 0);

    // [주문] 메뉴 숫자 = 아직 확인하지 않은 신규주문. 클레임은 포함하지 않음
    assert.equal((await call('GET', '/api/sync/status')).unseen, 2);
    const listAll = await call('GET', '/api/orders?tab=all');
    assert.equal(listAll.unseen, 2);
    const fresh = listAll.orders.filter((o) => o.status === 'NEW' && !o.seen_at);
    assert.deepEqual(fresh.map((o) => o.receiver_name).sort(), ['박쿠팡', '신규자'].sort());
    // 주문 상세를 열면 그 주문만 확인
    const one = fresh.find((o) => o.receiver_name === '신규자');
    assert.equal((await call('POST', '/api/orders/seen', { ids: [one.id] })).unseen, 1);
    // 다른 스토어 목록만 본 경우에는 그 스토어 것만 확인
    const listNew = await call('GET', `/api/orders?tab=new&store=${one.store_id}`);
    assert.equal(listNew.unseenHere, 0);
    assert.equal((await call('POST', '/api/orders/seen', { upTo: listNew.maxId, store: one.store_id })).unseen, 1);
    // 신규주문 목록을 보면 그때까지 들어온 주문 모두 확인 → 0
    const listNew2 = await call('GET', '/api/orders?tab=new');
    assert.equal(listNew2.unseenHere, 1);
    assert.equal((await call('POST', '/api/orders/seen', { upTo: listNew2.maxId })).unseen, 0);
    assert.equal((await call('GET', '/api/sync/status')).unseen, 0);
  });

  await t.test('쿠팡: 발주완료 → 상품준비중(큰 ID 그대로 전송) → 송장 업로드', async () => {
    const o = await orderByNo(BIG_ORDER);
    const r = await call('POST', '/api/orders/purchase', { ids: [o.id], supplier: '도매꾹', supplierOrderNo: 'DMK-1', cost: 9000 });
    assert.equal(r.results[0].ok, true, r.results[0].message);
    assert.equal(r.results[0].warning, null);
    assert.ok(mock.state.coupang.calls.ack.at(-1).includes(`"shipmentBoxIds":[${BIG_BOX}]`), mock.state.coupang.calls.ack.at(-1));
    let d = await call('GET', `/api/orders/${o.id}`);
    assert.equal(d.status, 'PURCHASED');
    assert.equal(d.market_confirmed, 1);
    assert.equal(d.supplier, '도매꾹');
    assert.equal(d.cost, 9000);

    const inv = await call('POST', `/api/orders/${o.id}/invoice`, { courierKey: 'LOTTE', trackingNo: '2345-6789-0123', dispatch: true });
    assert.equal(inv.ok, true, inv.message);
    const body = mock.state.coupang.calls.invoices.at(-1);
    assert.ok(body.includes(`"shipmentBoxId":${BIG_BOX},"orderId":${BIG_ORDER},"vendorItemId":70000000001,"deliveryCompanyCode":"HYUNDAI","invoiceNumber":"234567890123"`), body);
    d = await call('GET', `/api/orders/${o.id}`);
    assert.equal(d.status, 'SHIPPED');
    assert.equal(d.tracking_no, '234567890123');
    assert.match(d.trackingUrl, /search\.naver\.com/);
    // 다음 수집에서 쿠팡이 DEPARTURE 로 알려줘도 발송완료 유지
    await call('POST', '/api/sync', {});
    d = await call('GET', `/api/orders/${o.id}`);
    assert.equal(d.status, 'SHIPPED');
  });

  await t.test('네이버: 신규주문에서 바로 송장 입력 → 자동 발주확인 후 발송처리', async () => {
    const o = await orderByNo('2026112290000001');
    const inv = await call('POST', `/api/orders/${o.id}/invoice`, { courierKey: 'CJ', trackingNo: '510012345678', dispatch: true });
    assert.equal(inv.ok, true, inv.message);
    assert.deepEqual(mock.state.naver.calls.confirm.at(-1).productOrderIds, ['2026112200000101']);
    const dp = mock.state.naver.calls.dispatch.at(-1).dispatchProductOrders[0];
    assert.equal(dp.productOrderId, '2026112200000101');
    assert.equal(dp.deliveryCompanyCode, 'CJGLS');
    assert.equal(dp.trackingNumber, '510012345678');
    assert.equal(dp.deliveryMethod, 'DELIVERY');
    const d = await call('GET', `/api/orders/${o.id}`);
    assert.equal(d.status, 'SHIPPED');
    assert.ok(d.events.some((e) => /발송처리 완료/.test(e.message)));
  });

  await t.test('발송처리 실패 시 송장입력 상태로 남고 오류 표시', async () => {
    const o = await orderByNo('2026112290000002');
    await call('POST', '/api/orders/purchase', { ids: [o.id] });
    const inv = await call('POST', `/api/orders/${o.id}/invoice`, { courierKey: 'CJ', trackingNo: '00012345678', dispatch: true });
    assert.equal(inv.ok, false);
    assert.match(inv.message, /비유효 송장/);
    const d = await call('GET', `/api/orders/${o.id}`);
    assert.equal(d.status, 'INVOICED');
    assert.match(d.dispatch_error, /비유효 송장/);
    // 지원하지 않는 택배사는 서버에서 차단
    await assert.rejects(call('POST', `/api/orders/${o.id}/invoice`, { courierKey: 'CHUNIL', trackingNo: '123456789', dispatch: false }).then(() => call('POST', `/api/orders/${o.id}/invoice`, { courierKey: 'NOPE', trackingNo: '123456789' })), /지원하지 않는/);
  });

  await t.test('발주 후 구매자 취소요청 → 긴급 알림', async () => {
    const o = await orderByNo('2026112290000003');
    await call('POST', '/api/orders/purchase', { ids: [o.id] });
    const d0 = mock.state.naver.orders.get('2026112200000103');
    d0.productOrder.claimType = 'CANCEL';
    d0.productOrder.claimStatus = 'CANCEL_REQUEST';
    naverChange(mock.state, '2026112200000103');
    const before = mock.state.telegram.messages.length;
    const r = await call('POST', '/api/sync', {});
    assert.equal(r.claims, 1);
    const msg = mock.state.telegram.messages.slice(before).map((m) => m.text).join('\n');
    assert.match(msg, /⚠️ 취소요청/);
    assert.match(msg, /이미 발주한 주문/);
    const counts = await call('GET', '/api/orders/counts');
    assert.equal(counts.claimOpen, 1);
    // 취소 완료되면 취소 상태로
    d0.productOrder.productOrderStatus = 'CANCELED';
    d0.productOrder.claimStatus = 'CANCEL_DONE';
    naverChange(mock.state, '2026112200000103');
    const before2 = mock.state.telegram.messages.length;
    await call('POST', '/api/sync', {});
    const d = await call('GET', `/api/orders/${o.id}`);
    assert.equal(d.status, 'CANCELED');
    assert.match(mock.state.telegram.messages.slice(before2).map((m) => m.text).join('\n'), /🚫 주문취소[\s\S]*공급처 주문도 취소/);
  });

  await t.test('발주 전 배송지 변경 감지', async () => {
    const o = await orderByNo('2026112290000011');
    await call('POST', '/api/orders/purchase', { ids: [o.id] });
    const d0 = mock.state.naver.orders.get('2026112200000201');
    d0.productOrder.shippingAddress = { ...d0.productOrder.shippingAddress, baseAddress: '부산광역시 해운대구 센텀중앙로 79', detailedAddress: '1203호' };
    naverChange(mock.state, '2026112200000201');
    const before = mock.state.telegram.messages.length;
    await call('POST', '/api/sync', {});
    const d = await call('GET', `/api/orders/${o.id}`);
    assert.equal(d.address_changed, 1);
    assert.equal(d.address1, '부산광역시 해운대구 센텀중앙로 79');
    assert.match(mock.state.telegram.messages.slice(before).map((m) => m.text).join('\n'), /📍 배송지 변경/);
    await call('POST', `/api/orders/${o.id}/update`, { clearAddressChanged: true });
    assert.equal((await call('GET', `/api/orders/${o.id}`)).address_changed, 0);
  });

  await t.test('쿠팡: 결제완료 목록에서 사라진 주문(고객 취소)은 단건 조회로 취소 반영', async () => {
    const sheet = mock.state.coupang.sheets.get(BIG_BOX2);
    sheet.status = 'CANCELED_BY_BUYER'; // 목록 조회에는 더 이상 안 나옴
    sheet.orderItems[0].cancelCount = 1;
    await call('POST', '/api/sync', {});
    assert.ok(mock.state.coupang.calls.single.includes(BIG_BOX2));
    const o = await orderByNo('27000012345679999');
    assert.equal(o.status, 'CANCELED');
  });

  await t.test('11번가: 발주확인(reqpackaging) → 발송처리(reqdelivery)', async () => {
    const o = await orderByNo('202611220001');
    const r = await call('POST', '/api/orders/purchase', { ids: [o.id] });
    assert.equal(r.results[0].warning, null, r.results[0].warning);
    assert.deepEqual(mock.state.eleven.calls.pack.at(-1), { ordNo: '202611220001', seq: '1', addYn: 'N', addNo: 'null', dlvNo: '9001' });
    const inv = await call('POST', `/api/orders/${o.id}/invoice`, { courierKey: 'CJ', trackingNo: '622233334444', dispatch: true });
    assert.equal(inv.ok, true, inv.message);
    const dl = mock.state.eleven.calls.deliver.at(-1);
    assert.equal(dl.etprs, '00034');
    assert.equal(dl.invc, '622233334444');
    assert.equal(dl.dlvNo, '9001');
    assert.equal((await call('GET', `/api/orders/${o.id}`)).status, 'SHIPPED');
  });

  await t.test('송장 일괄등록 (엑셀 붙여넣기) + 발송처리', async () => {
    naverAddOrder(mock.state, { productOrderId: '2026112200000301', orderId: '2026112290000021', name: '일괄이' });
    await call('POST', '/api/sync', {});
    const o = await orderByNo('2026112290000021');
    await call('POST', '/api/orders/purchase', { ids: [o.id] });
    const r = await call('POST', '/api/orders/invoices/bulk', {
      rows: [
        { orderNo: '2026112290000021', courier: '한진택배', trackingNo: '410012345678' },
        { orderNo: '없는주문번호', courier: 'CJ', trackingNo: '123456789' },
      ],
      dispatch: true,
    });
    assert.equal(r.report.find((x) => x.orderNo === '2026112290000021').ok, true);
    assert.equal(r.report.find((x) => x.orderNo === '없는주문번호').ok, false);
    assert.equal(mock.state.naver.calls.dispatch.at(-1).dispatchProductOrders[0].deliveryCompanyCode, 'HANJIN');
    assert.equal((await call('GET', `/api/orders/${o.id}`)).status, 'SHIPPED');
  });

  await t.test('고객 문의 수집 → 알림 → 오더허브에서 답변', async () => {
    const kst = new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00');
    mock.state.naver.inquiries.push({ inquiryNo: 5001, category: '배송', title: '언제 오나요', inquiryContent: '주말 전에 받을 수 있을까요?', inquiryRegistrationDateTime: kst, answered: false, orderId: '2026112290000021', productName: '블루투스 이어폰', customerName: '일괄이' });
    mock.state.naver.qnas.push({ questionId: 7001, question: '화이트 재입고 되나요?', answered: false, productId: 1, productName: '블루투스 이어폰', maskedWriterId: 'abc***', createDate: kst });
    mock.state.coupang.inquiries.push({ inquiryId: 9001, content: '사이즈가 어떻게 되나요?', inquiryAt: '2026-11-22 10:00:00', sellerProductName: '스테인리스 텀블러', commentDtoList: [] });
    const before = mock.state.telegram.messages.length;
    const r = await call('POST', '/api/sync', {});
    assert.equal(r.inquiries, 3);
    const texts = mock.state.telegram.messages.slice(before).map((m) => m.text).join('\n');
    assert.match(texts, /💬 고객문의 · 내 스마트스토어[\s\S]*\[배송\] 언제 오나요 — 일괄이/);
    assert.match(texts, /💬 상품문의 · 내 스마트스토어/);
    assert.match(texts, /💬 상품문의 · 내 쿠팡/);
    let list = await call('GET', '/api/inquiries?filter=open');
    assert.equal(list.counts.open, 3);
    const naverQ = list.inquiries.find((q) => q.title === '언제 오나요');
    assert.ok(naverQ.order_id, '주문과 연결');
    const status = await call('GET', '/api/sync/status');
    assert.equal(status.inquiriesOpen, 3);
    // 같은 문의 재수집 시 중복 알림 없음
    assert.equal((await call('POST', '/api/sync', {})).inquiries, 0);

    await call('POST', `/api/inquiries/${naverQ.id}/answer`, { text: '내일 출고 예정입니다. 감사합니다.' });
    assert.deepEqual(mock.state.naver.calls.answers.at(-1), { inquiryNo: '5001', answerComment: '내일 출고 예정입니다. 감사합니다.' });
    const qna = list.inquiries.find((q) => q.content === '화이트 재입고 되나요?');
    await call('POST', `/api/inquiries/${qna.id}/answer`, { text: '다음 주 입고됩니다.' });
    assert.deepEqual(mock.state.naver.calls.qnaAnswers.at(-1), { questionId: '7001', commentContent: '다음 주 입고됩니다.' });
    const cq = list.inquiries.find((q) => q.store_type === 'coupang');
    // 쿠팡은 Wing 로그인 아이디(답변자)가 있어야 답변 가능
    await assert.rejects(call('POST', `/api/inquiries/${cq.id}/answer`, { text: '답변' }), /Wing 로그인 아이디/);
    await assert.rejects(call('POST', `/api/inquiries/${naverQ.id}/answer`, { text: '  ' }), /답변 내용/);
    list = await call('GET', '/api/inquiries?filter=open');
    assert.equal(list.counts.open, 1);
    // 다음 수집에서도 답변완료 유지
    await call('POST', '/api/sync', {});
    assert.equal((await call('GET', '/api/inquiries?filter=open')).counts.open, 1);

    // 문의 API 권한이 없어도 주문 수집은 정상
    mock.state.naver.failInquiries = true;
    naverAddOrder(mock.state, { productOrderId: '2026112200000501', orderId: '2026112290000041', name: '권한없음' });
    const r2 = await call('POST', '/api/sync', {});
    assert.equal(r2.errors, 0);
    assert.ok(await orderByNo('2026112290000041'));
    const ev = await call('GET', '/api/events?limit=30');
    assert.ok(ev.events.some((e) => /문의 수집 실패 \(주문 수집은 정상\)/.test(e.message)));
    mock.state.naver.failInquiries = false;
  });

  await t.test('11번가 상품 Q&A · 쿠팡 고객센터 문의 수집 + 오더허브에서 답변', async () => {
    const kstDay = (ms = 0) => new Date(Date.now() + 9 * 3600000 - ms).toISOString().slice(0, 10);
    // 11번가 첫 문의 수집은 최근 30일을 7일(YYYYMMDD)씩 5번, 0건이면 '조회된 데이터가 없습니다' 결과도 오류 아님
    const first = mock.state.eleven.calls.qna.slice(0, 5);
    assert.equal(first.length, 5);
    for (const c of first) assert.ok(/^\d{8}$/.test(c.s) && c.s <= c.e && c.st === '00');
    const stores = (await call('GET', '/api/stores')).stores;
    const eleven = stores.find((s) => s.type === 'elevenst');
    const coupang = stores.find((s) => s.type === 'coupang');
    assert.equal(eleven.inquiryError, null);
    assert.equal(coupang.inquiryError, null);

    mock.state.eleven.qnas.push(
      { brdInfoNo: '880001', prdNo: '5550001', prdNm: '무선 마우스', brdInfoSbjct: '출발 문의', brdInfoCont: '언제 출발하나요?<br/>급해요 &amp; 감사합니다', qnaDtlsCdNm: '배송', memNM: 'kim***', createDt: `${kstDay()} 09:30:00`, answerYn: 'N', ordNoDe: '202611220001' },
      { brdInfoNo: '880002', prdNo: '5550001', prdNm: '무선 마우스', brdInfoSbjct: '색상', brdInfoCont: '화이트 있나요?', qnaDtlsCdNm: '상품', memNM: 'lee***', createDt: `${kstDay(86400000)} 10:00:00`, answerYn: 'Y', answerCont: '네 있습니다' }
    );
    mock.state.coupang.callCenter.push(
      {
        inquiryId: 71001,
        _status: 'NO_ANSWER',
        csPartnerCounselingStatus: 'requestAnswer',
        receiptCategory: '배송문의>배송지연',
        content: '배송이 늦어요',
        itemName: '방한 장갑',
        vendorItemId: [3000000001],
        inquiryAt: `${kstDay()}T08:00:00.123456+09:00`,
        orderId: 30000000001,
        replies: [{ answerId: 11, parentAnswerId: null, answerType: 'csAgent', receptionistName: '상담원', partnerTransferStatus: 'requestAnswer', needAnswer: true, content: '판매자님 출고일 확인 부탁드립니다' }],
      },
      { inquiryId: 71002, _status: 'ANSWER', csPartnerCounselingStatus: 'answered', receiptCategory: '교환', content: '교환하고 싶어요', inquiryAt: `${kstDay()} 07:00:00`, replies: [{ answerId: 21, answerType: 'csAgent', partnerTransferStatus: 'requestAnswer', needAnswer: true, content: '확인 부탁드립니다' }, { answerId: 22, answerType: 'vendor', needAnswer: false, content: '교환 접수했습니다' }] },
      // 상담원이 답변을 요청한 글이 없는 이관 문의 → Wing에서 확인
      { inquiryId: 71003, _status: 'TRANSFER', receiptCategory: '기타', content: '단순 확인 요청', inquiryAt: `${kstDay()} 06:00:00`, replies: [{ answerId: 31, answerType: 'csAgent', partnerTransferStatus: 'complete', needAnswer: false, content: '참고 바랍니다' }] }
    );
    const before = mock.state.telegram.messages.length;
    const r = await call('POST', '/api/sync', {});
    assert.equal(r.inquiries, 3, '새 미답변: 11번가 1 + 쿠팡 고객센터 2');
    const texts = mock.state.telegram.messages.slice(before).map((m) => m.text).join('\n');
    assert.match(texts, /💬 상품문의 · 내 11번가[\s\S]*\[배송\] 출발 문의 — kim\*\*\*/);
    assert.match(texts, /💬 고객문의 · 내 쿠팡[\s\S]*\[고객센터 · 배송문의 > 배송지연\] 배송이 늦어요/);
    // 고객센터 문의는 전체(NONE) + 답변완료(ANSWER) 목록을 비교해서 답변 여부 판단
    const ccStatuses = new Set(mock.state.coupang.calls.callCenter.map((c) => c.partnerCounselingStatus));
    assert.ok(ccStatuses.has('NONE') && ccStatuses.has('ANSWER'));

    const all = (await call('GET', '/api/inquiries?filter=all')).inquiries;
    const q1 = all.find((q) => q.title === '출발 문의');
    assert.equal(q1.store_type, 'elevenst');
    assert.equal(q1.kind, 'product');
    assert.equal(q1.content, '언제 출발하나요?\n급해요 & 감사합니다', 'HTML 정리 + EUC-KR');
    assert.equal(q1.product_name, '무선 마우스');
    assert.ok(q1.order_id, '11번가 주문과 연결');
    assert.equal(q1.answered, 0);
    const q2 = all.find((q) => q.title === '색상');
    assert.equal(q2.answered, 1);
    assert.equal(q2.answer, '네 있습니다');
    const c1 = all.find((q) => q.content.startsWith('배송이 늦어요'));
    assert.equal(c1.content, '배송이 늦어요\n\n[쿠팡 상담원] 판매자님 출고일 확인 부탁드립니다');
    assert.equal(c1.category, '고객센터 · 배송문의 > 배송지연');
    assert.equal(c1.product_name, '방한 장갑');
    assert.equal(c1.answered, 0);
    assert.equal(c1.asked_at, new Date(`${kstDay()}T08:00:00.123+09:00`).toISOString(), '소수점 6자리 시각도 읽음');
    const c2 = all.find((q) => q.content.startsWith('교환하고 싶어요'));
    assert.equal(c2.answered, 1);
    assert.equal(c2.answer, '교환 접수했습니다');

    // 스토어별 보기: 문의를 가져오는 스토어 목록 + 미답변 수
    const per = await call('GET', `/api/inquiries?filter=open&store=${eleven.id}`);
    assert.ok(per.inquiries.length >= 1 && per.inquiries.every((q) => q.store_id === eleven.id));
    assert.equal(per.stores.find((s) => s.id === eleven.id).open, per.counts.open);
    assert.ok(per.total.open >= per.counts.open);

    // 11번가: 오더허브에서 답변 → EUC-KR XML 로 PUT (EUC-KR 에 없는 글자·이모지는 문자참조)
    assert.equal(q1.can_answer, true);
    const elevenText = '오늘 출발합니다 😊 똠얌꿍 <특가> & 감사합니다\n좋은 하루 되세요';
    await call('POST', `/api/inquiries/${q1.id}/answer`, { text: elevenText });
    const sent = mock.state.eleven.calls.answers.at(-1);
    assert.equal(sent.brdInfoNo, '880001');
    assert.equal(sent.prdNo, '5550001');
    assert.equal(sent.text, elevenText);
    assert.ok(sent.bytes.includes(Buffer.from('bfc0b4c3', 'hex')), "'오늘' 이 EUC-KR 바이트로");
    assert.ok(sent.bytes.includes(Buffer.from('&#128522;')) && sent.bytes.includes(Buffer.from(`&#${'똠'.codePointAt(0)};`)), '이모지·똠 은 문자참조');
    assert.ok(sent.bytes.includes(Buffer.from('&lt;')) && sent.bytes.includes(Buffer.from('&amp;')), 'XML 특수문자 이스케이프');
    let after = (await call('GET', '/api/inquiries?filter=all')).inquiries.find((q) => q.id === q1.id);
    assert.equal(after.answered, 1);
    assert.equal(after.answer, elevenText);

    // 쿠팡: Wing 아이디가 없으면 이유를 보여주고, [키 변경]에서 Wing 아이디만 넣으면 답변 가능
    let cc = (await call('GET', '/api/inquiries?filter=open')).inquiries.find((q) => q.id === c1.id);
    assert.equal(cc.can_answer, false);
    assert.match(cc.answer_hint, /Wing 로그인 아이디/);
    await call('PUT', `/api/stores/${coupang.id}`, { credentials: { wingId: 'wing-seller' } });
    const kept = (await call('GET', '/api/stores')).stores.find((s) => s.id === coupang.id);
    assert.ok(kept.credentials.accessKey && kept.credentials.secretKey, '다른 키는 그대로');
    const open = (await call('GET', '/api/inquiries?filter=open')).inquiries;
    cc = open.find((q) => q.id === c1.id);
    assert.equal(cc.can_answer, true);
    // 상담원 요청글이 없는 이관 문의는 Wing에서 → '답변 완료로 표시'
    const c3 = open.find((q) => q.content.startsWith('단순 확인 요청'));
    assert.equal(c3.can_answer, false);
    assert.match(c3.answer_hint, /Wing에서 확인/);
    await assert.rejects(call('POST', `/api/inquiries/${c3.id}/answer`, { text: '확인했습니다' }), /Wing에서 확인/);
    await call('POST', `/api/inquiries/${c3.id}/done`, {});

    // 고객센터 문의 답변: 2~1,000자, inquiryId·parentAnswerId 는 숫자, 답변자는 Wing 아이디
    await assert.rejects(call('POST', `/api/inquiries/${c1.id}/answer`, { text: '네' }), /2~1,000자/);
    await call('POST', `/api/inquiries/${c1.id}/answer`, { text: '오늘 출고됩니다. 죄송합니다.' });
    const ccReply = mock.state.coupang.calls.replies.at(-1);
    assert.equal(ccReply.kind, 'callCenter');
    assert.deepEqual(ccReply.body, { vendorId: COUPANG.vendorId, inquiryId: 71001, content: '오늘 출고됩니다. 죄송합니다.', replyBy: 'wing-seller', parentAnswerId: 11 });
    // 상품 문의 답변
    const online = open.find((q) => q.store_type === 'coupang' && q.kind === 'product');
    assert.equal(online.can_answer, true);
    await call('POST', `/api/inquiries/${online.id}/answer`, { text: '프리사이즈입니다.' });
    assert.deepEqual(mock.state.coupang.calls.replies.at(-1), { kind: 'online', id: '9001', body: { content: '프리사이즈입니다.', vendorId: COUPANG.vendorId, replyBy: 'wing-seller' } });

    // 다음 수집에도 답변 완료 유지 + 쿠팡의 답변 내용으로
    await call('POST', '/api/sync', {});
    const all2 = (await call('GET', '/api/inquiries?filter=all')).inquiries;
    assert.equal(all2.find((q) => q.id === c1.id).answered, 1);
    assert.equal(all2.find((q) => q.id === c1.id).answer, '오늘 출고됩니다. 죄송합니다.');
    assert.equal(all2.find((q) => q.id === c3.id).answered, 1, '직접 표시한 답변 완료 유지');
    assert.equal(all2.find((q) => q.id === online.id).answered, 1);
  });

  await t.test('CSV 내보내기', async () => {
    const res = await call('GET', '/api/orders/export.csv?tab=all', null, { raw: true });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], '엑셀용 UTF-8 BOM');
    const text = buf.toString('utf8');
    assert.ok(text.startsWith('\uFEFF마켓,스토어,주문번호'));
    assert.ok(text.includes('김십일'));
    assert.ok(text.includes(`"=""${BIG_ORDER}"""`));
  });

  await t.test('직접발송: 스마트스토어 직접전달 · 쿠팡 업체직송 (송장번호 없이)', async () => {
    naverAddOrder(mock.state, { productOrderId: '2026112400000901', orderId: '2026112490000901', name: '직접받음' });
    coupangAddSheet(mock.state, { shipmentBoxId: '700000000901', orderId: '9200000901', vendorItemId: '901', name: '업체직송' });
    await call('POST', '/api/sync', {});
    // 스마트스토어: 직접전달 = 배송방법만, 택배사·송장 없음
    const nv = await orderByNo('2026112490000901');
    const r1 = await call('POST', `/api/orders/${nv.id}/invoice`, { courierKey: 'DIRECT', trackingNo: '', dispatch: true });
    assert.equal(r1.ok, true, r1.message);
    const d = mock.state.naver.calls.dispatch.at(-1).dispatchProductOrders[0];
    assert.equal(d.deliveryMethod, 'DIRECT_DELIVERY');
    assert.equal(d.deliveryCompanyCode, undefined);
    assert.equal(d.trackingNumber, undefined);
    assert.equal((await orderByNo('2026112490000901')).status, 'SHIPPED');
    const detail = await call('GET', `/api/orders/${nv.id}`);
    assert.equal(detail.trackingUrl, '', '직접발송은 배송조회 링크 없음');
    // 쿠팡: 업체직송(DIRECT), 송장번호를 비우면 주문번호로 등록 (발주확인은 자동으로 먼저)
    const cp = await orderByNo('9200000901');
    const r2 = await call('POST', `/api/orders/${cp.id}/invoice`, { courierKey: 'DIRECT', trackingNo: '', dispatch: true });
    assert.equal(r2.ok, true, r2.message);
    assert.match(mock.state.coupang.calls.invoices.at(-1), /"deliveryCompanyCode":"DIRECT","invoiceNumber":"9200000901"/);
    assert.equal((await orderByNo('9200000901')).status, 'SHIPPED');
    // 11번가는 직접발송을 지원하지 않음 → 안내
    const el = (await call('GET', '/api/orders?tab=all&q=202611220001')).orders[0];
    if (el && ['NEW', 'PURCHASED', 'INVOICED'].includes(el.status)) {
      await assert.rejects(call('POST', `/api/orders/${el.id}/invoice`, { courierKey: 'DIRECT', trackingNo: '' }), (e) => e.status === 400 && /직접발송/.test(e.message));
    }
    // 택배사는 고르고 송장번호를 비우면 여전히 오류
    const meta = await call('GET', '/api/meta');
    const direct = meta.couriers.find((c) => c.key === 'DIRECT');
    assert.equal(direct.noTracking, true);
    assert.equal(direct.labels.coupang, '업체직송 (송장번호 없이)');
    assert.equal(direct.naver, true);
    assert.equal(direct.elevenst, false);
  });

  await t.test('취소·반품 요청 → 오더허브에서 취소 승인 · 반품 완료 (스마트스토어·쿠팡)', async () => {
    const meta = await call('GET', '/api/meta');
    const flag = (t) => meta.connectors.find((c) => c.type === t).claims;
    assert.deepEqual([flag('naver'), flag('coupang'), flag('elevenst')], [true, true, false]);

    // 스마트스토어: 발주확인 뒤 취소요청 / 배송완료 뒤 반품요청(아직 수거 전)
    naverAddOrder(mock.state, { productOrderId: '2026112500000901', orderId: '2026112590000901', name: '취소고객', place: 'OK' });
    naverAddOrder(mock.state, { productOrderId: '2026112500000902', orderId: '2026112590000902', name: '반품고객', status: 'DELIVERED', place: 'OK', claimType: 'RETURN', claimStatus: 'RETURN_REQUEST' });
    // 쿠팡: 상품준비중 주문
    coupangAddSheet(mock.state, { shipmentBoxId: '700000000911', orderId: '9200000911', vendorItemId: '911', name: '출고중지', status: 'INSTRUCT' });
    await call('POST', '/api/sync', {});
    const nc = mock.state.naver.orders.get('2026112500000901').productOrder;
    nc.claimType = 'CANCEL';
    nc.claimStatus = 'CANCEL_REQUEST';
    naverChange(mock.state, '2026112500000901');
    // 쿠팡 출고중지요청(상품준비중에서 고객 취소) + 발송한 주문(BIG_BOX)의 반품접수 - 큰 숫자 ID
    mock.state.coupang.sheets.get('700000000911').orderItems[0].holdCountForCancel = 1;
    mock.state.coupang.returns.push(
      { receiptId: '#600000000000000911', orderId: '#9200000911', receiptType: 'CANCEL', receiptStatus: 'RELEASE_STOP_UNCHECKED', createdAt: '2026-11-25T10:00:00', cancelCountSum: 1, returnItems: [{ vendorItemId: '#911', vendorItemName: '스테인리스 텀블러, 실버', cancelCount: 1, purchaseCount: 1, shipmentBoxId: '#700000000911' }] },
      { receiptId: '#600000000000000912', orderId: `#${BIG_ORDER}`, receiptType: 'RETURN', receiptStatus: 'RETURNS_UNCHECKED', createdAt: '2026-11-25T11:00:00', cancelCountSum: 1, returnItems: [{ vendorItemId: '#70000000001', vendorItemName: '스테인리스 텀블러, 실버', cancelCount: 1, purchaseCount: 1, shipmentBoxId: `#${BIG_BOX}` }] }
    );
    await call('POST', '/api/sync', {});
    const lists = mock.state.coupang.calls.returnLists;
    assert.ok(['RU', 'UC', 'PR'].every((s) => lists.some((l) => l.status === s && l.cancelType === 'RETURN')), '출고중지·반품접수·쿠팡확인요청 목록 조회');

    const nCancel = await orderByNo('2026112590000901');
    const nReturn = await orderByNo('2026112590000902');
    const cCancel = await orderByNo('9200000911');
    const cReturn = await orderByNo(BIG_ORDER);
    assert.equal(nCancel.claim, 'CANCEL');
    assert.equal(nReturn.claim, 'RETURN');
    assert.equal(cCancel.claim, 'CANCEL');
    assert.equal(cReturn.claim, 'RETURN', '쿠팡 반품접수를 발송한 주문에 표시');
    assert.match((await call('GET', `/api/orders/${cReturn.id}`)).items[0].market_status, /반품접수/);
    const claimTab = (await call('GET', '/api/orders?tab=claim')).orders.map((o) => o.id);
    for (const o of [nCancel, nReturn, cCancel, cReturn]) assert.ok(claimTab.includes(o.id));

    // 스마트스토어 취소 승인 → 바로 취소완료
    let r = await call('POST', `/api/orders/${nCancel.id}/claim`, { type: 'CANCEL' });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(mock.state.naver.calls.claimApprove.at(-1), { productOrderId: '2026112500000901', kind: 'cancel', raw: '{}' });
    assert.equal((await call('GET', `/api/orders/${nCancel.id}`)).status, 'CANCELED');

    // 스마트스토어 반품: 수거 전이면 마켓 오류 + 안내, 수거완료 뒤 승인 → 반품완료
    r = await call('POST', `/api/orders/${nReturn.id}/claim`, { type: 'RETURN' });
    assert.equal(r.ok, false);
    assert.match(r.message, /수거/);
    assert.equal((await orderByNo('2026112590000902')).claim, 'RETURN', '실패하면 그대로');
    mock.state.naver.orders.get('2026112500000902').productOrder.claimStatus = 'COLLECT_DONE';
    naverChange(mock.state, '2026112500000902');
    await call('POST', '/api/sync', {});
    r = await call('POST', `/api/orders/${nReturn.id}/claim`, { type: 'RETURN' });
    assert.equal(r.ok, true, r.message);
    assert.equal(mock.state.naver.calls.claimApprove.at(-1).kind, 'return');
    assert.equal((await call('GET', `/api/orders/${nReturn.id}`)).status, 'RETURNED');

    // 쿠팡 출고중지완료: 접수번호(큰 숫자 그대로) + 접수 전체 수량
    r = await call('POST', `/api/orders/${cCancel.id}/claim`, { type: 'CANCEL' });
    assert.equal(r.ok, true, r.message);
    const stop = mock.state.coupang.calls.returnActions.at(-1);
    assert.equal(stop.action, 'stoppedShipment');
    assert.match(stop.raw, /"receiptId":600000000000000911,"cancelCount":1/);
    assert.equal((await call('GET', `/api/orders/${cCancel.id}`)).status, 'CANCELED');

    // 쿠팡 반품: 입고 확인 → 반품 승인
    r = await call('POST', `/api/orders/${cReturn.id}/claim`, { type: 'RETURN' });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(mock.state.coupang.calls.returnActions.slice(-2).map((a) => a.action), ['receiveConfirmation', 'approval']);
    assert.equal((await call('GET', `/api/orders/${cReturn.id}`)).status, 'RETURNED');

    // 다음 수집에도 그대로 (마켓 상태와 일치)
    await call('POST', '/api/sync', {});
    assert.equal((await orderByNo('2026112590000901')).status, 'CANCELED');
    assert.equal((await orderByNo('2026112590000902')).status, 'RETURNED');
    assert.equal((await orderByNo('9200000911')).status, 'CANCELED');
    assert.equal((await orderByNo(BIG_ORDER)).status, 'RETURNED');

    // 요청이 없는 주문 / 지원하지 않는 마켓은 안내
    await assert.rejects(call('POST', `/api/orders/${nCancel.id}/claim`, { type: 'CANCEL' }), /요청이 들어온 상품이 없습니다/);
    const el = (await call('GET', '/api/orders?tab=all&q=202611220001')).orders[0];
    await assert.rejects(call('POST', `/api/orders/${el.id}/claim`, { type: 'CANCEL' }), /지원하지 않습니다/);
    await assert.rejects(call('POST', `/api/orders/${el.id}/claim`, { type: 'EXCHANGE' }), /취소\/반품/);
  });

  await t.test('신규주문 상품 링크: 판매 페이지 · 도매매 상품 (목록·상세·알림 버튼)', async () => {
    naverAddOrder(mock.state, { productOrderId: '2026112500000951', orderId: '2026112590000951', name: '링크고객', productId: '6597568247', code: 'dmm41674420' });
    coupangAddSheet(mock.state, { shipmentBoxId: '700000000951', orderId: '9200000951', vendorItemId: '951', name: '쿠팡링크', productId: '307227331' });
    const before = mock.state.telegram.messages.length;
    await call('POST', '/api/sync', {});
    const nv = (await call('GET', '/api/orders?tab=new&q=2026112590000951')).orders[0];
    assert.equal(nv.items[0].product_url, 'https://smartstore.naver.com/main/products/6597568247');
    assert.equal(nv.items[0].supplier_name, '도매매');
    assert.equal(nv.items[0].supplier_url, 'https://domeme.domeggook.com/s/41674420');
    assert.equal(nv.items[0].extra, undefined, '목록에는 내부 정보(extra)를 내보내지 않음');
    const cp = (await call('GET', '/api/orders?tab=new&q=9200000951')).orders[0];
    assert.equal(cp.items[0].product_url, 'https://www.coupang.com/vp/products/307227331?vendorItemId=951');
    const detail = await call('GET', `/api/orders/${nv.id}`);
    assert.equal(detail.items[0].product_url, 'https://smartstore.naver.com/main/products/6597568247');
    // 텔레그램 신규주문 알림: [주문 보기] + [판매 페이지] [도매매 상품] 버튼
    const msg = mock.state.telegram.messages.slice(before).find((m) => /링크고객/.test(m.text));
    assert.ok(msg, '신규주문 알림');
    const buttons = msg.reply_markup.inline_keyboard.flat();
    assert.deepEqual(buttons.map((b) => b.text), ['주문 보기', '판매 페이지', '도매매 상품']);
    assert.equal(buttons[1].url, 'https://smartstore.naver.com/main/products/6597568247');
    assert.equal(buttons[2].url, 'https://domeme.domeggook.com/s/41674420');
  });

  await t.test('11번가가 잘 되다가 접속을 막으면: 원인 안내 + 자동 수집 간격 늘림 + 복구', async () => {
    const eleven = (await call('GET', '/api/stores')).stores.find((s) => s.type === 'elevenst');
    // 정상 수집 때 서버 IP 기록
    setCachedPublicIp('203.0.113.7');
    await call('POST', '/api/sync', { storeId: eleven.id });
    mock.state.eleven.reset = true; // 11번가 방화벽이 연결을 끊음
    await app.sync.runAll({ manual: false });
    let s = (await call('GET', '/api/stores')).stores.find((x) => x.id === eleven.id);
    assert.match(s.lastError, /11번가가 이 서버의 접속을 막았습니다 \(마지막 정상 수집 .*서버 IP 203\.0\.113\.7 그대로\)/);
    assert.match(s.lastError, /솔루션 업체 선택/);
    assert.match(s.lastError, /203\.0\.113\.7 가 아직 있는지/);
    assert.ok(s.retryAt, '자동 재시도 간격 늘림');
    // 다음 자동 수집은 건너뜀 (11번가에 계속 두드리지 않음), [지금 수집]은 바로 시도
    const qnaCalls = mock.state.eleven.calls.qna.length;
    const auto = await app.sync.runAll({ manual: false });
    assert.match(auto.stores.find((x) => x.storeId === eleven.id).skipped, /접속이 막혀/);
    const manual = await call('POST', '/api/sync', { storeId: eleven.id });
    assert.equal(manual.errors, 1);
    assert.equal(mock.state.eleven.calls.qna.length, qnaCalls);
    // 서버 IP 가 바뀐 경우는 그렇게 안내
    setCachedPublicIp('203.0.113.99');
    await call('POST', '/api/sync', { storeId: eleven.id });
    s = (await call('GET', '/api/stores')).stores.find((x) => x.id === eleven.id);
    assert.match(s.lastError, /서버 IP가 바뀌어서 11번가가 접속을 막았습니다 \(전: 203\.0\.113\.7 → 지금: 203\.0\.113\.99\)/);
    // 연결 테스트 진단에도 서버 IP·마지막 정상 수집
    const diag = await call('POST', `/api/stores/${eleven.id}/test`, {}, { raw: true });
    const dj = await diag.json();
    assert.match(dj.diagnostic, /이 서버 IP: 203\.0\.113\.99/);
    assert.match(dj.diagnostic, /11번가 마지막 정상 수집: .*그때 서버 IP 203\.0\.113\.7 → 지금과 다름!/);
    assert.match(dj.diagnostic, /연결됨 \(IPv4\)/);
    // 다시 열리면 정상화 + 재시도 간격 원래대로
    mock.state.eleven.reset = false;
    setCachedPublicIp('203.0.113.7');
    await call('POST', '/api/sync', { storeId: eleven.id });
    s = (await call('GET', '/api/stores')).stores.find((x) => x.id === eleven.id);
    assert.equal(s.lastError, null);
    assert.equal(s.retryAt, null);
    setCachedPublicIp(null);
  });

  await t.test('수집 오류 알림은 한 번만, 복구되면 정상화 알림', async () => {
    mock.state.coupang.rejectAuth = true;
    const before = mock.state.telegram.messages.length;
    const r1 = await call('POST', '/api/sync', {});
    assert.equal(r1.errors, 1);
    await call('POST', '/api/sync', {});
    const errMsgs = mock.state.telegram.messages.slice(before).filter((m) => /수집 오류/.test(m.text));
    assert.equal(errMsgs.length, 1);
    const stores = (await call('GET', '/api/stores')).stores;
    assert.match(stores.find((s) => s.type === 'coupang').lastError, /인증 실패/);
    mock.state.coupang.rejectAuth = false;
    await call('POST', '/api/sync', {});
    assert.ok(mock.state.telegram.messages.slice(before).some((m) => /정상화/.test(m.text)));
  });

  await t.test('되돌리기 / 이력 / 비밀번호 변경', async () => {
    naverAddOrder(mock.state, { productOrderId: '2026112200000401', orderId: '2026112290000031', name: '되돌림' });
    await call('POST', '/api/sync', {});
    const o = await orderByNo('2026112290000031');
    await call('POST', '/api/orders/purchase', { ids: [o.id] });
    const rv = await call('POST', `/api/orders/${o.id}/revert`, {});
    assert.equal(rv.status, 'NEW');
    const ev = await call('GET', '/api/events?limit=50');
    assert.ok(ev.events.length > 5);
    await assert.rejects(call('POST', '/api/auth/password', { current: 'wrong', next: 'newpass123' }), (e) => e.status === 400);
    await call('POST', '/api/auth/password', { current: 'secret1234', next: 'newpass123' });
    await call('POST', '/api/auth/logout', {});
    await assert.rejects(call('GET', '/api/orders'), (e) => e.status === 401);
    await assert.rejects(call('POST', '/api/auth/login', { password: 'secret1234' }), (e) => e.status === 401);
    await call('POST', '/api/auth/login', { password: 'newpass123' });
    assert.ok((await call('GET', '/api/orders/counts')).all > 0);
  });
});
