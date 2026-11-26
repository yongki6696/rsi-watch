// 정기 가격 확인 (Cron 으로 5분마다 실행)
//  - 지난 1시간 호출 수 한도 안에서, 가장 오래 확인 안 한 상품/키워드부터 확인
//  - 한 번의 검색 결과로 그 안에 들어 있는 "모든" 추적 상품 가격을 함께 갱신
//  - 가격이 내리거나 목표가에 닿으면 푸시 알림 (밤 9시~아침 8시는 모아 두었다가 아침에)
//  - Cloudflare 무료 플랜 한도(요청당 D1 쿼리 50개, CPU 10ms)를 넘지 않도록 일을 나눠서 한다
import { ensureSchema, getMeta, setMeta, purgeMock, countingDb, priceChange } from './db.js';
import { makeApi, partnersConfigured, CATEGORIES } from './coupang.js';
import { normalizeKeyword, keywordFromName } from './parse.js';
import { intEnv, isNight } from './util.js';
import { sendPush, vapidKeys } from './push.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
export const INTERACTIVE_SHARE = 0.3; // 한도의 30%는 사용자가 직접 찾는 검색용으로 남겨 둔다
export const RUNS_PER_HOUR = 12; // wrangler.jsonc 의 cron 주기(5분)와 맞춘다
const QUERY_STOP_TARGETS = 26; // 이만큼 쿼리를 썼으면 새 상품 확인은 다음 실행으로
const QUERY_STOP_FEED = 20; // 특가 목록 갱신은 여유가 많을 때만
// 사람 수와 상관없이 문장 하나로 처리하려고 목록을 JSON 하나로 넘긴다 (SQLite json_each)
const IN_JSON = "(SELECT value FROM json_each(?))";

export async function syncMode(env) {
  const mode = partnersConfigured(env) ? 'live' : 'mock';
  const prev = await getMeta(env.DB, 'mode');
  if (prev !== mode) {
    if (prev === 'mock' && mode === 'live') await purgeMock(env.DB);
    await setMeta(env.DB, 'mode', mode);
  }
  return mode;
}

export function budgetPlan(limit) {
  const reserve = Math.ceil(limit * INTERACTIVE_SHARE);
  return { reserve, perRun: Math.max(1, Math.ceil((limit - reserve) / RUNS_PER_HOUR)), cronPerHour: Math.max(1, limit - reserve) };
}

const cacheUpsert = (db, key, items, now) => db.prepare('INSERT INTO search_cache (keyword, results, fetched_at) VALUES (?, ?, ?) ON CONFLICT(keyword) DO UPDATE SET results = excluded.results, fetched_at = excluded.fetched_at')
  .bind(key, JSON.stringify(items), now);

/**
 * 검색 결과를 잠깐 저장해 같은 검색어는 다시 부르지 않는다.
 * @returns {{items:Array, cached:boolean, fetchedAt:number, write:object|null}} write: 캐시에 저장할 문장 (applyResults 와 한 번에 실행)
 */
export async function searchCached(env, api, keyword, { maxAgeMs = 15 * MIN, minRemaining = 1, hintProductId = null, now = Date.now(), beforeCall = null, deferWrite = false } = {}) {
  const key = normalizeKeyword(keyword);
  if (!key) return { items: [], cached: true, fetchedAt: now, write: null };
  const row = await env.DB.prepare('SELECT results, fetched_at FROM search_cache WHERE keyword = ?').bind(key).first();
  if (row && now - row.fetched_at < maxAgeMs && !(api.mock && hintProductId)) {
    return { items: JSON.parse(row.results), cached: true, fetchedAt: row.fetched_at, write: null };
  }
  if (beforeCall) await beforeCall();
  const items = await api.search(keyword, { minRemaining, hintProductId });
  const write = cacheUpsert(env.DB, key, items, now);
  if (!deferWrite) await env.DB.batch([write]);
  return { items, cached: false, fetchedAt: now, write: deferWrite ? write : null };
}

/**
 * 검색/특가 결과에 들어 있는 추적 상품과, 같은 검색어의 키워드 알림을 갱신한다.
 * 쿼리 수를 아끼려고 읽기 2번 + 쓰기는 한 번의 batch 로 묶는다.
 * @returns {Promise<Array<{kind:string, ref:string, prev:number|null, price:number, name:string}>>}
 */
