// 최저가 레이더 — Cloudflare Worker
//  - /api/* : 앱 API
//  - 그 밖의 주소 : public/ 폴더의 화면 파일
//  - 10분마다 : 가격 확인 (checker.js)
import { ensureSchema, getMeta, setMeta, hitLimit, refreshWatchers, history, countingDb } from './db.js';
import { makeApi, partnersConfigured, Budget, ApiError } from './coupang.js';
import { parseInput, parseProductUrl, isShortLink, normalizeKeyword, keywordFromName, cleanName } from './parse.js';
import { runChecks, searchCached, applyResults, refreshFeed, FEEDS, budgetPlan, sendToUser } from './checker.js';
import { pushConfigured, validEndpoint } from './push.js';
import { json, HttpError, randomToken, sha256Hex, intEnv, toInt } from './util.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DISCLOSURE = '이 서비스는 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // 요청마다 D1 쿼리 수를 센다 (무료 플랜: 요청당 50개)
    env = { ...env, DB: countingDb(env.DB) };
    try {
      await ensureSchema(env.DB);
      await rememberOrigin(env, url);
      return await route(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      if (e && e.budget) return json({ error: e.message, budget: true }, 429);
      console.log('[api] 오류', (e && e.stack) || e);
      return json({ error: '서버 오류가 났어요. 잠시 후 다시 시도해 주세요.' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env).then((s) => console.log('[cron]', JSON.stringify(s))));
  },
};

// 푸시 서명(VAPID)의 연락처로 쓸 서비스 주소를 기억해 둔다
let originSeen = null;
async function rememberOrigin(env, url) {
  const origin = url.origin;
  if (origin === originSeen) return;
  const ok = url.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (ok && (await getMeta(env.DB, 'origin')) !== origin) await setMeta(env.DB, 'origin', origin);
  originSeen = origin;
}

async function readJson(request) {
  if (!/application\/json/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'JSON 요청만 받아요.');
  const text = await request.text();
  if (text.length > 16 * 1024) throw new HttpError(413, '요청이 너무 커요.');
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'JSON 형식이 올바르지 않아요.'); }
}

async function auth(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+([\w-]{20,100})$/);
  if (!m) throw new HttpError(401, '기기 정보가 없어요.', { relogin: true });
  const user = await env.DB.prepare('SELECT id, night_ok, last_seen_at FROM users WHERE token_hash = ?').bind(await sha256Hex(m[1])).first();
  if (!user) throw new HttpError(401, '등록되지 않은 기기예요.', { relogin: true });
  if (!user.last_seen_at || Date.now() - user.last_seen_at > HOUR) {
    await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(Date.now(), user.id).run();
  }
  return user;
}

function adminAuth(request, env) {
  const given = request.headers.get('X-Admin-Token') || '';
  const want = env.ADMIN_TOKEN || '';
  if (!want || want.length < 16) throw new HttpError(403, '관리자 토큰(ADMIN_TOKEN)이 설정되지 않았어요.');
  let diff = given.length ^ want.length;
  for (let i = 0; i < Math.max(given.length, want.length); i++) diff |= (given.charCodeAt(i) || 0) ^ (want.charCodeAt(i) || 0);
  if (diff !== 0) throw new HttpError(403, '관리자 토큰이 맞지 않아요.');
}

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'local';

// ---------------- 응답 모양 ----------------
const WATCH_SQL = `SELECT w.id, w.kind, w.ref, w.target_price, w.notify_drop, w.created_at,
    p.name AS p_name, p.image AS p_image, p.partner_url AS p_url, p.source_url AS p_src, p.price AS p_price, p.is_rocket AS p_rocket,
    p.prev_price AS p_prev, p.min_price AS p_min, p.max_price AS p_max,
    p.status AS p_status, p.last_found_at AS p_found, p.last_checked_at AS p_checked, p.changed_at AS p_changed,
    k.label AS k_label, k.price AS k_price, k.results AS k_results, k.best_product_id AS k_best, k.last_checked_at AS k_checked, k.changed_at AS k_changed,
    k.prev_price AS k_prev, k.min_price AS k_min, k.max_price AS k_max
  FROM watches w
  LEFT JOIN products p ON w.kind = 'product' AND p.id = w.ref
  LEFT JOIN keywords k ON w.kind = 'keyword' AND k.id = w.ref`;

