import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { runWatchers } from '../worker/index.js';

function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    }
  };
}

const TICKET = {
  origin: 'SEL', destination: 'TYO', origin_airport: 'ICN', destination_airport: 'NRT',
  price: 289000, airline: 'KE', flight_number: 703,
  departure_at: '2026-12-18T09:35:00+09:00', return_at: '2026-12-22T19:10:00+09:00',
  transfers: 0, return_transfers: 0, duration_to: 145, duration_back: 150, link: '/search/SEL1812TYO22121'
};

// Travelpayouts / ntfy 대신 응답하는 가짜 fetch
function installFetch(state) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/aviasales/v3/prices_for_dates')) return ok({ success: true, data: [{ ...TICKET, price: state.price }] });
    if (u.endsWith('/data/en/cities.json')) return ok([{ code: 'TYO', name: 'Tokyo', country_code: 'JP', time_zone: 'Asia/Tokyo' }]);
    if (u.endsWith('/data/en/countries.json')) return ok([{ code: 'JP', name: 'Japan' }]);
    if (u.endsWith('/data/en/airlines.json')) return ok([{ code: 'KE', name: 'Korean Air' }]);
    if (u.startsWith('https://ntfy.sh')) return ok({ id: 'x' });
    return new Response('not found', { status: 404 });
  };
  return calls;
}

const ID = 'abcdefghijklmnopqrstuvwx';
const req = (path, init) => new Request('https://w.example.dev' + path, init);

test('prices endpoint proxies with the secret token, enriches, and sets CORS', async () => {
  const calls = installFetch({ price: 289000 });
  const env = { TP_TOKEN: 'secret', TP_MARKER: '12345' };
  const res = await worker.fetch(req('/api/prices?origin=SEL&departure_at=2026-12-18&return_at=2026-12-22'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await res.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].country_code, 'JP');
  assert.equal(body.data[0].destination_tz, 'Asia/Tokyo');
  assert.equal(body.data[0].airline_name, 'Korean Air');
  assert.equal(body.data[0].booking_url, 'https://www.aviasales.com/search/SEL1812TYO22121&marker=12345');

  const tp = calls.find((c) => c.url.includes('prices_for_dates'));
  assert.equal(tp.init.headers['X-Access-Token'], 'secret');
  assert.ok(!tp.url.includes('secret'), 'token is not in the URL');
  assert.match(tp.url, /origin=SEL&departure_at=2026-12-18&return_at=2026-12-22&one_way=false&sorting=price&currency=krw/);
});

test('prices endpoint validates input and reports missing token', async () => {
  installFetch({ price: 1 });
  let res = await worker.fetch(req('/api/prices?origin=seoul&departure_at=2026-12-18&return_at=2026-12-22'), { TP_TOKEN: 'x' });
  assert.equal(res.status, 400);
  res = await worker.fetch(req('/api/prices?origin=SEL&departure_at=2026-12&return_at=2026-12-22'), { TP_TOKEN: 'x' });
  assert.equal(res.status, 400);
  res = await worker.fetch(req('/api/prices?origin=SEL&departure_at=2026-12-18&return_at=2026-12-22'), {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'no_token');
  res = await worker.fetch(req('/api/health'), {});
  assert.deepEqual(await res.json(), { ok: true, token: false, watch: false });
  res = await worker.fetch(req('/api/prices', { method: 'OPTIONS' }), {});
  assert.equal(res.status, 204);
});

function watchBody(over = {}) {
  return {
    topic: 'eodigaji-test1234', minDrop: 1000,
    items: [{
      key: 'SEL|NRT|KE703|2026-12-18T09:35|2026-12-22T19:10', origin: 'SEL', destination: 'TYO',
      departDate: '2026-12-18', returnDate: '2026-12-22',
      match: { airline: 'KE', flightNumber: '703', outDep: '2026-12-18T09:35', backDep: '2026-12-22T19:10' },
      label: '도쿄 · 대한항공 KE703', baseline: 300000, target: null, ...over
    }]
  };
}

test('watch CRUD, validation and baseline merge', async () => {
  installFetch({ price: 1 });
  const env = { TP_TOKEN: 'x', WATCH: fakeKV() };
  const put = (body) => worker.fetch(req('/api/watch/' + ID, { method: 'PUT', body: JSON.stringify(body) }), env);

  assert.equal((await worker.fetch(req('/api/watch/short'), env)).status, 400);
  assert.equal((await worker.fetch(req('/api/watch/' + ID), { TP_TOKEN: 'x' })).status, 501);
  assert.equal((await put({ ...watchBody(), topic: 'bad topic!' })).status, 400);

  let res = await put(watchBody());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).items.length, 1);

  // 서버가 280,000으로 알린 뒤, 앱이 예전 기준(300,000)으로 다시 등록해도 낮은 기준 유지
  const stored = JSON.parse(env.WATCH.m.get('watch:' + ID));
  stored.items[0].baseline = 280000;
  env.WATCH.m.set('watch:' + ID, JSON.stringify(stored));
  res = await put(watchBody());
  assert.equal((await res.json()).items[0].baseline, 280000);

  res = await worker.fetch(req('/api/watch/' + ID), env);
  assert.equal((await res.json()).topic, 'eodigaji-test1234');
  res = await worker.fetch(req('/api/watch/' + ID, { method: 'DELETE' }), env);
  assert.equal(res.status, 200);
  assert.equal((await worker.fetch(req('/api/watch/' + ID), env)).status, 404);
});