export async function applyResults(env, keyword, items, now = Date.now(), extra = []) {
  const db = env.DB;
  const changes = [];
  const stmts = [...extra.filter(Boolean)];
  if (items.length) {
    const byId = new Map(items.map((i) => [i.productId, i]));
    const ids = [...byId.keys()].slice(0, 90);
    // 아무도 안 보는 상품은 건너뛴다 (다시 누가 등록하면 그때 갱신)
    const { results: rows } = await db.prepare(`SELECT id, name, image, partner_url, is_rocket, status, price, min_price, max_price FROM products WHERE id IN ${IN_JSON} AND watchers > 0`).bind(JSON.stringify(ids)).all();
    for (const row of rows) {
      const it = byId.get(row.id);
      if (row.price !== it.price) {
        stmts.push(...priceChange(db, 'product', row.id, row, it.price, now));
        if (row.price !== null) changes.push({ kind: 'product', ref: row.id, prev: row.price, price: it.price, name: it.name });
      }
      if (row.name !== it.name || (it.image && row.image !== it.image) || (it.url && row.partner_url !== it.url) || Boolean(row.is_rocket) !== it.isRocket) {
        stmts.push(db.prepare('UPDATE products SET name = ?, image = COALESCE(?, image), partner_url = COALESCE(?, partner_url), is_rocket = ? WHERE id = ?')
          .bind(it.name || null, it.image || null, it.url || null, it.isRocket ? 1 : 0, row.id));
      }
    }
    if (rows.length) {
      const seen = rows.map((r) => r.id);
      stmts.push(db.prepare(`UPDATE products SET status = 'ok', miss_count = 0, last_checked_at = ?, last_found_at = ? WHERE id IN ${IN_JSON}`).bind(now, now, JSON.stringify(seen)));
    }
  }
  if (keyword && items.length) {
    const kw = normalizeKeyword(keyword);
    const krow = await db.prepare('SELECT id, label, price, min_price, max_price FROM keywords WHERE id = ?').bind(kw).first();
    if (krow) {
      const best = items.reduce((b, i) => (!b || i.price < b.price ? i : b), null);
      stmts.push(db.prepare('UPDATE keywords SET best_product_id = ?, results = ?, last_checked_at = ? WHERE id = ?').bind(best.productId, JSON.stringify(items.slice(0, 10)), now, kw));
      if (krow.price !== best.price) {
        stmts.push(...priceChange(db, 'keyword', kw, krow, best.price, now));
        if (krow.price !== null) changes.push({ kind: 'keyword', ref: kw, prev: krow.price, price: best.price, name: krow.label });
      }
    }
  }
  if (stmts.length) await db.batch(stmts);
  return changes;
}

const DUE_SQL = `
  SELECT 'product' AS kind, id AS ref, search_keyword AS keyword, name, miss_count, status, next_check_at FROM products
    WHERE next_check_at <= ?1 AND watchers > 0 AND search_keyword IS NOT NULL
  UNION ALL
  SELECT 'keyword' AS kind, id AS ref, label AS keyword, NULL AS name, 0 AS miss_count, 'ok' AS status, next_check_at FROM keywords
    WHERE next_check_at <= ?1 AND watchers > 0
  ORDER BY next_check_at ASC
  LIMIT ?2`;

async function checkTarget(env, api, target, now, { interval, minRemaining, fresh = false }) {
  const db = env.DB;
  const r = await searchCached(env, api, target.keyword, {
    maxAgeMs: fresh ? 0 : 10 * MIN, minRemaining, now, deferWrite: true, hintProductId: target.kind === 'product' ? target.ref : null,
  });
  const jitter = Math.floor(Math.random() * 10 * MIN);
  const extra = [r.write];
  if (target.kind === 'product') {
    if (r.items.some((i) => i.productId === target.ref)) {
      extra.push(db.prepare('UPDATE products SET next_check_at = ? WHERE id = ?').bind(now + interval + jitter, target.ref));
    } else {
      const miss = (target.miss_count || 0) + 1;
      // 한 번 못 찾으면, 쿠팡에 기록된 상품명으로 검색어를 바꿔 다시 시도
      let nextKeyword = null;
      if (target.name) {
        const alt = keywordFromName(target.name);
        if (alt && normalizeKeyword(alt) !== normalizeKeyword(target.keyword)) nextKeyword = alt;
      }
      extra.push(db.prepare('UPDATE products SET miss_count = ?, status = ?, last_checked_at = ?, next_check_at = ?, search_keyword = COALESCE(?, search_keyword) WHERE id = ?')
        .bind(miss, miss >= 3 ? 'not_found' : target.status || 'pending', now, now + (miss >= 3 ? 24 * HOUR : interval) + jitter, nextKeyword, target.ref));
    }
  } else {
    extra.push(db.prepare('UPDATE keywords SET next_check_at = ?, last_checked_at = ? WHERE id = ?').bind(now + interval + jitter, now, target.ref));
  }
  const changes = await applyResults(env, target.keyword, r.items, now, extra);
  return { changes, called: !r.cached };
}

