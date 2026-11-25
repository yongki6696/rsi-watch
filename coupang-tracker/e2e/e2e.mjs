// 끝에서 끝까지 테스트: 로컬 "가짜 쿠팡" 서버를 띄우고 실제 서버 + 실제 브라우저로 확인한다.
// 실제 쿠팡에는 접속하지 않는다.   실행: npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBookmarklet } from '../lib/extractor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const read = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const won = (n) => n.toLocaleString('en-US');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prices = { 111: 12000, 222: 25900, 333: 4500 };
let cartNeedsLogin = false;
const hits = [];

function renderProduct(id, ua) {
  if (id === '111') return [200, read('product-classic.html').replaceAll('{{PRICE}}', won(prices[111]))];
  if (id === '222') return [200, read('product-generic.html').replaceAll('{{PRICE}}', won(prices[222]))];
  if (id === '333') {
    // 브라우저가 아닌 요청은 막는 상품 (자동 모드의 브라우저 대체 확인을 시험)
    if (!/HeadlessChrome/.test(ua)) return [403, read('blocked.html')];
    return [200, read('product-classic.html').replaceAll('{{PRICE}}', won(prices[333])).replace('테스트 상품 A', '차단 테스트 상품')];
  }
  return [404, 'not found'];
}

function startMock() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname);
    const m = u.pathname.match(/^\/vp\/products\/(\d+)$/);
    if (m) {
      const [status, body] = renderProduct(m[1], req.headers['user-agent'] || '');
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(body);
    }
    if (u.pathname === '/cart/cartView.pang') {
      if (cartNeedsLogin) { res.writeHead(302, { Location: '/login/login.pang' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(read('cart.html').replaceAll('{{P111x2}}', won(prices[111] * 2)).replaceAll('{{P111}}', won(prices[111])).replaceAll('{{P222}}', won(prices[222])));
    }
    if (u.pathname === '/login/login.pang') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h1>로그인</h1>'); }
    res.writeHead(404); return res.end();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function freePort() {
  return new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
}

async function browserAvailable() {
  try {
    const { chromium } = await import('playwright-core');
    for (const channel of [undefined, 'chrome', 'msedge']) {
      try { const b = await chromium.launch(channel ? { channel } : {}); await b.close(); return channel || 'chromium'; } catch { /* 다음 */ }
    }
  } catch { /* 없음 */ }
  return null;
}

let mock; let app; let base; let mockOrigin; let dataDir;
const channel = await browserAvailable();
const events = [];

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
async function state() { return (await api('GET', '/api/state')).data; }
async function waitFor(fn, ms = 60000, label = '조건') {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`${label} 시간 초과`);
}
const byPid = (st, pid) => st.products.find((p) => p.productId === pid);

before(async () => {
  mock = await startMock();
  mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-e2e-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CPT_DATA_DIR: dataDir,
      CPT_COUPANG_ORIGIN: mockOrigin,
      CPT_CART_URL: `${mockOrigin}/cart/cartView.pang`,
      CPT_LOGIN_URL: `${mockOrigin}/login/login.pang`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (d) => { if (process.env.E2E_VERBOSE) process.stdout.write(d); });
  app.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(async () => { try { return (await fetch(`${base}/api/state`)).ok; } catch { return false; } }, 15000, '서버 시작');
  if (channel && channel !== 'chromium') await api('PUT', '/api/settings', { browserChannel: channel });
  // 실시간 이벤트 받기
  http.get(`${base}/api/events`, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const type = (chunk.match(/^event: (.+)$/m) || [])[1];
        const data = (chunk.match(/^data: (.+)$/m) || [])[1];
        if (type && data) events.push({ type, data: JSON.parse(data) });
      }
    });
  });
});

