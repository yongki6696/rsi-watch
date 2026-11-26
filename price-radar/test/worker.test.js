// Worker 를 Node 에서 직접 실행해 보는 통합 테스트
// (가짜 쿠팡 파트너스 API + 가짜 푸시 서버, DB 는 메모리 SQLite)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import worker from '../src/index.js';
import { runChecks } from '../src/checker.js';
import { createD1, startFakePartners, makeSubscriptionKeys, decryptPush, makeVapidKeys } from './helpers.js';

const HOUR = 3600 * 1000;
const ctx = { waitUntil: () => {} };
let fake; let pushSrv; const pushes = []; let pushBase; let vapid; let subKeys;

function nextKstHour(after, hour) {
  const kstNow = new Date(after + 9 * HOUR);
  let t = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(), hour) - 9 * HOUR;
  while (t <= after) t += 24 * HOUR;
  return t;
}

function makeEnv(extra = {}) {
  return {
    DB: createD1(),
    APP_NAME: '테스트 레이더',
    API_HOURLY_LIMIT: '20',
    CHECK_INTERVAL_MIN: '60',
    MAX_WATCHES_PER_USER: '5',
    COUPANG_ACCESS_KEY: fake.accessKey,
    COUPANG_SECRET_KEY: fake.secretKey,
    COUPANG_API_BASE: fake.base,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'https://radar.example',
    ALLOW_INSECURE_PUSH: '1',
    ADMIN_TOKEN: 'admin-token-for-tests-1234',
    ...extra,
  };
}

async function call(env, method, path, { token, body, headers = {} } = {}) {
  const req = new Request(`https://radar.example${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, ctx);
  return { status: res.status, data: await res.json() };
}

async function newUser(env) {
  const r = await call(env, 'POST', '/api/session');
  assert.equal(r.status, 201);
  return r.data.token;
}

before(async () => {
  fake = await startFakePartners({
    catalog: {
      111: { name: '테스트 샘물 2L 12개', price: 9900, keywords: ['샘물', '생수'] },
      112: { name: '다른 생수 2L 6개', price: 5900, keywords: ['생수'] },
      222: { name: '무선 이어폰 프로', price: 129000, keywords: ['이어폰'] },
    },
  });
  vapid = await makeVapidKeys();
  subKeys = await makeSubscriptionKeys();
  pushSrv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      try {
        const { text } = await decryptPush(body, subKeys);
        pushes.push({ path: req.url, auth: req.headers.authorization, encoding: req.headers['content-encoding'], ttl: req.headers.ttl, payload: JSON.parse(text) });
      } catch (e) { pushes.push({ error: e.message }); }
      res.writeHead(req.url.includes('gone') ? 410 : 201); res.end();
    });
  });
  await new Promise((r) => pushSrv.listen(0, '127.0.0.1', r));
  pushBase = `http://127.0.0.1:${pushSrv.address().port}`;
});

after(() => { fake.srv.close(); pushSrv.close(); });