function won(n) { return `${Math.round(n).toLocaleString('ko-KR')}원`; }

export function alertPayload(ch, watchId, hitTarget) {
  const name = String(ch.name || '상품').replace(/^\[데모\]\s*/, '').slice(0, 60);
  const diff = ch.prev - ch.price;
  return {
    title: hitTarget ? `🎯 목표가 도달 · ${won(ch.price)}` : `▼ ${won(diff)} 내렸어요 · ${won(ch.price)}`,
    body: ch.kind === 'keyword' ? `'${name}' 최저가 ${won(ch.prev)} → ${won(ch.price)}` : `${name}\n${won(ch.prev)} → ${won(ch.price)}`,
    url: `/#/w/${watchId}`,
    tag: `w${watchId}`,
  };
}

/** 한 사람에게 여러 알림이 몰리면 하나로 묶는다 */
function combine(payloads) {
  if (payloads.length === 1) return payloads[0];
  return { title: `📉 ${payloads.length}개 알림의 가격이 내렸어요`, body: payloads.slice(0, 3).map((p) => p.title).join('\n'), url: '/#/', tag: 'multi' };
}

/**
 * 여러 사람에게 한 번에 보낸다 (구독 조회 1번, 만료 정리 1번).
 * @param {Map<string, object>} perUser 사람 → 보낼 내용
 * @returns {Promise<{sent:number, done:Set<string>, skipped:string[]}>} skipped: 이번 실행 한도 때문에 못 보낸 사람
 */
export async function sendMany(env, perUser, { maxPush = 8 } = {}) {
  const done = new Set(); const skipped = [];
  if (!perUser.size) return { sent: 0, done, skipped };
  const keys = await vapidKeys(env);
  if (!keys) { for (const u of perUser.keys()) done.add(u); return { sent: 0, done, skipped }; }
  const db = env.DB;
  const users = [...perUser.keys()];
  const { results: subs } = await db.prepare(`SELECT endpoint, user_id, p256dh, auth FROM subscriptions WHERE user_id IN ${IN_JSON}`).bind(JSON.stringify(users)).all();
  const subject = env.VAPID_SUBJECT || (await getMeta(db, 'origin')) || 'mailto:admin@example.com';
  const vapidCache = new Map();
  const expired = [];
  let sent = 0; let attempts = 0;
  for (const u of users) {
    const mine = subs.filter((s) => s.user_id === u);
    if (mine.length && attempts + mine.length > maxPush) { skipped.push(u); continue; }
    for (const s of mine) {
      attempts++;
      try {
        const status = await sendPush(keys, s, perUser.get(u), subject, vapidCache);
        if (status === 404 || status === 410) expired.push(s.endpoint);
        else if (status >= 200 && status < 300) sent++;
        else console.log(`[push] 응답 ${status}`);
      } catch (e) {
        console.log('[push] 발송 실패:', e.message);
      }
    }
    done.add(u);
  }
  if (expired.length) await db.prepare(`DELETE FROM subscriptions WHERE endpoint IN ${IN_JSON}`).bind(JSON.stringify(expired)).run();
  return { sent, done, skipped };
}

export async function sendToUser(env, userId, payload) {
  return (await sendMany(env, new Map([[userId, payload]]), { maxPush: 5 })).sent;
}

async function queuePending(env, rows, now) {
  await env.DB.prepare("INSERT INTO pending_alerts (user_id, payload, created_at) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ? FROM json_each(?)")
    .bind(now, JSON.stringify(rows.map(([u, p]) => [u, JSON.stringify(p)]))).run();
}