after(async () => {
  if (app) { app.kill('SIGTERM'); await new Promise((r) => app.once('exit', r)); }
  if (mock) mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('링크로 추가하면 빠른 요청으로 가격을 읽는다', async () => {
  const r = await api('POST', '/api/products', { url: `${mockOrigin}/vp/products/111?itemId=1001&vendorItemId=2001` });
  assert.equal(r.status, 201);
  const p = await waitFor(async () => { const x = byPid(await state(), '111'); return x && x.price ? x : null; }, 30000, '111 가격');
  assert.equal(p.price, 12000);
  assert.equal(p.name, '테스트 상품 A 대용량 500ml x 3개');
  assert.equal(p.history[0].s, 'fetch');
  assert.equal(p.id, '111-1001-2001');
});

test('같은 상품을 또 넣으면 새로 만들지 않는다', async () => {
  const r = await api('POST', '/api/products', { url: `${mockOrigin}/vp/products/111?itemId=1001&vendorItemId=2001` });
  assert.equal(r.status, 200);
  assert.equal(r.data.created, false);
});

test('모르는 페이지 구조는 브라우저로 열어 가장 큰 가격 글자를 읽는다', { skip: !channel && '브라우저 없음' }, async () => {
  await api('POST', '/api/products', { url: `${mockOrigin}/vp/products/222?itemId=1002&vendorItemId=2002` });
  const p = await waitFor(async () => { const x = byPid(await state(), '222'); return x && (x.price || x.lastError) ? x : null; }, 60000, '222 가격');
  assert.equal(p.lastError, null);
  assert.equal(p.price, 25900); // 배송비(3,000원 큰 글씨), 쿠폰(-2,000원), 취소선, 아래쪽 추천 상품은 무시
  assert.equal(p.history[0].s, 'browser');
});

test('빠른 요청이 차단되면 브라우저로 대신 확인한다', { skip: !channel && '브라우저 없음' }, async () => {
  await api('POST', '/api/products', { url: `${mockOrigin}/vp/products/333` });
  const p = await waitFor(async () => { const x = byPid(await state(), '333'); return x && (x.price || x.lastError) ? x : null; }, 60000, '333 가격');
  assert.equal(p.lastError, null);
  assert.equal(p.price, 4500);
  assert.equal(p.history[0].s, 'browser');
  assert.equal((await state()).status.fetchBlocked, true);
});

test('가격이 내리면 기록하고 실시간 알림을 보낸다', { skip: !channel && '브라우저 없음' }, async () => {
  prices[111] = 10900;
  const id = '111-1001-2001';
  const before = events.length;
  const r = await api('POST', `/api/products/${id}/check`);
  assert.equal(r.status, 202);
  const p = await waitFor(async () => { const x = byPid(await state(), '111'); return x.price === 10900 ? x : null; }, 60000, '111 새 가격');
  assert.equal(p.change, -1100);
  assert.equal(p.prevPrice, 12000);
  assert.deepEqual(p.history.map((h) => h.p), [12000, 10900]);
  const alert = await waitFor(async () => events.slice(before).find((e) => e.type === 'alert' && e.data.id === id), 5000, '알림');
  assert.equal(alert.data.kind, 'low'); // 역대 최저가
  assert.equal(alert.data.prev, 12000);
  assert.ok(events.slice(before).some((e) => e.type === 'product' && e.data.point && e.data.point.p === 10900));
});

test('장바구니 동기화: 로그인이 필요하면 알려주고, 로그인되면 단가로 가져온다', { skip: !channel && '브라우저 없음' }, async () => {
  cartNeedsLogin = true;
  let r = await api('POST', '/api/cart/sync');
  assert.equal(r.status, 401);
  assert.match(r.data.error, /로그인/);
  assert.equal((await state()).status.cart.needLogin, true);

  cartNeedsLogin = false;
  r = await api('POST', '/api/cart/sync');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ids.length, 2, '추천 상품은 빼고 장바구니 2개만');
  const st = await state();
  const a = byPid(st, '111');
  assert.equal(a.inCart, true);
  assert.equal(a.price, 10900, '수량 2개 합계(21,800원)가 아니라 단가');
  const b = byPid(st, '222');
  assert.equal(b.inCart, true);
  assert.equal(b.price, 25900);
  assert.equal(b.soldOut, true);
  assert.equal(byPid(st, '777'), undefined);
  assert.equal(st.status.cart.error, null);
});

test('북마클릿이 보낸 장바구니 데이터를 받는다', async () => {
  const r = await api('POST', '/api/import', {
    v: 1, kind: 'cart', page: 'https://cart.coupang.com/cartView.pang', at: Date.now(),
    items: [
      { productId: '444', itemId: '1', vendorItemId: '2', name: '북마클릿 상품', price: 3300, image: null, soldOut: false },
      { productId: '111', itemId: '1001', vendorItemId: '2001', name: '카트 상품 하나 300g', price: 10900 },
      { productId: 'abc', name: '잘못된 항목' },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 1);
  assert.equal(r.data.priced, 2);
  const st = await state();
  assert.equal(byPid(st, '444').price, 3300);
  assert.equal(byPid(st, '444').inCart, true);
  assert.equal(byPid(st, '222').inCart, false, '이번 장바구니에 없던 상품은 장바구니 표시를 뗀다');
});

test('다른 사이트에서 몰래 보낸 요청은 거절한다', async () => {
  const res = await fetch(`${base}/api/check`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  const res2 = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"items":[]}' });
  assert.equal(res2.status, 415);
});

test('전체 확인 한 바퀴가 오류 없이 끝난다', { skip: !channel && '브라우저 없음' }, async () => {
  prices[222] = 27900;
  await waitFor(async () => !(await state()).status.running, 120000, '이전 확인 끝'); // 서버가 스스로 돌린 확인이 끝나길 기다림
  const r = await api('POST', '/api/check');
  assert.equal(r.status, 202);
  await waitFor(async () => { const s = await state(); return s.status.running ? null : s.status.lastSummary && s.status.lastSummary.at > Date.now() - 120000 ? s : null; }, 120000, '전체 확인');
  const st = await state();
  for (const p of st.products) {
    if (p.productId === '444') assert.match(p.lastError, /상품 페이지가 없어요/); // 가짜 쿠팡에 없는 상품 → 오류 표시
    else assert.equal(p.lastError, null, `${p.productId}: ${p.lastError}`);
  }
  assert.equal(byPid(st, '444').price, 3300, '확인에 실패해도 기존 가격은 남는다');
  assert.equal(byPid(st, '222').price, 27900);
  assert.equal(byPid(st, '222').change, 2000);
  assert.ok(st.status.nextRunAt > Date.now());
});

test('상품을 지우면 목록과 기록에서 사라진다', async () => {
  const r = await api('DELETE', '/api/products/444-1-2');
  assert.equal(r.status, 200);
  assert.equal(byPid(await state(), '444'), undefined);
});

test('북마클릿을 쿠팡 상품/장바구니 페이지에서 실행하면 데이터를 넘긴다', { skip: !channel && '브라우저 없음' }, async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch(channel === 'chromium' ? {} : { channel });
  try {
    const page = await browser.newPage();
    // 실제 쿠팡 대신 테스트용 HTML을 돌려준다 (네트워크로 나가지 않음)
    await page.route('https://www.coupang.com/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('product-classic.html').replaceAll('{{PRICE}}', '12,340') }));
    await page.route('https://cart.coupang.com/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('cart.html').replaceAll('{{P111x2}}', '20,000').replaceAll('{{P111}}', '10,000').replaceAll('{{P222}}', '7,500') }));
    await page.addInitScript(() => { window.open = (u) => { window.__opened = u; return {}; }; window.alert = (m) => { window.__alert = m; }; });
    const code = buildBookmarklet('http://192.168.0.10:3000').slice('javascript:'.length);
    const run = async (url) => {
      await page.goto(url);
      await page.evaluate(code);
      const opened = await page.evaluate(() => window.__opened || null);
      assert.ok(opened, await page.evaluate(() => window.__alert || '열린 창 없음'));
      assert.ok(opened.startsWith('http://192.168.0.10:3000/#import='));
      return JSON.parse(decodeURIComponent(opened.split('#import=')[1]));
    };
    const prod = await run('https://www.coupang.com/vp/products/111?itemId=1001&vendorItemId=2001');
    assert.equal(prod.kind, 'product');
    assert.equal(prod.items.length, 1);
    assert.equal(prod.items[0].price, 12340);
    assert.equal(prod.items[0].vendorItemId, '2001');
    assert.equal(prod.items[0].name, '테스트 상품 A 대용량 500ml x 3개');
    const cart = await run('https://cart.coupang.com/cartView.pang');
    assert.equal(cart.kind, 'cart');
    assert.deepEqual(cart.items.map((x) => [x.productId, x.price, x.qty]), [['111', 10000, 2], ['222', 7500, 1]]);
    assert.equal(cart.items[0].name, '카트 상품 하나 300g');
    // 쿠팡이 아닌 페이지에서는 안내만 한다
    await page.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>hi</p>' }));
    await page.goto('https://example.com/');
    await page.evaluate(code);
    assert.match(await page.evaluate(() => window.__alert), /쿠팡/);
  } finally {
    await browser.close();
  }
});