test('cron sends ntfy push only on a new low and updates the baseline', async () => {
  const state = { price: 300000 };
  const calls = installFetch(state);
  const env = { TP_TOKEN: 'x', WATCH: fakeKV(), APP_URL: 'https://me.github.io/rsi-watch/travel/' };
  await worker.fetch(req('/api/watch/' + ID, { method: 'PUT', body: JSON.stringify(watchBody({ target: 260000 })) }), env);
  const now = Date.parse('2026-11-09T03:00:00Z');

  let r = await runWatchers(env, now);
  assert.deepEqual(r, { users: 1, sent: 0 });

  state.price = 285000;
  r = await runWatchers(env, now);
  assert.equal(r.sent, 1);
  const push = calls.filter((c) => c.url.startsWith('https://ntfy.sh')).pop();
  const payload = JSON.parse(push.init.body);
  assert.equal(payload.topic, 'eodigaji-test1234');
  assert.match(payload.message, /₩300,000 → ₩285,000/);
  assert.equal(payload.click, 'https://me.github.io/rsi-watch/travel/#favorites');
  let doc = JSON.parse(env.WATCH.m.get('watch:' + ID));
  assert.equal(doc.items[0].baseline, 285000);
  assert.equal(doc.items[0].lastPrice, 285000);

  r = await runWatchers(env, now); // 같은 가격 → 알림 없음
  assert.equal(r.sent, 0);

  state.price = 259000; // 새 최저가 + 목표가 도달 → 한 번만 보냄
  r = await runWatchers(env, now);
  assert.equal(r.sent, 1);
  assert.match(JSON.parse(calls.filter((c) => c.url.startsWith('https://ntfy.sh')).pop().init.body).title, /목표가/);

  // 출발일이 지나면 확인하지 않음
  r = await runWatchers(env, Date.parse('2026-12-19T03:00:00Z'));
  assert.equal(r.sent, 0);
  doc = JSON.parse(env.WATCH.m.get('watch:' + ID));
  assert.equal(doc.items[0].lastPrice, 259000);
});

test('test push endpoint sends to the stored topic', async () => {
  const calls = installFetch({ price: 1 });
  const env = { TP_TOKEN: 'x', WATCH: fakeKV() };
  assert.equal((await worker.fetch(req('/api/watch/' + ID + '/test', { method: 'POST' }), env)).status, 404);
  await worker.fetch(req('/api/watch/' + ID, { method: 'PUT', body: JSON.stringify(watchBody()) }), env);
  const res = await worker.fetch(req('/api/watch/' + ID + '/test', { method: 'POST' }), env);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(calls.pop().init.body).topic, 'eodigaji-test1234');
});