test('공유 문구 → 상품 찾기 → 알림 등록 → 가격이 내리면 푸시', async () => {
  const env = makeEnv();
  const token = await newUser(env);

  const cfg = await call(env, 'GET', '/api/config');
  assert.equal(cfg.data.mode, 'live');
  assert.equal(cfg.data.push, true);
  assert.match(cfg.data.disclosure, /쿠팡 파트너스 활동의 일환/);

  const res = await call(env, 'POST', '/api/resolve', { token, body: { text: '[쿠팡] 테스트 샘물 2L 12개 https://www.coupang.com/vp/products/111?itemId=1&vendorItemId=2' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.productId, '111');
  assert.equal(res.data.match.price, 9900);
  assert.match(res.data.match.url, /link\.coupang\.com/);

  const w = await call(env, 'POST', '/api/watches', { token, body: { kind: 'product', productId: '111', keyword: res.data.keyword, targetPrice: 8000 } });
  assert.equal(w.status, 201, JSON.stringify(w.data));
  assert.equal(w.data.watch.price, 9900);
  assert.equal(w.data.watch.partner, true);
  assert.equal(w.data.watch.targetPrice, 8000);

  // 푸시 구독 + 밤에도 받기
  const sub = await call(env, 'POST', '/api/push/subscribe', { token, body: { endpoint: `${pushBase}/push/dev1`, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } } });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  await call(env, 'PATCH', '/api/me', { token, body: { nightOk: true } });

  // 2시간 뒤: 가격이 내림
  fake.state.catalog[111].price = 8900;
  const t1 = Date.now() + 2 * HOUR;
  const s1 = await runChecks(env, { now: t1 });
  assert.equal(s1.mode, 'live');
  assert.ok(s1.calls >= 1);
  assert.equal(s1.changes, 1);
  assert.equal(s1.sent, 1);
  const p1 = pushes.at(-1);
  assert.equal(p1.encoding, 'aes128gcm');
  assert.match(p1.auth, /^vapid t=.+, k=/);
  assert.equal(p1.payload.title, '▼ 1,000원 내렸어요 · 8,900원');
  assert.match(p1.payload.body, /테스트 샘물 2L 12개\n9,900원 → 8,900원/);
  assert.equal(p1.payload.url, `/#/w/${w.data.watch.id}`);

  // 4시간 뒤: 또 내렸고 목표가 아래 → 6시간 이내라도 목표가 알림은 보냄
  fake.state.catalog[111].price = 7900;
  const s2 = await runChecks(env, { now: t1 + 2 * HOUR });
  assert.equal(s2.sent, 1);
  assert.match(pushes.at(-1).payload.title, /목표가 도달 · 7,900원/);

  // 6시간 안에 또 조금 내리면 (목표가 이미 지남) 조용히
  fake.state.catalog[111].price = 7800;
  const s3 = await runChecks(env, { now: t1 + 4 * HOUR });
  assert.equal(s3.changes, 1);
  assert.equal(s3.sent, 0);

  // 목록에 기록과 상태가 보인다
  const me = await call(env, 'GET', '/api/me', { token });
  const mine = me.data.watches[0];
  assert.equal(mine.price, 7800);
  assert.equal(mine.prevPrice, 7900);
  assert.equal(mine.minPrice, 7800);
  assert.equal(mine.maxPrice, 9900);
  assert.equal(mine.history, undefined, '목록에는 기록을 싣지 않는다');
  assert.equal(mine.changedAt, t1 + 4 * HOUR);
  assert.equal(me.data.user.devices, 1);
  assert.equal(me.data.status.mode, 'live');
  const detail = await call(env, 'GET', `/api/watches/${mine.id}`, { token });
  assert.deepEqual(detail.data.watch.history.map((h) => h.p), [9900, 8900, 7900, 7800]);
});

test('키워드 최저가 알림과 한 번의 검색으로 여러 상품 갱신', async () => {
  const env = makeEnv();
  const token = await newUser(env);
  const r = await call(env, 'POST', '/api/resolve', { token, body: { text: '생수' } });
  assert.equal(r.data.results.length, 2);
  const kw = await call(env, 'POST', '/api/watches', { token, body: { kind: 'keyword', keyword: '생수' } });
  assert.equal(kw.status, 201);
  assert.equal(kw.data.watch.price, 5900); // 캐시된 검색 결과로 바로 최저가
  assert.equal(kw.data.watch.bestName, '다른 생수 2L 6개');
  const prod = await call(env, 'POST', '/api/watches', { token, body: { kind: 'product', productId: '111', keyword: '생수' } });
  assert.equal(prod.data.watch.price, fake.state.catalog[111].price);

  fake.state.catalog[112].price = 5500;
  fake.state.catalog[111].price = 7500;
  const before = fake.calls.length;
  const s = await runChecks(env, { now: Date.now() + 2 * HOUR });
  const searches = fake.calls.slice(before).filter((c) => c.path.endsWith('/products/search'));
  assert.equal(searches.length, 1, '같은 검색어("생수")는 한 번만 부른다');
  assert.equal(s.changes, 2);
  const me = await call(env, 'GET', '/api/me', { token });
  const byKind = Object.fromEntries(me.data.watches.map((w) => [w.kind, w]));
  assert.equal(byKind.keyword.price, 5500);
  assert.equal(byKind.product.price, 7500);
  const kwDetail = await call(env, 'GET', `/api/watches/${byKind.keyword.id}`, { token });
  assert.equal(kwDetail.data.watch.results.length, 2);
});

test('검색 결과에 없는 상품은 3번 못 찾으면 "찾을 수 없음"', async () => {
  const env = makeEnv();
  const token = await newUser(env);
  const w = await call(env, 'POST', '/api/watches', { token, body: { kind: 'product', productId: '999999', keyword: '이어폰' } });
  assert.equal(w.data.watch.status, 'pending');
  assert.ok(w.data.watch.partner, '못 찾아도 딥링크로 수익 링크는 만든다');
  let t = Date.now();
  for (let i = 0; i < 3; i++) { t += 2 * HOUR; await runChecks(env, { now: t }); }
  const me = await call(env, 'GET', '/api/me', { token });
  assert.equal(me.data.watches[0].status, 'not_found');
});

test('호출 한도: 정기 확인은 사용자 몫(30%)을 남기고, 다 쓰면 멈춘다', async () => {
  const env = makeEnv({ API_HOURLY_LIMIT: '4' }); // 예비 2회, 정기 확인은 1회씩
  const token = await newUser(env);
  for (const id of ['111', '112', '222']) {
    await call(env, 'POST', '/api/watches', { token, body: { kind: 'product', productId: id, keyword: id === '222' ? '이어폰' : id === '111' ? '샘물' : '다른 생수' } });
  }
  const used0 = (await call(env, 'GET', '/api/admin/stats', { headers: { 'X-Admin-Token': 'admin-token-for-tests-1234' } })).data.apiCallsLastHour;
  const s1 = await runChecks(env, { now: Date.now() + 2 * HOUR });
  assert.ok(s1.calls <= 1, JSON.stringify(s1));
  const stats = (await call(env, 'GET', '/api/admin/stats', { headers: { 'X-Admin-Token': 'admin-token-for-tests-1234' } })).data;
  assert.ok(stats.apiCallsLastHour <= 4);
  assert.ok(stats.apiCallsLastHour >= used0);
  // 남은 호출이 예비분뿐이면 정기 확인은 쉬고, 사용자 검색은 된다
  const s2 = await runChecks(env, { now: Date.now() + 4 * HOUR });
  assert.equal(s2.calls, 0);
  const r = await call(env, 'POST', '/api/resolve', { token, body: { text: '이어폰 새로 찾기' } });
  assert.ok(r.data.budget || r.data.results, JSON.stringify(r.data));
  const bad = await call(env, 'GET', '/api/admin/stats', { headers: { 'X-Admin-Token': 'wrong' } });
  assert.equal(bad.status, 403);
});

test('키가 틀리면 API 사용을 잠시 멈추고 사용자에게 알려준다', async () => {
  const env = makeEnv({ COUPANG_SECRET_KEY: 'wrong-secret' });
  const token = await newUser(env);
  const r = await call(env, 'POST', '/api/resolve', { token, body: { text: '샘물' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.unavailable, true);
  const again = await call(env, 'POST', '/api/resolve', { token, body: { text: '이어폰' } });
  assert.equal(again.data.budget, true);
  const stats = (await call(env, 'GET', '/api/admin/stats', { headers: { 'X-Admin-Token': 'admin-token-for-tests-1234' } })).data;
  assert.ok(stats.apiPausedUntil > Date.now());
  assert.match(stats.lastApiError.message, /인증 실패/);
});

test('밤(21시~8시)에는 알림을 모아 두었다가 아침에 보낸다', async () => {
  const env = makeEnv();
  const token = await newUser(env);
  await call(env, 'POST', '/api/resolve', { token, body: { text: '이어폰' } });
  await call(env, 'POST', '/api/watches', { token, body: { kind: 'product', productId: '222', keyword: '이어폰' } });
  await call(env, 'POST', '/api/push/subscribe', { token, body: { endpoint: `${pushBase}/push/night`, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } } });
  const night = nextKstHour(Date.now() + HOUR, 23);
  fake.state.catalog[222].price = 119000;
  const before = pushes.length;
  const s1 = await runChecks(env, { now: night });
  assert.equal(s1.deferred, 1);
  assert.equal(pushes.length, before);
  const morning = nextKstHour(night, 9);
  const s2 = await runChecks(env, { now: morning });
  assert.equal(s2.sent >= 1, true);
  assert.equal(pushes.at(-1).path, '/push/night');
  assert.match(pushes.at(-1).payload.title, /10,000원 내렸어요/);
});

test('만료된 푸시 구독(410)은 지운다', async () => {
  const env = makeEnv();
  const token = await newUser(env);
  await call(env, 'POST', '/api/push/subscribe', { token, body: { endpoint: `${pushBase}/push/gone`, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } } });
  const r = await call(env, 'POST', '/api/push/test', { token, body: {} });
  assert.equal(r.data.sent, 0);
  const me = await call(env, 'GET', '/api/me', { token });
  assert.equal(me.data.user.devices, 0);
});

test('특가 목록, 등록 수 제한, 권한, 데이터 삭제', async () => {
  const env = makeEnv({ MAX_WATCHES_PER_USER: '1' });
  const token = await newUser(env);
  const feed = await call(env, 'GET', '/api/feed?key=goldbox');
  assert.equal(feed.status, 200);
  assert.ok(feed.data.items.length >= 1);
  assert.match(feed.data.items[0].url, /link\.coupang\.com/);
  await call(env, 'POST', '/api/watches', { token, body: { kind: 'keyword', keyword: '생수' } });
  const over = await call(env, 'POST', '/api/watches', { token, body: { kind: 'keyword', keyword: '이어폰' } });
  assert.equal(over.status, 400);
  const other = await newUser(env);
  const mine = (await call(env, 'GET', '/api/me', { token })).data.watches[0];
  const steal = await call(env, 'DELETE', `/api/watches/${mine.id}`, { token: other });
  assert.equal(steal.status, 404);
  const noAuth = await call(env, 'GET', '/api/me');
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.data.relogin, true);
  const del = await call(env, 'DELETE', '/api/me', { token });
  assert.equal(del.status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { token })).status, 401);
  const row = await env.DB.prepare("SELECT watchers FROM keywords WHERE id = '생수'").first();
  assert.equal(row.watchers, 0);
});

