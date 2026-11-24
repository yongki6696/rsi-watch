'use strict';
// 11번가 국내 중계 서버(HTTP CONNECT 프록시) 경유 접속 테스트
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../src/config');
const { createApp } = require('../server');
const { startMock, elevenAddOrder, ELEVEN } = require('./mock-markets');

// 실제 중계 서버(tinyproxy)처럼 CONNECT 만 받는 가짜 중계 서버
function startRelay() {
  const state = { targets: [], deny: false };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, client, head) => {
    sockets.add(client);
    state.targets.push(req.url);
    if (state.deny) return client.end('HTTP/1.1 403 Access denied\r\n\r\n');
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        state,
        close: () => {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(r));
        },
      })
    )
  );
}

test('11번가: 국내 중계 서버를 거쳐 접속 (해외 서버용)', async (t) => {
  const mock = await startMock();
  const relay = await startRelay();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orderhub-relay-'));
  const app = createApp({
    ...baseConfig,
    dataDir: dir,
    dbFile: path.join(dir, 'test.db'),
    secretKey: 'unit-test-secret',
    adminPassword: '',
    elevenstApiBase: `${mock.url}/rest`,
    disableScheduler: true,
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    app.sync.stop();
    await new Promise((r) => server.close(r));
    await relay.close();
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
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status, data });
    return data;
  }
  await call('POST', '/api/auth/setup', { password: 'secret1234' });
  const mockHostPort = new URL(mock.url).host;
  const proxy = `127.0.0.1:${relay.port}`;

  // 중계 서버 경유로 연결 테스트 성공 + 실제로 중계 서버를 거침
  const ok = await call('POST', '/api/stores/test', { type: 'elevenst', credentials: { ...ELEVEN, proxy } });
  assert.equal(ok.ok, true);
  assert.ok(relay.state.targets.includes(mockHostPort), `중계 대상 ${relay.state.targets}`);

  // 저장 후 주문 수집도 중계 서버 경유
  elevenAddOrder(mock.state, { ordNo: '202611230001', dlvNo: '9101' });
  const { store } = await call('POST', '/api/stores', { type: 'elevenst', name: '11번가', credentials: { ...ELEVEN, proxy } });
  const before = relay.state.targets.length;
  await call('POST', '/api/sync', {});
  assert.ok(relay.state.targets.length > before);
  const list = await call('GET', '/api/orders?tab=all&q=202611230001');
  assert.equal(list.orders.length, 1);
  assert.equal((await call('GET', '/api/stores')).stores.find((s) => s.id === store.id).lastError, null);

  // 중계 서버가 이 오더허브를 허용하지 않으면 → 원인 안내 + 단계별 진단
  relay.state.deny = true;
  const denied = await call('POST', `/api/stores/${store.id}/test`).catch((e) => e);
  assert.equal(denied.status, 400);
  assert.match(denied.message, /국내 중계 서버가 연결을 거부했습니다 \(HTTP 403\)/);
  assert.match(denied.data.diagnostic, /① 중계 서버 연결\(TCP \d+\): 연결됨/);
  assert.match(denied.data.diagnostic, /② 중계 서버 → 11번가 연결: 실패 \(HTTP 403\)/);
  relay.state.deny = false;

  // 11번가가 중계 서버 IP를 막으면 → 중계 서버 IP를 11번가에 등록하라는 안내
  mock.state.eleven.reset = true;
  const reset = await call('POST', `/api/stores/${store.id}/test`).catch((e) => e);
  assert.match(reset.message, /11번가가 국내 중계 서버\(127\.0\.0\.1\)의 접속을 막았습니다/);
  mock.state.eleven.reset = false;

  // 중계 서버가 꺼져 있으면
  await call('PUT', `/api/stores/${store.id}`, { credentials: { proxy: '127.0.0.1:1' } });
  const down = await call('POST', `/api/stores/${store.id}/test`).catch((e) => e);
  assert.match(down.message, /국내 중계 서버\(127\.0\.0\.1:1\)에 연결하지 못했습니다/);
  assert.match(down.data.diagnostic, /① 중계 서버 연결\(TCP 1\): 실패/);

  // 중계 서버 없이(직접) 11번가가 끊으면 → 해외 서버일 수 있다는 안내
  const direct = await call('POST', '/api/stores/test', { type: 'elevenst', credentials: ELEVEN }).catch(() => null);
  assert.equal(direct?.ok, true, '직접 연결도 정상 (중계 서버 칸은 선택)');
  mock.state.eleven.reset = true;
  const directReset = await call('POST', '/api/stores/test', { type: 'elevenst', credentials: ELEVEN }).catch((e) => e);
  assert.match(directReset.message, /국내 중계 서버/);
  mock.state.eleven.reset = false;
});
