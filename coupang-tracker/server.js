#!/usr/bin/env node
// 장바구니 시세 — 쿠팡 장바구니 상품 가격 추적 서버
//   npm start        실제 쿠팡 가격 추적
//   npm run demo     가상 데이터로 화면 체험 (쿠팡 접속 없음)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Store } from './lib/store.js';
import { Tracker } from './lib/tracker.js';
import { BrowserManager } from './lib/browser.js';
import { createDemo } from './lib/demo.js';
import { buildBookmarklet } from './lib/extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const DEMO = args.includes('--demo') || process.env.CPT_DEMO === '1';
const argPort = (() => { const i = args.indexOf('--port'); return i >= 0 ? args[i + 1] : null; })();
const PORT = Number(argPort || process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.CPT_DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

fs.mkdirSync(DATA_DIR, { recursive: true });
const dbFile = path.join(DATA_DIR, DEMO ? 'demo.json' : 'db.json');
if (DEMO) { try { fs.rmSync(dbFile); } catch { /* 없음 */ } }
const store = new Store(dbFile).load();

// ---------- 실시간 알림(SSE) ----------
const clients = new Set();
function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

const browser = DEMO ? null : new BrowserManager({
  profileDir: path.join(DATA_DIR, 'browser-profile'),
  getSettings: () => store.settings,
  onChange: () => broadcast('browser', browser.status()),
});
const demo = DEMO ? createDemo({ store }) : null;
const tracker = new Tracker({ store, browser, broadcast, demo });

// ---------- HTTP 도우미 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/i.test(req.headers['content-type'] || '')) {
      reject(new HttpError(415, 'JSON 요청만 받아요.'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, '요청이 너무 커요.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON 형식이 올바르지 않아요.')); }
    });
    req.on('error', reject);
  });
}

// 다른 사이트가 몰래 이 서버를 조작하지 못하도록, 바꾸는 요청은 같은 출처만 허용한다.
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, '허용되지 않은 요청이에요.'); }
  if (host !== req.headers.host) throw new HttpError(403, '허용되지 않은 요청이에요.');
}

function fullState() {
  return {
    version: VERSION,
    demo: DEMO,
    serverTime: Date.now(),
    settings: store.settings,
    status: tracker.publicStatus(),
    browser: browser ? browser.status() : null,
    products: store.products.map((p) => ({ ...store.summary(p), history: store.history(p.id) })),
  };
}

function serveStatic(req, res, pathname) {
  let file;
  if (pathname === '/vendor/lightweight-charts.js') {
    file = path.join(path.dirname(require.resolve('lightweight-charts/package.json')), 'dist', 'lightweight-charts.standalone.production.js');
  } else {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // 화면 주소(#/p/...)는 해시라 서버에 오지 않지만, 혹시 모를 경로는 첫 화면으로
      if (!path.extname(pathname)) return serveStatic(req, res, '/');
      return send(res, 404, 'not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- API ----------
async function api(req, res, url) {
  const { pathname } = url;
  const m = req.method;
  if (m !== 'GET' && m !== 'HEAD') assertSameOrigin(req);

  if (m === 'GET' && pathname === '/api/state') return send(res, 200, fullState());

  if (m === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: status\ndata: ${JSON.stringify(tracker.publicStatus())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return undefined;
  }

  if (m === 'GET' && pathname === '/api/bookmarklet') {
    const origin = `http://${req.headers.host}`;
    return send(res, 200, { origin, code: buildBookmarklet(origin) });
  }

  if (m === 'POST' && pathname === '/api/products') {
    const body = await readJson(req);
    const r = await tracker.addFromInput(body.url || body.text || '');
    return send(res, r.created ? 201 : 200, r);
  }

  const pm = pathname.match(/^\/api\/products\/([\w-]+)(\/check)?$/);
  if (pm) {
    const p = store.getProduct(pm[1]);
    if (!p) throw new HttpError(404, '없는 상품이에요.');
    if (m === 'POST' && pm[2]) {
      tracker.checkOne(p).catch((e) => tracker.setError(p, e));
      return send(res, 202, { ok: true });
    }
    if (m === 'PATCH' && !pm[2]) {
      const body = await readJson(req);
      try { store.updateProduct(p.id, body); } catch (e) { throw new HttpError(400, e.message); }
      tracker.emitProduct(p);
      return send(res, 200, { product: store.summary(p) });
    }
    if (m === 'DELETE' && !pm[2]) {
      store.removeProduct(p.id);
      broadcast('removed', { id: p.id });
      return send(res, 200, { ok: true });
    }
  }

  if (m === 'POST' && pathname === '/api/check') {
    if (tracker.status.running) return send(res, 409, { error: '이미 확인 중이에요.' });
    tracker.runCycle('manual').catch((e) => console.error('[cycle]', e));
    return send(res, 202, { ok: true });
  }

  if (m === 'PUT' && pathname === '/api/settings') {
    const body = await readJson(req);
    let s;
    try { s = store.updateSettings(body); } catch (e) { throw new HttpError(400, e.message); }
    broadcast('settings', s);
    tracker.reschedule();
    return send(res, 200, { settings: s });
  }

  if (m === 'POST' && pathname === '/api/import') {
    const body = await readJson(req);
    if (!body || !Array.isArray(body.items)) throw new HttpError(400, '가져올 상품 목록이 없어요.');
    const kind = body.kind === 'cart' ? 'cart' : 'page';
    const r = tracker.importItems(body.items.slice(0, 500), { kind, source: kind === 'cart' ? 'cart' : 'page' });
    return send(res, 200, { ...r, kind });
  }

  if (m === 'POST' && pathname === '/api/cart/sync') {
    if (!browser) throw new HttpError(400, '데모 모드에서는 장바구니 동기화를 쓸 수 없어요.');
    try {
      const r = await tracker.syncCart();
      return send(res, 200, r);
    } catch (e) {
      throw new HttpError(e.needLogin ? 401 : 502, e.message);
    }
  }

  if (m === 'POST' && pathname === '/api/browser/login') {
    if (!browser) throw new HttpError(400, '데모 모드에서는 쓸 수 없어요.');
    await browser.openLogin().catch((e) => { throw new HttpError(500, e.message); });
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, '없는 API예요.');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname);
    else send(res, 405, 'method not allowed');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[http]', e);
    if (!res.headersSent) send(res, status, { error: e.message || '서버 오류' });
    else res.end();
  }
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const lines = [
    '',
    `  🛒 장바구니 시세 v${VERSION}${DEMO ? '  (데모 모드: 가상 데이터)' : ''}`,
    `  PC에서 열기:        http://localhost:${PORT}`,
  ];
  if (HOST === '0.0.0.0') {
    for (const ip of lanAddresses()) lines.push(`  휴대폰에서 열기:    http://${ip}:${PORT}   (같은 와이파이)`);
  }
  lines.push(`  데이터 파일:        ${dbFile}`, '  끄려면 Ctrl + C', '');
  console.log(lines.join('\n'));
  tracker.start(DEMO ? 3000 : 5000);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  tracker.stop();
  try { store.flush(); } catch (e) { console.error(e); }
  for (const res of clients) res.end();
  if (browser) await browser.close().catch(() => {});
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