function shapeWatch(r) {
  const base = { id: r.id, kind: r.kind, ref: r.ref, targetPrice: r.target_price, notifyDrop: Boolean(r.notify_drop), createdAt: r.created_at };
  if (r.kind === 'keyword') {
    let results = [];
    try { results = r.k_results ? JSON.parse(r.k_results) : []; } catch { /* 무시 */ }
    const best = results.find((x) => x.productId === r.k_best) || null;
    return {
      ...base, name: r.k_label, price: r.k_price, prevPrice: r.k_prev, minPrice: r.k_min, maxPrice: r.k_max,
      image: best ? best.image : null, url: best ? best.url : null,
      bestName: best ? best.name : null, status: r.k_price ? 'ok' : 'pending', lastFoundAt: r.k_checked, lastCheckedAt: r.k_checked, changedAt: r.k_changed, results,
    };
  }
  return {
    ...base, name: r.p_name, price: r.p_price, prevPrice: r.p_prev, minPrice: r.p_min, maxPrice: r.p_max,
    image: r.p_image, url: r.p_url || r.p_src, partner: Boolean(r.p_url), isRocket: Boolean(r.p_rocket),
    status: r.p_status, lastFoundAt: r.p_found, lastCheckedAt: r.p_checked, changedAt: r.p_changed,
  };
}

async function statusInfo(env) {
  const limit = intEnv(env, 'API_HOURLY_LIMIT', 20, 1, 1000);
  let last = null;
  try { last = JSON.parse((await getMeta(env.DB, 'last_run')) || 'null'); } catch { /* 무시 */ }
  const plan = budgetPlan(limit);
  const active = last && last.active ? last.active : 0;
  const interval = intEnv(env, 'CHECK_INTERVAL_MIN', 60, 10, 1440);
  const cycleMin = Math.max(interval, Math.ceil((active / plan.cronPerHour) * 60));
  return {
    mode: partnersConfigured(env) ? 'live' : 'mock',
    lastRunAt: last ? last.at : null,
    pausedUntil: Number(await getMeta(env.DB, 'api_paused_until')) || 0,
    cycleMin, // 상품 하나를 다시 확인하기까지 걸리는 대략의 시간(분)
  };
}

function itemCard(x) {
  return { productId: x.productId, name: x.name, price: x.price, image: x.image, url: x.url, isRocket: x.isRocket };
}

async function resolveShortLink(shortUrl) {
  let current = shortUrl;
  for (let hop = 0; hop < 4; hop++) {
    if (!isShortLink(current) && !/(^|\.)coupang\.com$/i.test(new URL(current).hostname)) return null;
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    const loc = res.headers.get('location');
    if (!loc) return null;
    current = new URL(loc, current).href;
    const p = parseProductUrl(current);
    if (p) return p.productId;
  }
  return null;
}

