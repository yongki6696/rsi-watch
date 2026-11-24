'use strict';
// 고객 문의 / 상품 문의 저장
const { nowIso, safeJson, str } = require('./util');

const KIND = { customer: '고객문의', product: '상품문의' };

class InquiryStore {
  constructor(db) {
    this.db = db;
  }

  // q: { key, kind, category, title, content, productName, productId, orderNo, writer, askedAt, answered, answer, extra }
  apply(store, q) {
    if (!q?.key) return null;
    const ts = nowIso();
    // 상품명 없이 상품번호만 오는 마켓(롯데ON·G마켓·옥션 등): 받은 주문의 상품명으로, 없으면 번호로 표시
    if (!str(q.productName) && str(q.productId)) {
      const row = this.db.get(
        "SELECT product_name FROM order_items WHERE store_id = ? AND product_id = ? AND COALESCE(product_name, '') != '' ORDER BY id DESC LIMIT 1",
        store.id,
        str(q.productId)
      );
      q = { ...q, productName: row?.product_name || `상품번호 ${str(q.productId)}` };
    }
    const existing = this.db.get('SELECT id, answered FROM inquiries WHERE store_id = ? AND inquiry_key = ?', store.id, String(q.key));
    if (existing) {
      this.db.run(
        `UPDATE inquiries SET category = ?, title = ?, content = ?, product_name = ?, order_no = ?, writer = ?, asked_at = COALESCE(?, asked_at),
         answered = CASE WHEN answered = 1 THEN 1 ELSE ? END, answer = COALESCE(?, answer),
         answered_at = CASE WHEN ? = 1 AND answered = 0 THEN ? ELSE answered_at END, extra = ?, updated_at = ? WHERE id = ?`,
        str(q.category),
        str(q.title),
        str(q.content),
        str(q.productName),
        str(q.orderNo),
        str(q.writer),
        q.askedAt || null,
        q.answered ? 1 : 0,
        q.answer ? str(q.answer) : null,
        q.answered ? 1 : 0,
        ts,
        JSON.stringify(q.extra || {}),
        ts,
        existing.id
      );
      return { id: existing.id, isNew: false };
    }
    const r = this.db.run(
      `INSERT INTO inquiries(store_id, inquiry_key, kind, category, title, content, product_name, order_no, writer, asked_at, answered, answer, extra, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      store.id,
      String(q.key),
      q.kind || 'customer',
      str(q.category),
      str(q.title),
      str(q.content),
      str(q.productName),
      str(q.orderNo),
      str(q.writer),
      q.askedAt || null,
      q.answered ? 1 : 0,
      q.answer ? str(q.answer) : null,
      JSON.stringify(q.extra || {}),
      ts,
      ts
    );
    return { id: Number(r.lastInsertRowid), isNew: true };
  }

  get(id) {
    const q = this.db.get(
      'SELECT q.*, s.type AS store_type, s.name AS store_name FROM inquiries q JOIN stores s ON s.id = q.store_id WHERE q.id = ?',
      Number(id)
    );
    if (q) q.extra = safeJson(q.extra, {});
    return q;
  }

  list({ filter = 'open', storeId, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (filter === 'open') where.push('q.answered = 0');
    if (storeId) {
      where.push('q.store_id = ?');
      params.push(Number(storeId));
    }
    const rows = this.db.all(
      `SELECT q.*, s.type AS store_type, s.name AS store_name,
        (SELECT o.id FROM orders o WHERE o.store_id = q.store_id AND q.order_no != '' AND o.order_no = q.order_no LIMIT 1) AS order_id
       FROM inquiries q JOIN stores s ON s.id = q.store_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY COALESCE(q.asked_at, q.created_at) DESC LIMIT ?`,
      ...params,
      Math.min(Number(limit) || 100, 500)
    );
    return rows.map((r) => ({ ...r, extra: safeJson(r.extra, {}) }));
  }

  counts(storeId) {
    const r = storeId
      ? this.db.get('SELECT SUM(answered = 0) AS open, COUNT(*) AS all_ FROM inquiries WHERE store_id = ?', Number(storeId))
      : this.db.get('SELECT SUM(answered = 0) AS open, COUNT(*) AS all_ FROM inquiries');
    return { open: r.open || 0, all: r.all_ || 0 };
  }

  // 스토어별 미답변 수 (문의 화면의 스토어 선택용)
  storeCounts() {
    return this.db.all('SELECT store_id AS storeId, SUM(answered = 0) AS open, COUNT(*) AS n FROM inquiries GROUP BY store_id');
  }

  // 셀러센터에서 답변한 문의를 직접 '답변 완료'로 표시 (다음 확인 때 마켓 답변 내용이 들어오면 함께 표시)
  markHandled(id) {
    const ts = nowIso();
    this.db.run('UPDATE inquiries SET answered = 1, answered_at = COALESCE(answered_at, ?), updated_at = ? WHERE id = ?', ts, ts, Number(id));
  }

  markAnswered(id, text) {
    const ts = nowIso();
    this.db.run('UPDATE inquiries SET answered = 1, answer = ?, answered_at = ?, updated_at = ? WHERE id = ?', str(text), ts, ts, Number(id));
  }

  describe(q) {
    const head = q.category ? `[${q.category}] ` : '';
    const body = str(q.title) || str(q.content);
    return `${head}${body.slice(0, 80)}${q.writer ? ` — ${q.writer}` : ''}`;
  }
}

module.exports = { InquiryStore, KIND };
