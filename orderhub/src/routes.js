'use strict';
// REST API
const { listConnectors, getConnector } = require('./connectors');
const { COURIERS, trackingUrl } = require('./couriers');
const { getAppSettings, updateAppSettings } = require('./settings');
const { ordersToCsv } = require('./csv');
const { verifyPassword } = require('./secrets');
const { nowIso, mask, str, safeJson, HttpError } = require('./util');

let ipCache = { ip: null, at: 0 };
async function detectPublicIp() {
  if (ipCache.ip && Date.now() - ipCache.at < 10 * 60000) return ipCache.ip;
  const sources = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com', 'https://checkip.amazonaws.com'];
  for (const url of sources) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'curl/8' } });
      const t = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t) || /^[0-9a-f:]+$/i.test(t)) {
        ipCache = { ip: t, at: Date.now() };
        return t;
      }
    } catch {}
  }
  return null;
}

function validateCreds(type, creds, { partial = false } = {}) {
  const c = getConnector(type);
  const out = {};
  for (const f of c.fields) {
    const v = str(creds?.[f.key]);
    if (v) out[f.key] = v;
    else if (f.required && !partial) throw new HttpError(400, `${f.label}을(를) 입력해주세요`);
  }
  return out;
}

function ids(body) {
  const list = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!list.length) throw new HttpError(400, '주문을 선택해주세요');
  if (list.length > 500) throw new HttpError(400, '한 번에 500건까지 처리할 수 있습니다');
  return list;
}