test('키가 없으면 데모 모드, 키를 넣으면 데모 데이터를 지운다', async () => {
  const env = makeEnv({ COUPANG_ACCESS_KEY: '', COUPANG_SECRET_KEY: '' });
  const token = await newUser(env);
  const cfg = await call(env, 'GET', '/api/config');
  assert.equal(cfg.data.mode, 'mock');
  const r = await call(env, 'POST', '/api/resolve', { token, body: { text: '[쿠팡] 데모 상품 https://www.coupang.com/vp/products/5555555' } });
  assert.equal(r.data.mock, true);
  assert.equal(r.data.match.productId, '5555555');
  const w = await call(env, 'POST', '/api/watches', { token, body: { kind: 'product', productId: '5555555', keyword: r.data.keyword } });
  assert.equal(w.status, 201);
  const s = await runChecks(env, { now: Date.now() + 3 * HOUR });
  assert.equal(s.mode, 'mock');
  // 실제 키 설정
  env.COUPANG_ACCESS_KEY = fake.accessKey;
  env.COUPANG_SECRET_KEY = fake.secretKey;
  const s2 = await runChecks(env, { now: Date.now() + 4 * HOUR });
  assert.equal(s2.mode, 'live');
  assert.equal((await call(env, 'GET', '/api/me', { token })).data.watches.length, 0);
});