/** 가격 변동 → 알림. 같은 상품은 6시간에 한 번까지만 (목표가 도달은 항상) */
export async function notifyChanges(env, changes, now = Date.now(), { maxPush = 8 } = {}) {
  const db = env.DB;
  const drops = changes.filter((c) => c.prev !== null && c.price < c.prev);
  if (!drops.length) return { sent: 0, deferred: 0, queued: 0 };
  const byRef = new Map(drops.map((c) => [`${c.kind}:${c.ref}`, c]));
  const watches = [];
  for (const kind of ['product', 'keyword']) {
    const refs = drops.filter((c) => c.kind === kind).map((c) => c.ref);
    if (!refs.length) continue;
    const { results } = await db.prepare(`SELECT w.id, w.kind, w.ref, w.user_id, w.target_price, w.notify_drop, w.last_notified_at, u.night_ok
        FROM watches w JOIN users u ON u.id = w.user_id WHERE w.kind = '${kind}' AND w.ref IN ${IN_JSON}`).bind(JSON.stringify(refs)).all();
    watches.push(...results);
  }
  const nowList = new Map(); const later = []; const notified = [];
  for (const w of watches) {
    const ch = byRef.get(`${w.kind}:${w.ref}`);
    const hitTarget = Boolean(w.target_price && ch.price <= w.target_price && ch.prev > w.target_price);
    const cooled = !w.last_notified_at || now - w.last_notified_at > 6 * HOUR;
    if (!hitTarget && !(w.notify_drop && cooled)) continue;
    const payload = alertPayload(ch, w.id, hitTarget);
    notified.push(w.id);
    if (isNight(now) && !w.night_ok) later.push([w.user_id, payload]);
    else { if (!nowList.has(w.user_id)) nowList.set(w.user_id, []); nowList.get(w.user_id).push(payload); }
  }
  const nightCount = later.length;
  const perUser = new Map([...nowList].map(([u, list]) => [u, combine(list)]));
  const res = await sendMany(env, perUser, { maxPush });
  // 한도 때문에 못 보낸 것은 대기열로 → 다음 실행(5분 뒤)에 보낸다
  for (const u of res.skipped) for (const p of nowList.get(u)) later.push([u, p]);
  if (later.length) await queuePending(env, later, now);
  if (notified.length) await db.prepare(`UPDATE watches SET last_notified_at = ? WHERE id IN ${IN_JSON}`).bind(now, JSON.stringify(notified)).run();
  return { sent: res.sent, deferred: nightCount, queued: later.length - nightCount };
}

/** 대기열(밤사이 알림, 한도 초과분)을 보낸다 */
export async function flushPending(env, now = Date.now(), { maxPush = 8 } = {}) {
  if (isNight(now)) return 0;
  const db = env.DB;
  const { results } = await db.prepare('SELECT user_id, COUNT(*) AS n, MAX(id) AS last_id FROM pending_alerts GROUP BY user_id ORDER BY MIN(id) LIMIT 20').all();
  if (!results.length) return 0;
  const singles = results.filter((r) => r.n === 1).map((r) => r.last_id);
  const single = new Map();
  if (singles.length) {
    const { results: rows } = await db.prepare(`SELECT id, payload FROM pending_alerts WHERE id IN ${IN_JSON}`).bind(JSON.stringify(singles)).all();
    for (const r of rows) single.set(r.id, JSON.parse(r.payload));
  }
  const perUser = new Map(results.map((r) => [r.user_id, r.n === 1 && single.has(r.last_id)
    ? single.get(r.last_id)
    : { title: `🌙 가격 알림 ${r.n}건`, body: '가격이 내린 상품을 확인해 보세요.', url: '/#/', tag: 'digest' }]));
  const res = await sendMany(env, perUser, { maxPush });
  const done = results.filter((r) => res.done.has(r.user_id));
  if (done.length) {
    const maxId = Math.max(...done.map((r) => r.last_id));
    await db.prepare(`DELETE FROM pending_alerts WHERE id <= ? AND user_id IN ${IN_JSON}`).bind(maxId, JSON.stringify(done.map((r) => r.user_id))).run();
  }
  return res.sent;
}

export const FEEDS = [['goldbox', '오늘의 특가', 6 * HOUR], ...CATEGORIES.map(([id, label]) => [`best:${id}`, label, 12 * HOUR])];

export async function refreshFeed(env, api, key, { minRemaining = 1, now = Date.now() } = {}) {
  const items = key === 'goldbox' ? await api.goldbox({ minRemaining }) : await api.best(key.slice(5), { minRemaining });
  const write = env.DB.prepare('INSERT INTO feed_cache (key, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at')
    .bind(key, JSON.stringify(items), now);
  return { items, write };
}

async function refreshStaleFeed(env, api, now, minRemaining) {
  const { results } = await env.DB.prepare('SELECT key, fetched_at FROM feed_cache').all();
  const age = new Map(results.map((r) => [r.key, r.fetched_at]));
  for (const [key, , ttl] of FEEDS) {
    if (now - (age.get(key) || 0) < ttl) continue;
    const { items, write } = await refreshFeed(env, api, key, { minRemaining, now });
    return { key, changes: await applyResults(env, null, items, now, [write]) };
  }
  return null;
}

