'use strict';
// SQLite 저장소 (Node 22 내장 node:sqlite 사용 - 별도 설치 불필요)
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { nowIso, safeJson } = require('./util');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  credentials TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  order_no TEXT,
  status TEXT NOT NULL,
  market_confirmed INTEGER NOT NULL DEFAULT 0,
  claim TEXT,
  market_status TEXT,
  ordered_at TEXT,
  paid_at TEXT,
  ship_due TEXT,
  orderer_name TEXT,
  orderer_phone TEXT,
  receiver_name TEXT,
  receiver_phone TEXT,
  receiver_phone2 TEXT,
  zipcode TEXT,
  address1 TEXT,
  address2 TEXT,
  delivery_memo TEXT,
  customs_code TEXT,
  total_amount INTEGER,
  shipping_fee INTEGER,
  courier_key TEXT,
  courier_code TEXT,
  tracking_no TEXT,
  dispatched_at TEXT,
  dispatch_error TEXT,
  supplier TEXT,
  supplier_order_no TEXT,
  cost INTEGER,
  memo TEXT,
  purchased_at TEXT,
  confirmed_at TEXT,
  address_changed INTEGER NOT NULL DEFAULT 0,
  seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(store_id, group_key)
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_paid ON orders(paid_at);
CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  order_no TEXT,
  product_name TEXT,
  option_name TEXT,
  quantity INTEGER,
  unit_price INTEGER,
  amount INTEGER,
  product_code TEXT,
  product_id TEXT,
  market_state TEXT,
  market_status TEXT,
  claim TEXT,
  extra TEXT,
  raw TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(store_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_orderno ON order_items(order_no);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  order_id INTEGER,
  store_id INTEGER,
  level TEXT NOT NULL DEFAULT 'info',
  type TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  inquiry_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  category TEXT,
  title TEXT,
  content TEXT,
  product_name TEXT,
  order_no TEXT,
  writer TEXT,
  asked_at TEXT,
  answered INTEGER NOT NULL DEFAULT 0,
  answer TEXT,
  answered_at TEXT,
  extra TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(store_id, inquiry_key)
);
CREATE INDEX IF NOT EXISTS idx_inquiries_open ON inquiries(answered, asked_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0
);
`;

class Db {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // 예전 버전 DB에 새 칸 추가
  migrate() {
    const cols = this.all('PRAGMA table_info(orders)').map((c) => c.name);
    if (!cols.includes('seen_at')) {
      // 신규주문을 확인한 시각 (아직 안 본 신규주문만 메뉴 숫자로 표시). 업데이트 전 주문은 모두 확인한 것으로 처리
      this.db.exec('ALTER TABLE orders ADD COLUMN seen_at TEXT');
      this.run('UPDATE orders SET seen_at = ?', nowIso());
    }
  }

  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  // 동기 트랜잭션. fn 안에서 예외가 나면 롤백.
  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw e;
    }
  }

  // ---- settings (JSON 값) ----
  getSetting(key, fallback = null) {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    if (!row) return fallback;
    const v = safeJson(row.value, undefined);
    return v === undefined ? fallback : v;
  }

  setSetting(key, value) {
    this.run(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value)
    );
  }

  // ---- events (주문 이력 + 시스템 로그) ----
  addEvent({ orderId = null, storeId = null, level = 'info', type, message }) {
    this.run(
      'INSERT INTO events(ts, order_id, store_id, level, type, message) VALUES(?, ?, ?, ?, ?, ?)',
      nowIso(),
      orderId,
      storeId,
      level,
      type,
      message
    );
  }

  pruneEvents(keepDays = 90) {
    const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
    this.run('DELETE FROM events WHERE ts < ? AND order_id IS NULL', cutoff);
  }

  close() {
    this.db.close();
  }
}

module.exports = { Db };
