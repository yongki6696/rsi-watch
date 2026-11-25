// 끝에서 끝까지 테스트: 실제 Workers 런타임(wrangler dev, 로컬 D1) + 가짜 쿠팡 파트너스 API + 가짜 푸시 서버
// 실제 쿠팡에는 접속하지 않는다.   실행: npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakePartners, makeSubscriptionKeys, decryptPush, makeVapidKeys } from '../test/helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake; let pushSrv; let dev; let base; let stateDir; let subKeys; let devLog = '';
const pushes = [];
const ADMIN = 'e2e-admin-token-0123456789';

function freePort() {
  return new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
}
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(300); }
  throw new Error(`${label} 시간 초과\n${devLog.slice(-2000)}`);
}
async function call(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

before(async () => {
  fake = await startFakePartners({
    catalog: {
      7335597976: { name: '탐사 샘물 2L 12개', price: 9900, keywords: ['샘물', '생수'] },
      7000000002: { name: '다른 생수 2L 6개', price: 5900, keywords: ['생수'] },
    },
  });
  subKeys = await makeSubscriptionKeys();
  pushSrv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try { pushes.push({ path: req.url, auth: req.headers.authorization, payload: JSON.parse((await decryptPush(Buffer.concat(chunks), subKeys)).text) }); } catch (e) { pushes.push({ error: e.message }); }
      res.writeHead(201); res.end();
    });
  });
  await new Promise((r) => pushSrv.listen(0, '127.0.0.1', r));
  const vapid = await makeVapidKeys();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-e2e-'));
  const vars = {
    COUPANG_ACCESS_KEY: fake.accessKey,
    COUPANG_SECRET_KEY: fake.secretKey,
    COUPANG_API_BASE: fake.base,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:e2e@example.com',
    ADMIN_TOKEN: ADMIN,
    ALLOW_INSECURE_PUSH: '1',
  };
  const bin = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = [bin, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', stateDir, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
  // 자식(workerd)까지 한 번에 끌 수 있게 별도 프로세스 그룹으로 띄운다
  dev = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  dev.stdout.on('data', (d) => { devLog += d; });
  dev.stderr.on('data', (d) => { devLog += d; });
  await waitFor(async () => (await fetch(`${base}/api/config`)).ok, 60000, 'wrangler dev 시작');
});

after(async () => {
  if (dev && dev.exitCode === null) {
    const exited = new Promise((r) => dev.once('exit', r));
    try { if (process.platform === 'win32') dev.kill(); else process.kill(-dev.pid, 'SIGTERM'); } catch { /* 이미 종료 */ }
    await Promise.race([exited, sleep(5000)]);
    try { if (process.platform !== 'win32') process.kill(-dev.pid, 'SIGKILL'); } catch { /* 종료됨 */ }
  }
  if (fake) fake.srv.close();
  if (pushSrv) pushSrv.close();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

let token; let watchId;

test('실제 런타임: 설정과 화면 파일', async () => {
  const cfg = await call('GET', '/api/config');
  assert.equal(cfg.data.mode, 'live');
  assert.equal(cfg.data.push, true);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /최저가 레이더/);
  const share = await fetch(`${base}/share?text=abc`);
  assert.equal(share.status, 200, '공유 받기 주소도 앱 화면으로');
  assert.match(share.headers.get('content-type'), /text\/html/);
  const sw = await fetch(`${base}/sw.js`);
  assert.match(sw.headers.get('content-type'), /javascript/);
  const missing = await call('GET', '/api/nope');
  assert.equal(missing.status, 404);
});

test('실제 런타임: 공유 문구로 찾기 → 서명된 쿠팡 API 호출 → 등록', async () => {
  token = (await call('POST', '/api/session', { body: {} })).data.token;
  assert.ok(token);
  const r = await call('POST', '/api/resolve', { token, body: { text: '[쿠팡] 탐사 샘물 2L 12개 https://www.coupang.com/vp/products/7335597976?itemId=1&vendorItemId=2' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.match.price, 9900);
  const searchCall = fake.calls.find((c) => c.path.endsWith('/products/search'));
  assert.ok(searchCall, '쿠팡 API 를 불렀다');
  assert.equal(searchCall.query.keyword, '탐사 샘물 2L 12개');
  const w = await call('POST', '/api/watches', { token, body: { kind: 'product', productId: '7335597976', keyword: r.data.keyword, targetPrice: 9000 } });
  assert.equal(w.status, 201, JSON.stringify(w.data));
  watchId = w.data.watch.id;
  assert.equal(w.data.watch.price, 9900);
  const sub = await call('POST', '/api/push/subscribe', { token, body: { endpoint: `http://127.0.0.1:${pushSrv.address().port}/push/e2e`, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } } });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  await call('PATCH', '/api/me', { token, body: { nightOk: true } });
});

test('실제 런타임: 가격이 목표가 아래로 → 기록 + 암호화된 푸시 도착', async () => {
  fake.state.catalog[7335597976].price = 8800;
  const run = await call('POST', '/api/admin/run', { body: { force: true }, headers: { 'X-Admin-Token': ADMIN } });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.changes, 1, JSON.stringify(run.data));
  assert.equal(run.data.sent, 1, JSON.stringify(run.data));
  const p = pushes.at(-1);
  assert.equal(p.path, '/push/e2e');
  assert.match(p.auth, /^vapid t=/);
  assert.equal(p.payload.title, '🎯 목표가 도달 · 8,800원');
  assert.equal(p.payload.url, `/#/w/${watchId}`);
  const d = await call('GET', `/api/watches/${watchId}`, { token });
  assert.deepEqual(d.data.watch.history.map((x) => x.p), [9900, 8800]);
});

test('실제 런타임: 예약 실행(cron) 처리기와 관리자 현황', async () => {
  const before = (await call('GET', '/api/admin/stats', { headers: { 'X-Admin-Token': ADMIN } })).data;
  const res = await fetch(`${base}/cdn-cgi/local/scheduled?cron=*/10+*+*+*+*`);
  assert.equal(res.status, 200);
  const after = await waitFor(async () => {
    const s = (await call('GET', '/api/admin/stats', { headers: { 'X-Admin-Token': ADMIN } })).data;
    return s.lastRun && (!before.lastRun || s.lastRun.at > before.lastRun.at) ? s : null;
  }, 15000, 'cron 실행');
  assert.equal(after.mode, 'live');
  assert.equal(after.users, 1);
  assert.equal(after.watches, 1);
  assert.equal(after.devices, 1);
  assert.ok(after.apiCallsLastHour >= 2 && after.apiCallsLastHour <= after.apiHourlyLimit);
  const denied = await call('GET', '/api/admin/stats', { headers: { 'X-Admin-Token': 'nope' } });
  assert.equal(denied.status, 403);
});

test('실제 런타임: 특가 목록은 파트너스 링크', async () => {
  const f = await call('GET', '/api/feed?key=goldbox');
  assert.equal(f.status, 200, JSON.stringify(f.data));
  assert.ok(f.data.items.length > 0);
  assert.match(f.data.items[0].url, /link\.coupang\.com/);
});