export async function runChecks(rawEnv, { now = Date.now(), api = makeApi(rawEnv), fresh = false } = {}) {
  const env = { ...rawEnv, DB: countingDb(rawEnv.DB) };
  const db = env.DB;
  const summary = { at: now, mode: null, checked: 0, calls: 0, changes: 0, sent: 0, deferred: 0, queued: 0, errors: 0, stopped: null, queries: 0 };
  if (await ensureSchema(db)) { summary.stopped = 'schema-created'; return summary; } // 막 만든 DB 에는 확인할 것이 없다
  summary.mode = await syncMode(env);
  const maxPush = intEnv(env, 'MAX_PUSH_PER_RUN', 8, 1, 45);
  summary.sent += await flushPending(env, now, { maxPush });
  const interval = intEnv(env, 'CHECK_INTERVAL_MIN', 60, 10, 24 * 60) * MIN;

  let allowance = 2; let minRemaining = 0;
  if (!api.mock) {
    const plan = budgetPlan(api.budget.limit);
    const st = await api.budget.state(now);
    allowance = Math.max(0, Math.min(plan.perRun, st.remaining - plan.reserve));
    minRemaining = plan.reserve + 1;
    if (st.pausedUntil > now) { allowance = 0; summary.stopped = 'paused'; }
  }
  if (fresh) api = withRunCache(api);

  const changes = [];
  if (allowance > 0) {
    const { results: due } = await db.prepare(DUE_SQL).bind(now, Math.max(allowance * 4, 8)).all();
    for (const target of due) {
      if (summary.calls >= allowance) break;
      if (db.used >= QUERY_STOP_TARGETS) { summary.stopped = 'query-budget'; break; }
      try {
        const r = await checkTarget(env, api, target, now, { interval, minRemaining, fresh });
        summary.checked++;
        if (r.called) summary.calls++;
        changes.push(...r.changes);
      } catch (e) {
        summary.errors++;
        if (e.budget) { summary.stopped = 'budget'; break; }
        summary.calls++;
        const table = target.kind === 'keyword' ? 'keywords' : 'products';
        await db.prepare(`UPDATE ${table} SET next_check_at = ? WHERE id = ?`).bind(now + 15 * MIN, target.ref).run();
        console.log('[check] 실패:', target.kind, target.ref, e.message);
      }
    }
    // 남는 호출이 있으면 특가/베스트 목록을 하나 갱신
    if (!summary.stopped && summary.calls < allowance && db.used < QUERY_STOP_FEED) {
      try {
        const r = await refreshStaleFeed(env, api, now, minRemaining);
        if (r) { summary.calls++; summary.feed = r.key; changes.push(...r.changes); }
      } catch (e) {
        if (!e.budget) console.log('[feed] 실패:', e.message);
      }
    }
  }

  summary.changes = changes.length;
  const n = await notifyChanges(env, changes, now, { maxPush });
  summary.sent += n.sent;
  summary.deferred = n.deferred;
  summary.queued = n.queued;

  // 한 시간에 한 번: 오래된 기록 정리, 추적 수 집계
  let last = null;
  try { last = JSON.parse((await getMeta(db, 'last_run')) || 'null'); } catch { /* 무시 */ }
  if (!last || !last.hourlyAt || now - last.hourlyAt >= HOUR) {
    await db.batch([
      db.prepare('DELETE FROM api_log WHERE t < ?').bind(now - 2 * 24 * HOUR),
      db.prepare('DELETE FROM search_cache WHERE fetched_at < ?').bind(now - 2 * 24 * HOUR),
      db.prepare('DELETE FROM limits WHERE reset_at < ?').bind(now),
      db.prepare('DELETE FROM pending_alerts WHERE created_at < ?').bind(now - 3 * 24 * HOUR),
    ]);
    const act = await db.prepare('SELECT (SELECT COUNT(*) FROM products WHERE watchers > 0) + (SELECT COUNT(*) FROM keywords WHERE watchers > 0) AS n').first();
    summary.active = act ? act.n : 0;
    summary.hourlyAt = now;
  } else {
    summary.active = last.active || 0;
    summary.hourlyAt = last.hourlyAt;
  }
  summary.queries = db.used + 1;
  await setMeta(db, 'last_run', JSON.stringify(summary));
  return summary;
}

/** 강제 확인 때도 같은 검색어는 한 번만 부르도록, 한 번의 실행 동안 결과를 기억한다 */
function withRunCache(api) {
  const seen = new Map();
  return new Proxy(api, {
    get(t, prop) {
      if (prop !== 'search') return Reflect.get(t, prop);
      return async (keyword, opts) => {
        const k = `${normalizeKeyword(keyword)}|${t.mock && opts && opts.hintProductId ? opts.hintProductId : ''}`;
        if (!seen.has(k)) seen.set(k, await t.search(keyword, opts));
        return seen.get(k);
      };
    },
  });
}
