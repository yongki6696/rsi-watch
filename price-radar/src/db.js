// D1(SQLite) 스키마. 배포 후 첫 요청 때 스스로 테이블을 만든다 (따로 명령어를 칠 필요 없음).

const SCHEMA_VERSION = '1';

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    night_ok INTEGER NOT NULL DEFAULT 0
  )`,
  // 추적하는 상품 (여러 사용자가 같은 상품을 등록해도 한 줄)
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT,
    image TEXT,
    partner_url TEXT,
    source_url TEXT,
    search_keyword TEXT,
    price INTEGER,
    prev_price INTEGER,
    min_price INTEGER,
    max_price INTEGER,
    is_rocket INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    miss_count INTEGER NOT NULL DEFAULT 0,
    watchers INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    last_found_at INTEGER,
    changed_at INTEGER,
    next_check_at INTEGER NOT NULL DEFAULT 0,
    mock INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS products_due ON products (next_check_at)',
  'CREATE INDEX IF NOT EXISTS products_watchers ON products (watchers)',
  // 키워드 최저가 알림 (id = 정규화한 검색어)
  `CREATE TABLE IF NOT EXISTS keywords (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    price INTEGER,
    prev_price INTEGER,
    min_price INTEGER,
    max_price INTEGER,
    best_product_id TEXT,
    results TEXT,
    watchers INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    changed_at INTEGER,
    next_check_at INTEGER NOT NULL DEFAULT 0,
    mock INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS keywords_due ON keywords (next_check_at)',
  'CREATE INDEX IF NOT EXISTS keywords_watchers ON keywords (watchers)',
  // 가격이 바뀐 순간만 기록
  `CREATE TABLE IF NOT EXISTS prices (
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    t INTEGER NOT NULL,
    price INTEGER NOT NULL,
    PRIMARY KEY (kind, ref, t)
  )`,
  `CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    target_price INTEGER,
    notify_drop INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_notified_at INTEGER,
    UNIQUE (user_id, kind, ref)
  )`,
  'CREATE INDEX IF NOT EXISTS watches_ref ON watches (kind, ref)',
  `CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS subs_user ON subscriptions (user_id)',
  `CREATE TABLE IF NOT EXISTS pending_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS search_cache (
    keyword TEXT PRIMARY KEY,
    results TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS feed_cache (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_log (
    t INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 1
  )`,
  'CREATE INDEX IF NOT EXISTS api_log_t ON api_log (t)',
  `CREATE TABLE IF NOT EXISTS limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`,
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)',
];

const ready = new WeakMap();

/** @returns {Promise<boolean>} 이번에 테이블을 새로 만들었으면 true */
export async function ensureSchema(db) {
  const key = db._raw || db;
  if (ready.get(key)) return false;
  try {
    const row = await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first();
    if (row && row.value === SCHEMA_VERSION) { ready.set(key, true); return false; }
  } catch { /* 테이블이 아직 없음 */ }
  await db.batch([
    ...DDL.map((sql) => db.prepare(sql)),
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(SCHEMA_VERSION),
  ]);
  ready.set(key, true);
  return true;
}

/**
 * Cloudflare 무료 플랜은 요청 한 번에 D1 쿼리를 50개까지만 허용한다.
 * 실행한 쿼리 수를 세어, 한도에 가까워지면 할 일을 다음 실행으로 미룬다.
 */
export function countingDb(db) {
  if (db._raw) return db;
  const state = { used: 0 };
  const wrap = (stmt) => ({
    bind: (...a) => wrap(stmt.bind(...a)),
    first: (...a) => { state.used++; return stmt.first(...a); },
    all: (...a) => { state.used++; return stmt.all(...a); },
    run: (...a) => { state.used++; return stmt.run(...a); },
    raw: (...a) => { state.used++; return stmt.raw(...a); },
    _inner: stmt,
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    batch: (stmts) => { state.used += stmts.length; return db.batch(stmts.map((x) => x._inner || x)); },
    get used() { return state.used; },
    _raw: db,
  };
}

export const NEVER = 9000000000000000; // 아무도 안 보는 항목은 확인 일정에서 뺀다

export function chunks(list, size = 90) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** 가격이 바뀌었을 때 실행할 문장들 (기록 추가 + 직전/최저/최고가 갱신) */
export function priceChange(db, kind, ref, row, price, now) {
  const table = kind === 'keyword' ? 'keywords' : 'products';
  const min = row.min_price === null || row.min_price === undefined ? price : Math.min(row.min_price, price);
  const max = row.max_price === null || row.max_price === undefined ? price : Math.max(row.max_price, price);
  return [
    db.prepare('INSERT OR REPLACE INTO prices (kind, ref, t, price) VALUES (?, ?, ?, ?)').bind(kind, ref, now, price),
    db.prepare(`UPDATE ${table} SET prev_price = price, price = ?, min_price = ?, max_price = ?, changed_at = ? WHERE id = ?`).bind(price, min, max, now, ref),
  ];
}

export async function getMeta(db, key) {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setMeta(db, key, value) {
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value === null || value === undefined ? null : String(value)).run();
}

/** 고정 창 방식의 간단한 횟수 제한. 허용되면 true. */
export async function hitLimit(db, key, max, windowMs, now = Date.now()) {
  const row = await db.prepare('SELECT count, reset_at FROM limits WHERE key = ?').bind(key).first();
  if (!row || row.reset_at <= now) {
    await db.prepare('INSERT INTO limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at')
      .bind(key, now + windowMs).run();
    return true;
  }
  if (row.count >= max) return false;
  await db.prepare('UPDATE limits SET count = count + 1 WHERE key = ?').bind(key).run();
  return true;
}

/** 알림 수를 다시 세고, 아무도 안 보면 확인 일정에서 빼고, 다시 보면 바로 확인 대상으로 */
export async function refreshWatchers(db, refs) {
  const stmts = [];
  for (const kind of ['product', 'keyword']) {
    const table = kind === 'keyword' ? 'keywords' : 'products';
    const ids = [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.ref))];
    if (!ids.length) continue;
    const cnt = `(SELECT COUNT(*) FROM watches w WHERE w.kind = '${kind}' AND w.ref = ${table}.id)`;
    stmts.push(db.prepare(`UPDATE ${table} SET watchers = ${cnt},
        next_check_at = CASE WHEN ${cnt} = 0 THEN ${NEVER} WHEN next_check_at >= ${NEVER} THEN 0 ELSE next_check_at END
        WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)));
  }
  if (stmts.length) await db.batch(stmts);
}

export async function history(db, kind, ref, limit = 400) {
  const { results } = await db.prepare('SELECT t, price AS p FROM prices WHERE kind = ? AND ref = ? ORDER BY t DESC LIMIT ?')
    .bind(kind, ref, limit).all();
  return results.reverse();
}

/** 데모 데이터에서 실제 모드로 바뀌면 데모로 만든 것들을 지운다 */
export async function purgeMock(db) {
  await db.batch([
    db.prepare("DELETE FROM prices WHERE (kind = 'product' AND ref IN (SELECT id FROM products WHERE mock = 1)) OR (kind = 'keyword' AND ref IN (SELECT id FROM keywords WHERE mock = 1))"),
    db.prepare("DELETE FROM watches WHERE (kind = 'product' AND ref IN (SELECT id FROM products WHERE mock = 1)) OR (kind = 'keyword' AND ref IN (SELECT id FROM keywords WHERE mock = 1))"),
    db.prepare('DELETE FROM products WHERE mock = 1'),
    db.prepare('DELETE FROM keywords WHERE mock = 1'),
    db.prepare('DELETE FROM search_cache'),
    db.prepare('DELETE FROM feed_cache'),
  ]);
}
