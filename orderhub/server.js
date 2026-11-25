'use strict';
// 오더허브 - 주문 수집 · 발주/송장 관리 · 신규주문 알림 서버
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js 22.13 이상이 필요합니다 (현재 ${process.version}). https://nodejs.org 에서 LTS 버전을 설치해주세요.`);
  process.exit(1);
}

const http = require('node:http');
// 마켓에 등록하는 서버 IP 는 IPv4 → IPv6 가 있어도 IPv4 로 먼저 연결
require('node:dns').setDefaultResultOrder('ipv4first');
const path = require('node:path');
const config = require('./src/config');
const { Db } = require('./src/db');
const { Secrets } = require('./src/secrets');
const { Auth, COOKIE } = require('./src/auth');
const { OrderStore } = require('./src/orders');
const { InquiryStore } = require('./src/inquiries');
const { SalesReport } = require('./src/sales');
const { Notifier } = require('./src/notify');
const { SyncEngine } = require('./src/sync');
const { Actions } = require('./src/actions');
const { Router, readBody, parseCookies, sendJson, serveStatic } = require('./src/http');
const { register, detectPublicIp } = require('./src/routes');
const { HttpError } = require('./src/util');

function createApp(cfg = config) {
  const db = new Db(cfg.dbFile || path.join(cfg.dataDir, 'orderhub.db'));
  const secrets = new Secrets(cfg);
  const auth = new Auth(db, cfg);
  const orders = new OrderStore(db);
  const inquiries = new InquiryStore(db);
  const sales = new SalesReport(db);
  const notifier = new Notifier({ db, secrets, config: cfg });
  const sync = new SyncEngine({ db, secrets, config: cfg, notifier, orders, inquiries });
  const actions = new Actions({ db, orders, sync });
  sync.actions = actions;

  const router = new Router();
  const app = { db, secrets, auth, orders, inquiries, sales, notifier, sync, actions, config: cfg, router };
  register(router, app);

  const publicDir = path.join(cfg.root, 'public');

  app.handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const fwdProto = cfg.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    req.secure = fwdProto === 'https' || !!req.socket.encrypted;
    const fwdFor = cfg.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    req.ip = fwdFor || req.socket.remoteAddress || '';

    if (pathname === '/healthz') return sendJson(res, 200, { ok: true });

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method Not Allowed' });
      if (serveStatic(publicDir, req, res, pathname)) return;
      // 해시 라우팅 SPA: 알 수 없는 경로는 index.html
      if (!path.extname(pathname) && serveStatic(publicDir, req, res, '/')) return;
      return sendJson(res, 404, { error: 'Not Found' });
    }

    try {
      const m = router.match(req.method, pathname);
      if (!m) throw new HttpError(404, '없는 API입니다');
      const cookies = parseCookies(req.headers.cookie);
      req.sessionToken = cookies[COOKIE];
      req.loggedIn = auth.validate(req.sessionToken);
      if (!m.route.opts.public && !req.loggedIn) throw new HttpError(401, '로그인이 필요합니다');
      // CSRF 방지: 상태를 바꾸는 요청은 앱에서 보낸 커스텀 헤더 필수
      if (req.method !== 'GET' && req.headers['x-orderhub'] !== '1') throw new HttpError(403, '잘못된 요청입니다');
      req.params = m.params;
      req.query = Object.fromEntries(url.searchParams.entries());
      if (req.method !== 'GET') {
        const text = await readBody(req);
        try {
          req.body = text ? JSON.parse(text) : {};
        } catch {
          throw new HttpError(400, 'JSON 형식 오류');
        }
      }
      const result = await m.route.handler(req, res);
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
    } catch (e) {
      // 의도적으로 던진 오류(마켓 API 오류 등)는 사용자에게 보여줄 400, 프로그램 오류는 500
      const isBug = e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError || e instanceof RangeError || /^ERR_/.test(e.code || '');
      const status = e instanceof HttpError ? e.status : isBug ? 500 : 400;
      if (status >= 500) console.error('[api]', req.method, pathname, e);
      if (!res.headersSent) sendJson(res, status, { error: e.message || '서버 오류', ...(e.diagnostic ? { diagnostic: String(e.diagnostic) } : {}) });
    }
  };

  return app;
}

if (require.main === module) {
  const app = createApp();
  const server = http.createServer(app.handler);
  server.listen(config.port, config.host, async () => {
    console.log(`\n  ✅ 오더허브 실행 중: http://localhost:${config.port}   ← 이 PC의 브라우저에서 여세요`);
    if (config.publicUrl) console.log(`  🌐 외부 주소: ${config.publicUrl}`);
    // 같은 와이파이에 연결된 휴대폰에서 열 수 있는 주소
    const lan = Object.values(require('node:os').networkInterfaces())
      .flat()
      .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
      .map((i) => `http://${i.address}:${config.port}`);
    if (lan.length && config.host === '0.0.0.0') console.log(`  📱 같은 와이파이의 휴대폰에서: ${lan.join('  ')}`);
    console.log(`  📁 데이터 폴더: ${config.dataDir}`);
    if (!app.auth.hasPassword()) console.log('  🔑 처음 접속하면 관리자 비밀번호를 설정합니다.');
    const ip = await detectPublicIp().catch(() => null);
    if (ip) console.log(`  📌 마켓 API에 등록할 서버 공인 IP: ${ip}`);
    console.log('');
    app.sync.start();
  });
  const shutdown = () => {
    app.sync.stop();
    server.close(() => {
      app.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