// ---------------- 라우터 ----------------
async function route(request, env, url) {
  const db = env.DB;
  const { pathname } = url;
  const m = request.method;
  const now = Date.now();

  if (m === 'GET' && pathname === '/api/config') {
    return json({
      appName: env.APP_NAME || '최저가 레이더',
      mode: partnersConfigured(env) ? 'live' : 'mock',
      push: pushConfigured(env),
      vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
      disclosure: DISCLOSURE,
      maxWatches: intEnv(env, 'MAX_WATCHES_PER_USER', 30, 1, 500),
      feeds: FEEDS.map(([key, label]) => ({ key, label })),
    });
  }

  if (m === 'POST' && pathname === '/api/session') {
    if (!(await hitLimit(db, `sess:${clientIp(request)}`, 20, 24 * HOUR, now))) throw new HttpError(429, '이 네트워크에서 너무 많이 만들었어요. 내일 다시 시도해 주세요.');
    const id = randomToken(9);
    const token = randomToken(24);
    await db.prepare('INSERT INTO users (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)').bind(id, await sha256Hex(token), now, now).run();
    return json({ token, userId: id }, 201);
  }

  if (pathname === '/api/me') {
    const user = await auth(request, env);
    if (m === 'GET') {
      const { results } = await db.prepare(`${WATCH_SQL} WHERE w.user_id = ? ORDER BY w.created_at DESC`).bind(user.id).all();
      // 목록에는 기록 대신 직전/최저/최고가만 (알림이 많아도 쿼리 1번)
      const watches = results.map(shapeWatch);
      for (const w of watches) delete w.results;
      const subs = await db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?').bind(user.id).first();
      return json({ user: { id: user.id, nightOk: Boolean(user.night_ok), devices: subs.n }, watches, status: await statusInfo(env), serverTime: now });
    }
    if (m === 'PATCH') {
      const body = await readJson(request);
      if (body.nightOk !== undefined) await db.prepare('UPDATE users SET night_ok = ? WHERE id = ?').bind(body.nightOk ? 1 : 0, user.id).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      const { results: refs } = await db.prepare('SELECT kind, ref FROM watches WHERE user_id = ?').bind(user.id).all();
      await db.batch([
        db.prepare('DELETE FROM watches WHERE user_id = ?').bind(user.id),
        db.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(user.id),
        db.prepare('DELETE FROM pending_alerts WHERE user_id = ?').bind(user.id),
        db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
      ]);
      await refreshWatchers(db, refs);
      return json({ ok: true });
    }
  }

  // 붙여넣은 글 → 상품 찾기
  if (m === 'POST' && pathname === '/api/resolve') {
    const user = await auth(request, env);
    const body = await readJson(request);
    const parsed = parseInput(body.text);
    let productId = parsed.productId;
    let name = cleanName(body.name) || parsed.name;
    if (!productId && parsed.shortUrl) {
      try { productId = await resolveShortLink(parsed.shortUrl); } catch { /* 이름 검색으로 진행 */ }
    }
    const known = productId ? await db.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first() : null;
    if (known && known.price && known.status === 'ok' && now - (known.last_found_at || 0) < 6 * HOUR) {
      return json({ productId, keyword: known.search_keyword, match: itemCard({ productId, name: known.name, price: known.price, image: known.image, url: known.partner_url, isRocket: Boolean(known.is_rocket) }), results: [] });
    }
    if (!name && known && known.name) name = known.name;
    if (!name) return json({ productId, needName: true, shortLink: Boolean(parsed.shortUrl) });
    const keyword = keywordFromName(name) || name;
    const api = makeApi(env);
    let res;
    try {
      res = await searchCached(env, api, keyword, {
        maxAgeMs: 30 * MIN,
        now,
        hintProductId: productId,
        beforeCall: async () => {
          if (!(await hitLimit(db, `search:${user.id}`, 12, HOUR, now))) throw new HttpError(429, '검색을 너무 자주 했어요. 잠시 후 다시 시도해 주세요.');
        },
      });
    } catch (e) {
      if (e && e.budget) return json({ productId, keyword, results: [], budget: true, unavailable: true, message: e.message });
      if (e instanceof ApiError) return json({ productId, keyword, results: [], unavailable: true, message: '지금은 쿠팡에서 가격을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.' });
      throw e;
    }
    await applyResults(env, keyword, res.items, now);
    const match = productId ? res.items.find((i) => i.productId === productId) : null;
    return json({ productId, keyword, match: match ? itemCard(match) : null, results: res.items.slice(0, 10).map(itemCard), mock: Boolean(api.mock) });
  }

  if (m === 'POST' && pathname === '/api/watches') {
    const user = await auth(request, env);
    const body = await readJson(request);
    const max = intEnv(env, 'MAX_WATCHES_PER_USER', 30, 1, 500);
    const cnt = await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE user_id = ?').bind(user.id).first();
    if (cnt.n >= max) throw new HttpError(400, `알림은 ${max}개까지 등록할 수 있어요. 안 쓰는 알림을 지워 주세요.`);
    const target = toInt(body.targetPrice);
    const mock = partnersConfigured(env) ? 0 : 1;
    let kind; let ref;
    if (body.kind === 'keyword') {
      const label = cleanName(body.keyword);
      const id = normalizeKeyword(label);
      if (!id || id.length < 2) throw new HttpError(400, '검색어를 두 글자 이상 입력해 주세요.');
      kind = 'keyword'; ref = id;
      await db.prepare('INSERT OR IGNORE INTO keywords (id, label, created_at, next_check_at, mock) VALUES (?, ?, ?, 0, ?)').bind(id, label.slice(0, 40), now, mock).run();
      const cached = await db.prepare('SELECT results FROM search_cache WHERE keyword = ?').bind(id).first();
      if (cached) {
        await applyResults(env, label, JSON.parse(cached.results), now,
          [db.prepare('UPDATE keywords SET next_check_at = ? WHERE id = ?').bind(now + intEnv(env, 'CHECK_INTERVAL_MIN', 60, 10, 1440) * MIN, id)]);
      }
    } else {
      const productId = String(body.productId || '');
      if (!/^\d{1,20}$/.test(productId)) throw new HttpError(400, '상품 번호가 올바르지 않아요.');
      kind = 'product'; ref = productId;
      const keyword = body.keyword ? keywordFromName(cleanName(body.keyword)) : null;
      let item = null;
      if (keyword) {
        const cached = await db.prepare('SELECT results FROM search_cache WHERE keyword = ?').bind(normalizeKeyword(keyword)).first();
        if (cached) item = JSON.parse(cached.results).find((i) => i.productId === productId) || null;
      }
      if (!item && body.feedKey && FEEDS.some(([k]) => k === body.feedKey)) {
        // 특가/베스트 목록에서 바로 등록한 경우: 서버가 받아 둔 목록에서 정보를 가져온다 (사용자가 보낸 값은 믿지 않음)
        const feed = await db.prepare('SELECT data FROM feed_cache WHERE key = ?').bind(body.feedKey).first();
        if (feed) item = JSON.parse(feed.data).find((i) => i.productId === productId) || null;
      }
      const existing = await db.prepare('SELECT id, search_keyword, partner_url FROM products WHERE id = ?').bind(productId).first();
      if (!keyword && !(existing && existing.search_keyword)) throw new HttpError(400, '상품 이름을 함께 알려주세요. 이름으로 쿠팡에서 가격을 찾아요.');
      if (!existing) {
        const interval = intEnv(env, 'CHECK_INTERVAL_MIN', 60, 10, 1440) * MIN;
        const stmts = [db.prepare(`INSERT INTO products (id, name, image, partner_url, source_url, search_keyword, price, min_price, max_price, changed_at,
            is_rocket, status, created_at, last_found_at, last_checked_at, next_check_at, mock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(productId, item ? item.name : (keyword || null), item ? item.image : null, item ? item.url : null,
            `https://www.coupang.com/vp/products/${productId}`, keyword, item ? item.price : null, item ? item.price : null, item ? item.price : null, item ? now : null,
            item && item.isRocket ? 1 : 0, item ? 'ok' : 'pending', now, item ? now : null, item ? now : null, item ? now + interval : 0, mock)];
        if (item) stmts.push(db.prepare('INSERT OR REPLACE INTO prices (kind, ref, t, price) VALUES (?, ?, ?, ?)').bind('product', productId, now, item.price));
        await db.batch(stmts);
      } else if (keyword && !existing.search_keyword) {
        await db.prepare('UPDATE products SET search_keyword = ?, next_check_at = 0 WHERE id = ?').bind(keyword, productId).run();
      }
      // 수익 링크가 없으면 일반 링크를 파트너스 링크로 바꿔 둔다 (가능할 때만)
      if (!mock && !(item && item.url) && !(existing && existing.partner_url)) {
        try {
          const [d] = await makeApi(env).deeplink([`https://www.coupang.com/vp/products/${productId}`]);
          if (d && d.shortenUrl) await db.prepare('UPDATE products SET partner_url = ? WHERE id = ?').bind(d.shortenUrl, productId).run();
        } catch { /* 다음에 다시 */ }
      }
    }
    const row = await db.prepare(`INSERT INTO watches (user_id, kind, ref, target_price, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, kind, ref) DO UPDATE SET target_price = COALESCE(excluded.target_price, watches.target_price) RETURNING id`)
      .bind(user.id, kind, ref, target, now).first();
    await refreshWatchers(db, [{ kind, ref }]);
    const w = await db.prepare(`${WATCH_SQL} WHERE w.id = ?`).bind(row.id).first();
    return json({ watch: shapeWatch(w) }, 201);
  }

  const wm = pathname.match(/^\/api\/watches\/(\d+)$/);
  if (wm) {
    const user = await auth(request, env);
    const row = await db.prepare(`${WATCH_SQL} WHERE w.id = ? AND w.user_id = ?`).bind(Number(wm[1]), user.id).first();
    if (!row) throw new HttpError(404, '없는 알림이에요.');
    if (m === 'GET') {
      const w = shapeWatch(row);
      w.history = await history(db, w.kind, w.ref, 2000);
      if (w.kind === 'keyword') w.results = w.results.slice(0, 10).map(itemCard);
      return json({ watch: w, status: await statusInfo(env) });
    }
    if (m === 'PATCH') {
      const body = await readJson(request);
      if (body.targetPrice !== undefined) {
        const t = body.targetPrice === null || body.targetPrice === '' ? null : toInt(body.targetPrice);
        if (t !== null && t <= 0) throw new HttpError(400, '목표가는 0보다 커야 해요.');
        await db.prepare('UPDATE watches SET target_price = ? WHERE id = ?').bind(t, row.id).run();
      }
      if (body.notifyDrop !== undefined) await db.prepare('UPDATE watches SET notify_drop = ? WHERE id = ?').bind(body.notifyDrop ? 1 : 0, row.id).run();
      const w = await db.prepare(`${WATCH_SQL} WHERE w.id = ?`).bind(row.id).first();
      return json({ watch: shapeWatch(w) });
    }
    if (m === 'DELETE') {
      await db.prepare('DELETE FROM watches WHERE id = ?').bind(row.id).run();
      await refreshWatchers(db, [{ kind: row.kind, ref: row.ref }]);
      return json({ ok: true });
    }
  }

  if (m === 'GET' && pathname === '/api/feed') {
    const key = url.searchParams.get('key') || 'goldbox';
    const feed = FEEDS.find(([k]) => k === key);
    if (!feed) throw new HttpError(404, '없는 목록이에요.');
    let row = await db.prepare('SELECT data, fetched_at FROM feed_cache WHERE key = ?').bind(key).first();
    let note = null;
    if (!row) {
      // 아직 한 번도 안 받아 온 목록이면, 한도에 여유가 있을 때만 바로 받아 온다
      try {
        const api = makeApi(env);
        const minRemaining = api.mock ? 0 : budgetPlan(api.budget.limit).reserve;
        const { items, write } = await refreshFeed(env, api, key, { minRemaining, now });
        await applyResults(env, null, items, now, [write]);
        row = { data: JSON.stringify(items), fetched_at: now };
      } catch (e) {
        if (!(e && e.budget) && !(e instanceof ApiError)) throw e;
        note = '목록을 준비하고 있어요. 잠시 후 다시 확인해 주세요.';
      }
    }
    const items = row ? JSON.parse(row.data).map(itemCard) : [];
    return json({ key, label: feed[1], items, fetchedAt: row ? row.fetched_at : null, note, mock: !partnersConfigured(env) });
  }

  if (m === 'POST' && pathname === '/api/push/subscribe') {
    const user = await auth(request, env);
    if (!pushConfigured(env)) throw new HttpError(503, '운영자가 아직 알림 키를 설정하지 않았어요.');
    const body = await readJson(request);
    const endpoint = String(body.endpoint || '');
    const p256dh = String((body.keys && body.keys.p256dh) || '');
    const authKey = String((body.keys && body.keys.auth) || '');
    if (!validEndpoint(env, endpoint) || endpoint.length > 800) throw new HttpError(400, '알림 주소가 올바르지 않아요.');
    if (!/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(authKey)) throw new HttpError(400, '알림 키가 올바르지 않아요.');
    await db.prepare(`INSERT INTO subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .bind(endpoint, user.id, p256dh, authKey, now).run();
    // 기기는 사람당 5대까지 (오래된 것부터 정리)
    await db.prepare(`DELETE FROM subscriptions WHERE user_id = ? AND endpoint NOT IN
        (SELECT endpoint FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5)`).bind(user.id, user.id).run();
    return json({ ok: true }, 201);
  }

  if (m === 'POST' && pathname === '/api/push/unsubscribe') {
    const user = await auth(request, env);
    const body = await readJson(request);
    await db.prepare('DELETE FROM subscriptions WHERE endpoint = ? AND user_id = ?').bind(String(body.endpoint || ''), user.id).run();
    return json({ ok: true });
  }

  if (m === 'POST' && pathname === '/api/push/test') {
    const user = await auth(request, env);
    if (!(await hitLimit(db, `pushtest:${user.id}`, 5, HOUR, now))) throw new HttpError(429, '테스트 알림은 1시간에 5번까지예요.');
    const sent = await sendToUser(env, user.id, { title: '🔔 알림이 잘 와요', body: '가격이 내리면 이렇게 알려드릴게요.', url: '/#/', tag: 'test' });
    return json({ sent });
  }

  if (pathname === '/api/admin/stats' && m === 'GET') {
    adminAuth(request, env);
    const q = async (sql, ...b) => (await db.prepare(sql).bind(...b).first()).n;
    const budget = new Budget(env);
    let last = null; let lastErr = null;
    try { last = JSON.parse((await getMeta(db, 'last_run')) || 'null'); } catch { /* 무시 */ }
    try { lastErr = JSON.parse((await getMeta(db, 'last_api_error')) || 'null'); } catch { /* 무시 */ }
    return json({
      mode: partnersConfigured(env) ? 'live' : 'mock',
      users: await q('SELECT COUNT(*) AS n FROM users'),
      activeUsers7d: await q('SELECT COUNT(*) AS n FROM users WHERE last_seen_at > ?', now - 7 * 24 * HOUR),
      watches: await q('SELECT COUNT(*) AS n FROM watches'),
      products: await q('SELECT COUNT(*) AS n FROM products WHERE watchers > 0'),
      keywords: await q('SELECT COUNT(*) AS n FROM keywords WHERE watchers > 0'),
      notFound: await q("SELECT COUNT(*) AS n FROM products WHERE watchers > 0 AND status = 'not_found'"),
      dueNow: (await q('SELECT COUNT(*) AS n FROM products WHERE watchers > 0 AND next_check_at <= ?', now)) + (await q('SELECT COUNT(*) AS n FROM keywords WHERE watchers > 0 AND next_check_at <= ?', now)),
      devices: await q('SELECT COUNT(*) AS n FROM subscriptions'),
      apiCallsLastHour: await budget.used(now),
      apiCalls24h: await q('SELECT COUNT(*) AS n FROM api_log WHERE t > ?', now - 24 * HOUR),
      apiHourlyLimit: budget.limit,
      apiPausedUntil: await budget.pausedUntil(),
      lastApiError: lastErr,
      lastRun: last,
    });
  }

  if (pathname === '/api/admin/run' && m === 'POST') {
    adminAuth(request, env);
    let body = {};
    try { body = await readJson(request); } catch { /* 본문 없이 불러도 됨 */ }
    if (body.force) {
      // 모든 알림을 "지금 확인 대상"으로 돌리고 저장된 검색 결과도 새로 받는다 (호출 한도는 그대로 지킴)
      await db.batch([
        db.prepare('UPDATE products SET next_check_at = 0 WHERE watchers > 0'),
        db.prepare('UPDATE keywords SET next_check_at = 0 WHERE watchers > 0'),
      ]);
    }
    return json(await runChecks(env, { fresh: Boolean(body.force) }));
  }

  throw new HttpError(404, '없는 API예요.');
}