function register(router, app) {
  const { db, auth, orders, inquiries, sales, actions, sync, notifier, secrets, config } = app;

  function storeView(s) {
    let maskedCreds = {};
    try {
      const c = s.credentials ? secrets.decrypt(s.credentials) : {};
      for (const [k, v] of Object.entries(c)) maskedCreds[k] = mask(v);
    } catch {
      maskedCreds = { error: '복호화 실패 - 다시 입력해주세요' };
    }
    const state = safeJson(s.state, {});
    return {
      id: s.id,
      type: s.type,
      name: s.name,
      enabled: !!s.enabled,
      credentials: maskedCreds,
      lastSyncAt: s.last_sync_at,
      lastSuccessAt: s.last_success_at,
      lastError: s.last_error,
      inquiryError: state.inquiryError || null,
      synced: !!state._syncedOnce,
      createdAt: s.created_at,
      orderCount: db.get('SELECT COUNT(*) AS n FROM orders WHERE store_id = ?', s.id).n,
    };
  }

  // ---------- 인증 ----------
  router.get('/api/auth/status', (req) => ({ setupRequired: !auth.hasPassword(), loggedIn: req.loggedIn }), { public: true });

  router.post(
    '/api/auth/setup',
    (req, res) => {
      if (auth.hasPassword()) throw new HttpError(400, '이미 비밀번호가 설정되어 있습니다');
      auth.setPassword(req.body?.password);
      const token = auth.createSession({ ip: req.ip, userAgent: req.headers['user-agent'] });
      res.setHeader('Set-Cookie', auth.cookie(token, req.secure));
      db.addEvent({ type: 'auth', message: '관리자 비밀번호 설정' });
      return { ok: true };
    },
    { public: true }
  );

  router.post(
    '/api/auth/login',
    (req, res) => {
      const token = auth.login(req.body?.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
      res.setHeader('Set-Cookie', auth.cookie(token, req.secure));
      return { ok: true };
    },
    { public: true }
  );

  router.post(
    '/api/auth/logout',
    (req, res) => {
      auth.logout(req.sessionToken);
      res.setHeader('Set-Cookie', auth.clearCookie(req.secure));
      return { ok: true };
    },
    { public: true }
  );

  router.post('/api/auth/password', (req, res) => {
    const { current, next } = req.body || {};
    if (!verifyPassword(current, db.getSetting('admin_password'))) throw new HttpError(400, '현재 비밀번호가 올바르지 않습니다');
    auth.setPassword(next);
    auth.logoutAll();
    const token = auth.createSession({ ip: req.ip, userAgent: req.headers['user-agent'] });
    res.setHeader('Set-Cookie', auth.cookie(token, req.secure));
    db.addEvent({ type: 'auth', message: '관리자 비밀번호 변경' });
    return { ok: true };
  });

  // ---------- 기본 정보 ----------
  router.get('/api/meta', () => ({
    connectors: listConnectors(),
    couriers: COURIERS.map((c) => ({
      key: c.key,
      name: c.name,
      labels: c.labels || null,
      noTracking: !!c.noTracking,
      naver: !!c.naver,
      coupang: !!c.coupang,
      elevenst: !!c.elevenst,
      gmarket: !!c.esm,
      auction: !!c.esm,
      lotteon: !!c.lotteon,
    })),
    settings: getAppSettings(db),
    publicUrl: config.publicUrl,
    version: require('../package.json').version,
  }));

  router.get('/api/server-ip', async () => ({ ip: await detectPublicIp() }));

  // ---------- 주문 ----------
  router.get('/api/orders/counts', (req) => orders.counts(req.query.store));

  router.get('/api/orders', (req) => {
    const r = orders.list({
      tab: req.query.tab,
      storeId: req.query.store,
      q: req.query.q,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      limit: req.query.limit,
    });
    return {
      ...r,
      counts: orders.counts(req.query.store),
      unseen: orders.unseenCount(),
      unseenHere: orders.unseenCount(req.query.store || null),
      maxId: orders.maxId(),
    };
  });

  // 신규주문 확인 처리 → 메뉴 숫자에서 빠짐
  router.post('/api/orders/seen', (req) => {
    const b = req.body || {};
    if (Array.isArray(b.ids)) orders.markSeen({ ids: b.ids });
    else orders.markSeen({ upTo: b.upTo, storeId: b.store || null });
    return { unseen: orders.unseenCount() };
  });

  router.get('/api/orders/export.csv', (req, res) => {
    let list;
    if (req.query.ids) {
      const wanted = String(req.query.ids)
        .split(',')
        .map(Number)
        .filter(Boolean)
        .slice(0, 2000);
      list = wanted.map((id) => orders.get(id)).filter(Boolean);
    } else {
      list = orders.list({ tab: req.query.tab || 'new', storeId: req.query.store, q: req.query.q, limit: 500 }).orders.map((o) => orders.get(o.id));
    }
    const csv = ordersToCsv(list);
    const name = `orderhub_${new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16).replace(/[-:T]/g, '')}.csv`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    res.end(csv);
    return undefined;
  });

  router.get('/api/orders/:id', (req) => {
    const o = orders.get(Number(req.params.id));
    if (!o) throw new HttpError(404, '주문을 찾을 수 없습니다');
    o.events = db.all('SELECT ts, level, type, message FROM events WHERE order_id = ? ORDER BY id DESC LIMIT 50', o.id);
    o.trackingUrl = trackingUrl(o.courier_key, o.tracking_no);
    o.items = o.items.map((i) => ({ ...i, raw: safeJson(i.raw, null) }));
    return o;
  });

  router.post('/api/orders/confirm', async (req) => ({ results: await actions.confirm(ids(req.body)) }));
  router.post('/api/orders/purchase', async (req) => ({ results: await actions.purchase(ids(req.body), req.body || {}) }));
  router.post('/api/orders/dispatch', async (req) => ({ results: await actions.dispatch(ids(req.body)) }));
  router.post('/api/orders/invoices/bulk', async (req) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 1000) : [];
    if (!rows.length) throw new HttpError(400, '등록할 송장이 없습니다');
    return { report: await actions.bulkInvoices(rows, { dispatch: !!req.body.dispatch }) };
  });
  router.post('/api/orders/:id/invoice', async (req) => {
    const o = actions.saveInvoice(req.params.id, { courierKey: req.body?.courierKey, trackingNo: req.body?.trackingNo });
    if (req.body?.dispatch) {
      const [r] = await actions.dispatch([o.id]);
      return { ok: r.ok, message: r.message };
    }
    return { ok: true, message: '송장이 저장되었습니다' };
  });
  router.post('/api/orders/:id/update', (req) => {
    actions.update(req.params.id, req.body || {});
    return { ok: true };
  });
  router.post('/api/orders/:id/revert', (req) => actions.revert(req.params.id));
  router.post('/api/orders/:id/cancel-local', (req) => actions.cancelLocal(req.params.id));

  // ---------- 매출 ----------
  router.get('/api/sales', (req) => sales.report({ from: req.query.from, to: req.query.to }));

  router.get('/api/sales/export.csv', (req, res) => {
    const storeIds = req.query.stores
      ? String(req.query.stores)
          .split(',')
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
      : null;
    const { name, body } = sales.csv({
      from: req.query.from,
      to: req.query.to,
      view: req.query.view === 'daily' ? 'daily' : 'stores',
      storeIds,
      shipping: req.query.shipping === '1',
    });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return undefined;
  });

  // 지난 주문 불러오기 (오래 걸릴 수 있어 바로 응답하고 진행 상황은 GET 으로 확인)
  router.get('/api/sales/backfill', () => ({ backfill: sync.backfillState }));
  router.post('/api/sales/backfill', (req) => {
    const days = Number(req.body?.days);
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new HttpError(400, '1~31일 중에서 골라주세요');
    const storeId = req.body?.storeId ? Number(req.body.storeId) : null;
    if (storeId && !db.get('SELECT id FROM stores WHERE id = ?', storeId)) throw new HttpError(404, '스토어를 찾을 수 없습니다');
    if (!sync.backfillState?.running) {
      db.addEvent({ storeId, type: 'sync', message: `지난 ${days}일 주문 불러오기 시작` });
      sync.backfill({ days, storeId }).catch(() => {});
    }
    return { backfill: sync.backfillState };
  });

  // ---------- 고객 문의 ----------
  router.get('/api/inquiries', (req) => {
    const storeId = Number(req.query.store) || null;
    const per = new Map(inquiries.storeCounts().map((r) => [r.storeId, r]));
    // 문의를 가져오는 스토어 목록 (스토어별 보기)
    const stores = db
      .all('SELECT id, type, name, enabled FROM stores ORDER BY id')
      .filter((s) => {
        try {
          return !!getConnector(s.type).inquiries;
        } catch {
          return false;
        }
      })
      .map((s) => ({ id: s.id, type: s.type, name: s.name, enabled: !!s.enabled, open: per.get(s.id)?.open || 0, all: per.get(s.id)?.n || 0 }));
    // 문의마다 오더허브에서 바로 답변할 수 있는지 + 안 되면 이유 (예: 쿠팡 Wing 아이디 없음)
    const credsCache = new Map();
    const credsOf = (id) => {
      if (!credsCache.has(id)) {
        let c = {};
        try {
          const row = db.get('SELECT credentials FROM stores WHERE id = ?', id);
          c = row?.credentials ? secrets.decrypt(row.credentials) : {};
        } catch {}
        credsCache.set(id, c);
      }
      return credsCache.get(id);
    };
    const list = inquiries.list({ filter: req.query.filter === 'all' ? 'all' : 'open', storeId }).map((q) => {
      let c = null;
      try {
        c = getConnector(q.store_type);
      } catch {}
      const ok = !!(c?.answerable && c.answerInquiry);
      const hint = ok && !q.answered && c.answerCheck ? c.answerCheck(credsOf(q.store_id), q) : null;
      return { ...q, can_answer: ok && !hint, answer_hint: hint || null };
    });
    return {
      inquiries: list,
      counts: inquiries.counts(storeId),
      total: inquiries.counts(),
      stores,
    };
  });
  // 셀러센터에서 답변한 문의를 '답변 완료'로 표시
  router.post('/api/inquiries/:id/done', (req) => {
    const q = inquiries.get(req.params.id);
    if (!q) throw new HttpError(404, '문의를 찾을 수 없습니다');
    inquiries.markHandled(q.id);
    db.addEvent({ storeId: q.store_id, type: 'inquiry', message: `문의를 답변 완료로 표시: ${inquiries.describe(q).slice(0, 40)}` });
    return { ok: true };
  });
  router.post('/api/inquiries/:id/answer', async (req) => {
    const q = inquiries.get(req.params.id);
    if (!q) throw new HttpError(404, '문의를 찾을 수 없습니다');
    const text = str(req.body?.text);
    if (!text) throw new HttpError(400, '답변 내용을 입력해주세요');
    if (text.length > 2000) throw new HttpError(400, '답변은 2000자 이내로 입력해주세요');
    const store = db.get('SELECT * FROM stores WHERE id = ?', q.store_id);
    const c = getConnector(store.type);
    if (!c.answerable || !c.answerInquiry) throw new HttpError(400, `${c.label} 문의는 셀러센터에서 답변해주세요`);
    const ctx = sync.ctxFor(store);
    const reason = c.answerCheck ? c.answerCheck(ctx.creds, q) : null;
    if (reason) throw new HttpError(400, reason);
    await c.answerInquiry(ctx, q, text);
    inquiries.markAnswered(q.id, text);
    db.addEvent({ storeId: store.id, type: 'inquiry', message: `문의 답변 등록: ${inquiries.describe(q).slice(0, 40)}` });
    return { ok: true };
  });

  // ---------- 스토어 ----------
  router.get('/api/stores', () => ({ stores: db.all('SELECT * FROM stores ORDER BY id').map(storeView) }));

  router.post('/api/stores/test', async (req) => {
    const type = str(req.body?.type);
    const creds = validateCreds(type, req.body?.credentials || {});
    const c = getConnector(type);
    const r = await c.test(sync.ctxFor({ id: 0, type, credentials: secrets.encrypt(creds), state: '{}' }));
    return r;
  });

  router.post('/api/stores', async (req) => {
    const type = str(req.body?.type);
    const c = getConnector(type);
    const name = str(req.body?.name) || c.label;
    const creds = validateCreds(type, req.body?.credentials || {});
    const r = db.run(
      'INSERT INTO stores(type, name, enabled, credentials, state, created_at) VALUES(?, ?, 1, ?, ?, ?)',
      type,
      name.slice(0, 50),
      secrets.encrypt(creds),
      '{}',
      nowIso()
    );
    const id = Number(r.lastInsertRowid);
    db.addEvent({ storeId: id, type: 'store', message: `스토어 추가: ${name}` });
    // 바로 첫 수집 (응답은 기다리지 않음)
    sync.runAll({ manual: true, storeId: id }).catch(() => {});
    return { store: storeView(db.get('SELECT * FROM stores WHERE id = ?', id)) };
  });

  router.put('/api/stores/:id', (req) => {
    const s = db.get('SELECT * FROM stores WHERE id = ?', Number(req.params.id));
    if (!s) throw new HttpError(404, '스토어를 찾을 수 없습니다');
    const b = req.body || {};
    if (b.name !== undefined) db.run('UPDATE stores SET name = ? WHERE id = ?', str(b.name).slice(0, 50) || s.name, s.id);
    if (b.enabled !== undefined) db.run('UPDATE stores SET enabled = ? WHERE id = ?', b.enabled ? 1 : 0, s.id);
    if (b.credentials && Object.values(b.credentials).some((v) => str(v))) {
      const prev = s.credentials ? secrets.decrypt(s.credentials) : {};
      const next = { ...prev, ...validateCreds(s.type, b.credentials, { partial: true }) };
      db.run('UPDATE stores SET credentials = ?, last_error = NULL WHERE id = ?', secrets.encrypt(next), s.id);
      db.addEvent({ storeId: s.id, type: 'store', message: 'API 키 변경' });
    }
    return { store: storeView(db.get('SELECT * FROM stores WHERE id = ?', s.id)) };
  });

  router.delete('/api/stores/:id', (req) => {
    const s = db.get('SELECT * FROM stores WHERE id = ?', Number(req.params.id));
    if (!s) throw new HttpError(404, '스토어를 찾을 수 없습니다');
    db.run('DELETE FROM stores WHERE id = ?', s.id);
    db.addEvent({ type: 'store', message: `스토어 삭제: ${s.name} (주문 기록 포함)` });
    return { ok: true };
  });

  router.post('/api/stores/:id/test', async (req) => {
    const s = db.get('SELECT * FROM stores WHERE id = ?', Number(req.params.id));
    if (!s) throw new HttpError(404, '스토어를 찾을 수 없습니다');
    return getConnector(s.type).test(sync.ctxFor(s));
  });

  // ---------- 수집 ----------
  router.get('/api/sync/status', () => sync.status());
  router.post('/api/sync', async (req) => {
    const r = await sync.runAll({ manual: true, storeId: req.body?.storeId ? Number(req.body.storeId) : null });
    return r;
  });

  // ---------- 설정 ----------
  router.get('/api/settings', () => ({ app: getAppSettings(db), notify: notifier.publicConfig() }));
  router.put('/api/settings', (req) => {
    const app2 = req.body?.app ? updateAppSettings(db, req.body.app) : getAppSettings(db);
    if (req.body?.app && 'pollIntervalMin' in req.body.app) sync.reschedule();
    const notify = req.body?.notify ? notifier.updateConfig(req.body.notify) : notifier.publicConfig();
    return { app: app2, notify };
  });

  // ---------- 알림 ----------
  router.get('/api/push/key', () => ({ publicKey: notifier.webpush.publicKey }));
  router.post('/api/push/subscribe', (req) => {
    notifier.webpush.subscribe(req.body?.subscription, req.headers['user-agent']);
    db.addEvent({ type: 'notify', message: '웹푸시 기기 등록' });
    return { ok: true, subscriptions: notifier.webpush.count() };
  });
  router.post('/api/push/unsubscribe', (req) => {
    if (req.body?.endpoint) notifier.webpush.unsubscribe(req.body.endpoint);
    return { ok: true, subscriptions: notifier.webpush.count() };
  });
  router.post('/api/notify/test', async (req) => ({ ok: true, result: await notifier.test(str(req.body?.channel)) }));
  router.post('/api/notify/telegram/detect', async (req) => ({ chats: await notifier.detectTelegramChats(str(req.body?.botToken)) }));

  // ---------- 로그 ----------
  router.get('/api/events', (req) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    return {
      events: db.all(
        `SELECT e.id, e.ts, e.level, e.type, e.message, e.order_id, e.store_id, s.name AS store_name
         FROM events e LEFT JOIN stores s ON s.id = e.store_id WHERE e.type != 'new_order' ORDER BY e.id DESC LIMIT ?`,
        limit
      ),
    };
  });
}

module.exports = { register, detectPublicIp };