test('무료 플랜 한도: 요청 한 번에 D1 쿼리 50개를 넘지 않고, 푸시 한도 초과분은 다음 실행에 간다', async (t) => {
  const env = makeEnv({ MAX_WATCHES_PER_USER: '30', MAX_PUSH_PER_RUN: '8' });
  // 알림 30개짜리 사용자
  const heavy = await newUser(env);
  await call(env, 'POST', '/api/resolve', { token: heavy, body: { text: '생수' } });
  await call(env, 'POST', '/api/watches', { token: heavy, body: { kind: 'product', productId: '111', keyword: '생수' } });
  await call(env, 'POST', '/api/watches', { token: heavy, body: { kind: 'product', productId: '112', keyword: '생수' } });
  for (let i = 0; i < 28; i++) await call(env, 'POST', '/api/watches', { token: heavy, body: { kind: 'keyword', keyword: `키워드 ${i}` } });
  let before = env.DB.count;
  const me = await call(env, 'GET', '/api/me', { token: heavy });
  assert.equal(me.data.watches.length, 30);
  assert.ok(env.DB.count - before <= 10, `/api/me 쿼리 ${env.DB.count - before}개`);
  t.diagnostic(`/api/me (알림 30개): 쿼리 ${env.DB.count - before}개`);
  before = env.DB.count;
  await call(env, 'DELETE', '/api/me', { token: heavy }); // 알림 30개 한꺼번에 정리
  assert.ok(env.DB.count - before <= 12, `삭제 쿼리 ${env.DB.count - before}개`);

  // 같은 상품을 지켜보는 12명 (각자 푸시 구독)
  for (let i = 0; i < 12; i++) {
    const t = await newUser(env);
    await call(env, 'POST', '/api/watches', { token: t, body: { kind: 'product', productId: '111', keyword: '생수' } });
    await call(env, 'POST', '/api/watches', { token: t, body: { kind: 'keyword', keyword: '생수' } });
    await call(env, 'POST', '/api/push/subscribe', { token: t, body: { endpoint: `${pushBase}/push/many${i}`, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } } });
  }
  const day = nextKstHour(Date.now() + HOUR, 14); // 낮 시간 (밤 보류 없음)
  fake.state.catalog[111].price -= 700;
  fake.state.catalog[112].price -= 300;
  const pushesBefore = pushes.length;
  before = env.DB.count;
  const s1 = await runChecks(env, { now: day });
  const used = env.DB.count - before;
  assert.ok(used <= 45, `cron 쿼리 ${used}개 ${JSON.stringify(s1)}`);
  t.diagnostic(`cron 1회차 (12명 알림, 8건 발송): 쿼리 ${used}개`);
  assert.equal(s1.sent, 8, JSON.stringify(s1));
  assert.ok(s1.queued >= 1, JSON.stringify(s1));
  // 5분 뒤 실행에서 나머지를 보낸다
  before = env.DB.count;
  const s2 = await runChecks(env, { now: day + 5 * 60 * 1000 });
  assert.ok(env.DB.count - before <= 45, `cron 쿼리 ${env.DB.count - before}개`);
  t.diagnostic(`cron 2회차 (대기열 발송): 쿼리 ${env.DB.count - before}개`);
  const got = pushes.slice(pushesBefore).filter((p) => p.path && p.path.startsWith('/push/many'));
  assert.equal(new Set(got.map((p) => p.path)).size, 12, '12명 모두 알림을 받는다');
  assert.ok(s2.sent >= 4, JSON.stringify(s2));
});

test('알림 키를 안 넣어도 서버가 한 번 만들어 계속 쓰고, 그 키로 보낸 푸시가 도착한다', async () => {
  const env = makeEnv({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' });
  const c1 = await call(env, 'GET', '/api/config');
  assert.equal(c1.data.push, true);
  assert.equal(c1.data.pushKeys, 'auto');
  assert.match(c1.data.vapidPublicKey, /^[\w-]{86,88}$/);
  const c2 = await call(env, 'GET', '/api/config');
  assert.equal(c2.data.vapidPublicKey, c1.data.vapidPublicKey, '같은 키를 계속 쓴다');
  const token = await newUser(env);
  const sub = await call(env, 'POST', '/api/push/subscribe', { token, body: { endpoint: `${pushBase}/push/auto`, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } } });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  const r = await call(env, 'POST', '/api/push/test', { token, body: {} });
  assert.equal(r.data.sent, 1);
  const p = pushes.at(-1);
  assert.equal(p.path, '/push/auto');
  assert.equal(p.payload.title, '🔔 알림이 잘 와요');
  assert.ok(p.auth.endsWith(`k=${c1.data.vapidPublicKey}`), '자동으로 만든 공개키로 서명');
});
