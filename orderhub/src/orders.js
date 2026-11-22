'use strict';
// 주문 저장/병합 로직 (마켓 데이터 + 내 처리 상태)
const { nowIso, safeJson, str, won } = require('./util');
const { COURIERS, marketKey } = require('./couriers');

// 내 처리 상태
const STATUS = {
  NEW: '신규주문',
  PURCHASED: '발주완료',
  INVOICED: '송장입력',
  SHIPPED: '발송완료',
  DELIVERED: '배송완료',
  CANCELED: '취소',
  RETURNED: '반품',
};
const CLAIM = { CANCEL: '취소요청', RETURN: '반품요청', EXCHANGE: '교환요청' };
const OPEN_STATUSES = ['NEW', 'PURCHASED', 'INVOICED'];
const INACTIVE_ITEM = ['CANCELED', 'RETURNED', 'PENDING'];

// 상품들의 마켓 상태로 묶음(주문) 상태 판단
function derive(items) {
  const active = items.filter((i) => !INACTIVE_ITEM.includes(i.market_state));
  if (!active.length) {
    if (items.length && items.every((i) => i.market_state === 'PENDING')) return { market: 'PENDING', confirmed: false, claim: null };
    return { market: items.some((i) => i.market_state === 'RETURNED') ? 'RETURNED' : 'CANCELED', confirmed: false, claim: null };
  }
  let market = 'OPEN';
  if (active.every((i) => i.market_state === 'DELIVERED')) market = 'DELIVERED';
  else if (active.every((i) => i.market_state === 'SHIPPED' || i.market_state === 'DELIVERED')) market = 'SHIPPED';
  const confirmed = active.every((i) => i.market_state !== 'NEW');
  const claim = ['CANCEL', 'RETURN', 'EXCHANGE'].find((c) => active.some((i) => i.claim === c)) || null;
  return { market, confirmed, claim };
}

function nextStatus(local, d) {
  if (d.market === 'CANCELED' || d.market === 'RETURNED') return d.market;
  if (d.market === 'DELIVERED') return 'DELIVERED';
  if (d.market === 'SHIPPED') return local === 'DELIVERED' ? 'DELIVERED' : 'SHIPPED';
  if (d.market === 'PENDING') return local;
  // 아직 발송 전(OPEN)
  if (local === 'CANCELED' || local === 'RETURNED') return 'NEW'; // 취소 철회 등
  return local;
}

function marketSummary(items) {
  const labels = [...new Set(items.map((i) => i.market_status).filter(Boolean))];
  return labels.join(', ');
}

function findCourierByMarketCode(market, code, name) {
  if (code) {
    const c = COURIERS.find((x) => x[marketKey(market)] === String(code));
    if (c) return c.key;
    return `CUSTOM:${code}`;
  }
  if (name) {
    const n = name.replace(/\s/g, '');
    const c = COURIERS.find((x) => x.name.replace(/\s/g, '') === n || n.includes(x.name.replace(/\s/g, '').replace('택배', '')));
    if (c) return c.key;
  }
  return null;
}

function rowItem(i) {
  return { ...i, extra: safeJson(i.extra, {}) };
}

class OrderStore {
  constructor(db) {
    this.db = db;
  }

  itemsOf(orderId) {
    return this.db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', orderId).map(rowItem);
  }

  get(orderId) {
    const o = this.db.get(
      'SELECT o.*, s.type AS store_type, s.name AS store_name FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = ?',
      orderId
    );
    if (!o) return null;
    o.items = this.itemsOf(o.id);
    return o;
  }

  // 미처리 주문 (목록에서 사라졌는지 확인용)
  openGroups(storeId) {
    const rows = this.db.all(
      `SELECT o.group_key, GROUP_CONCAT(i.item_key, '|') AS keys FROM orders o JOIN order_items i ON i.order_id = o.id
       WHERE o.store_id = ? AND o.status IN ('NEW','PURCHASED','INVOICED') AND i.market_state IN ('NEW','CONFIRMED')
       GROUP BY o.id`,
      storeId
    );
    return rows.map((r) => ({ group_key: r.group_key, item_keys: (r.keys || '').split('|') }));
  }

  upsertItem(orderId, storeId, it, ts) {
    const existing = this.db.get('SELECT id, order_id FROM order_items WHERE store_id = ? AND item_key = ?', storeId, it.itemKey);
    if (it.partial) {
      // 일부 정보만 있는 데이터(취소 목록 등)는 상태만 갱신
      if (existing) {
        this.db.run(
          'UPDATE order_items SET market_state = COALESCE(?, market_state), market_status = ?, claim = ?, updated_at = ? WHERE id = ?',
          it.marketState || null,
          str(it.marketStatus),
          it.claim || null,
          ts,
          existing.id
        );
      }
      return null;
    }
    const values = [
      str(it.orderNo),
      str(it.productName),
      str(it.optionName),
      it.quantity ?? null,
      it.unitPrice ?? null,
      it.amount ?? null,
      str(it.productCode),
      str(it.productId),
      it.marketState || 'NEW',
      str(it.marketStatus),
      it.claim || null,
      JSON.stringify(it.extra || {}),
      JSON.stringify(it.raw ?? null),
      ts,
    ];
    if (existing) {
      this.db.run(
        `UPDATE order_items SET order_id = ?, order_no = ?, product_name = ?, option_name = ?, quantity = ?, unit_price = ?, amount = ?,
         product_code = ?, product_id = ?, market_state = ?, market_status = ?, claim = ?, extra = ?, raw = ?, updated_at = ? WHERE id = ?`,
        orderId,
        ...values,
        existing.id
      );
      return existing.order_id !== orderId ? existing.order_id : null; // 다른 묶음에서 옮겨온 경우 이전 묶음 id
    }
    this.db.run(
      `INSERT INTO order_items(order_id, store_id, item_key, order_no, product_name, option_name, quantity, unit_price, amount,
       product_code, product_id, market_state, market_status, claim, extra, raw, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId,
      storeId,
      it.itemKey,
      ...values
    );
    return null;
  }

  // 마켓에서 받은 묶음 1개를 저장. 변경 내용을 반환.
  applyGroup(store, group) {
    let g = group;
    const ts = nowIso();
    const db = this.db;
    if (!g.items?.length) return null;
    let existing = db.get('SELECT * FROM orders WHERE store_id = ? AND group_key = ?', store.id, g.groupKey);
    if (g.partial) {
      // 일부 정보만 있는 데이터는 이미 저장된 주문에만 반영
      if (!existing) {
        const it = db.get('SELECT order_id FROM order_items WHERE store_id = ? AND item_key = ?', store.id, g.items[0].itemKey);
        if (!it) return null;
        existing = db.get('SELECT * FROM orders WHERE id = ?', it.order_id);
      }
      if (!existing) return null;
      g = { groupKey: existing.group_key, partial: true, items: g.items.map((i) => ({ ...i, partial: true })) };
    }
    if (!existing && g.items.every((i) => i.marketState === 'PENDING')) return null; // 미입금 주문은 입금 후 수집

    return db.tx(() => {
      let orderId;
      if (!existing) {
        const r = db.run(
          `INSERT INTO orders(store_id, group_key, order_no, status, created_at, updated_at) VALUES(?, ?, ?, 'NEW', ?, ?)`,
          store.id,
          g.groupKey,
          str(g.orderNo),
          ts,
          ts
        );
        orderId = Number(r.lastInsertRowid);
      } else {
        orderId = existing.id;
      }
      const movedFrom = new Set();
      for (const it of g.items) {
        const prev = this.upsertItem(orderId, store.id, it, ts);
        if (prev) movedFrom.add(prev);
      }
      for (const oldId of movedFrom) {
        const left = db.get('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', oldId).n;
        if (!left) db.run('DELETE FROM orders WHERE id = ?', oldId);
      }

      const items = this.itemsOf(orderId);
      const d = derive(items);
      const prevStatus = existing ? existing.status : null;
      let status;
      if (!existing) {
        status = d.market === 'OPEN' || d.market === 'PENDING' ? 'NEW' : nextStatus('NEW', d);
      } else {
        status = nextStatus(existing.status, d);
      }
      const total = items.filter((i) => !INACTIVE_ITEM.includes(i.market_state)).reduce((a, i) => a + (i.amount || 0), 0);

      // 배송지 변경 감지 (발송 전 주문만)
      let addressChanged = existing ? existing.address_changed : 0;
      const addrNow = [g.receiverName, g.zipcode, g.address1, g.address2].map(str).join('|');
      if (existing && !g.partial && OPEN_STATUSES.includes(existing.status) && str(g.address1)) {
        const addrPrev = [existing.receiver_name, existing.zipcode, existing.address1, existing.address2].map(str).join('|');
        if (addrPrev.replace(/\|/g, '') && addrPrev !== addrNow) addressChanged = 1;
      }

      // 마켓에 이미 송장이 있으면(셀러센터에서 직접 처리 등) 가져오기
      let courierKey = existing?.courier_key || null;
      let trackingNo = existing?.tracking_no || null;
      if (!trackingNo && g.marketTrackingNo && (status === 'SHIPPED' || status === 'DELIVERED')) {
        trackingNo = g.marketTrackingNo;
        courierKey = findCourierByMarketCode(store.type, g.marketCourierCode, g.marketCourierName);
      }

      const keep = (v, old) => (str(v) ? str(v) : old ?? null);
      db.run(
        `UPDATE orders SET order_no = ?, status = ?, market_confirmed = ?, claim = ?, market_status = ?, ordered_at = ?, paid_at = ?, ship_due = ?,
         orderer_name = ?, orderer_phone = ?, receiver_name = ?, receiver_phone = ?, receiver_phone2 = ?, zipcode = ?, address1 = ?, address2 = ?,
         delivery_memo = ?, customs_code = ?, total_amount = ?, shipping_fee = ?, courier_key = ?, tracking_no = ?, address_changed = ?,
         dispatched_at = COALESCE(dispatched_at, ?), updated_at = ? WHERE id = ?`,
        keep(g.orderNo, existing?.order_no),
        status,
        d.confirmed ? 1 : 0,
        status === 'CANCELED' || status === 'RETURNED' ? null : d.claim,
        marketSummary(items),
        g.orderedAt || existing?.ordered_at || null,
        g.paidAt || existing?.paid_at || null,
        g.shipDue || existing?.ship_due || null,
        keep(g.ordererName, existing?.orderer_name),
        keep(g.ordererPhone, existing?.orderer_phone),
        keep(g.receiverName, existing?.receiver_name),
        keep(g.receiverPhone, existing?.receiver_phone),
        keep(g.receiverPhone2, existing?.receiver_phone2),
        keep(g.zipcode, existing?.zipcode),
        keep(g.address1, existing?.address1),
        keep(g.address2, existing?.address2),
        keep(g.deliveryMemo, existing?.delivery_memo),
        keep(g.customsCode, existing?.customs_code),
        total,
        g.partial ? existing?.shipping_fee ?? 0 : g.shippingFee ?? existing?.shipping_fee ?? 0,
        courierKey,
        trackingNo,
        addressChanged,
        status === 'SHIPPED' && !existing?.dispatched_at && (prevStatus === null || OPEN_STATUSES.includes(prevStatus)) ? ts : null,
        ts,
        orderId
      );

      const change = {
        orderId,
        isNew: !existing,
        prevStatus,
        status,
        prevClaim: existing?.claim || null,
        claim: status === 'CANCELED' || status === 'RETURNED' ? null : d.claim,
        addressChangedNow: !!(existing && addressChanged && !existing.address_changed),
      };

      // 이력 기록
      if (!existing) {
        db.addEvent({ orderId, storeId: store.id, type: 'status', message: `주문 수집 (${STATUS[status] || status})` });
      } else {
        if (prevStatus !== status) {
          db.addEvent({ orderId, storeId: store.id, type: 'status', message: `상태 변경: ${STATUS[prevStatus] || prevStatus} → ${STATUS[status] || status} (마켓 반영)` });
        }
        if (change.claim && change.claim !== change.prevClaim) {
          db.addEvent({ orderId, storeId: store.id, level: 'warn', type: 'claim', message: `${CLAIM[change.claim]} 접수` });
        }
        if (!change.claim && change.prevClaim && status !== 'CANCELED' && status !== 'RETURNED') {
          db.addEvent({ orderId, storeId: store.id, type: 'claim', message: `${CLAIM[change.prevClaim]} 철회/종료` });
        }
        if (change.addressChangedNow) {
          db.addEvent({ orderId, storeId: store.id, level: 'warn', type: 'address', message: `배송지 변경: ${addrNow.replace(/\|/g, ' ')}` });
        }
      }
      return change;
    });
  }

  // 목록 조회
  list({ tab = 'new', storeId, q, from, to, page = 1, limit = 50 } = {}) {
    const where = [];
    const params = [];
    const tabs = {
      new: "o.status = 'NEW'",
      purchased: "o.status IN ('PURCHASED','INVOICED')",
      shipped: "o.status = 'SHIPPED'",
      delivered: "o.status = 'DELIVERED'",
      claim: "(o.status IN ('CANCELED','RETURNED') OR o.claim IS NOT NULL)",
      all: '1=1',
    };
    where.push(tabs[tab] || tabs.all);
    if (storeId) {
      where.push('o.store_id = ?');
      params.push(Number(storeId));
    }
    if (from) {
      where.push('COALESCE(o.paid_at, o.created_at) >= ?');
      params.push(from);
    }
    if (to) {
      where.push('COALESCE(o.paid_at, o.created_at) <= ?');
      params.push(to);
    }
    if (q && String(q).trim()) {
      const like = `%${String(q).trim()}%`;
      const digits = String(q).replace(/\D/g, '');
      where.push(`(o.order_no LIKE ? OR o.group_key LIKE ? OR o.receiver_name LIKE ? OR o.orderer_name LIKE ? OR o.tracking_no LIKE ?
        OR o.supplier LIKE ? OR o.supplier_order_no LIKE ? OR o.memo LIKE ?
        ${digits.length >= 4 ? "OR REPLACE(o.receiver_phone, '-', '') LIKE ? OR REPLACE(o.orderer_phone, '-', '') LIKE ?" : ''}
        OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND (i.product_name LIKE ? OR i.option_name LIKE ? OR i.item_key LIKE ? OR i.order_no LIKE ?)))`);
      params.push(like, like, like, like, like, like, like, like);
      if (digits.length >= 4) params.push(`%${digits}%`, `%${digits}%`);
      params.push(like, like, like, like);
    }
    const whereSql = where.join(' AND ');
    const total = this.db.get(`SELECT COUNT(*) AS n FROM orders o WHERE ${whereSql}`, ...params).n;
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
    // 신규/발주완료 탭은 오래된 주문부터(처리 순서), 나머지는 최신순
    const order = tab === 'new' || tab === 'purchased' ? 'ASC' : 'DESC';
    const rows = this.db.all(
      `SELECT o.*, s.type AS store_type, s.name AS store_name FROM orders o JOIN stores s ON s.id = o.store_id
       WHERE ${whereSql} ORDER BY COALESCE(o.paid_at, o.created_at) ${order}, o.id ${order} LIMIT ? OFFSET ?`,
      ...params,
      lim,
      off
    );
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const items = this.db.all(
        `SELECT id, order_id, item_key, order_no, product_name, option_name, quantity, unit_price, amount, product_code, market_state, market_status, claim
         FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
        ...ids
      );
      const byOrder = new Map(ids.map((id) => [id, []]));
      for (const it of items) byOrder.get(it.order_id)?.push(it);
      for (const r of rows) r.items = byOrder.get(r.id) || [];
    }
    return { total, page: Number(page) || 1, limit: lim, orders: rows };
  }

  counts(storeId) {
    const p = storeId ? [Number(storeId)] : [];
    const w = storeId ? 'WHERE store_id = ?' : '';
    const r = this.db.get(
      `SELECT
        SUM(status = 'NEW') AS new,
        SUM(status IN ('PURCHASED','INVOICED')) AS purchased,
        SUM(status = 'SHIPPED') AS shipped,
        SUM(status = 'DELIVERED') AS delivered,
        SUM(status IN ('CANCELED','RETURNED') OR claim IS NOT NULL) AS claim,
        SUM(claim IS NOT NULL AND status NOT IN ('CANCELED','RETURNED')) AS claimOpen,
        COUNT(*) AS all_
       FROM orders ${w}`,
      ...p
    );
    return {
      new: r.new || 0,
      purchased: r.purchased || 0,
      shipped: r.shipped || 0,
      delivered: r.delivered || 0,
      claim: r.claim || 0,
      claimOpen: r.claimOpen || 0,
      all: r.all_ || 0,
    };
  }

  // 알림 문구용 요약
  describe(order) {
    const items = order.items || this.itemsOf(order.id);
    const first = items[0];
    const name = first ? `${first.product_name}${first.option_name ? ` (${first.option_name})` : ''} ×${first.quantity}` : '';
    const more = items.length > 1 ? ` 외 ${items.length - 1}건` : '';
    return `${order.receiver_name || order.orderer_name || ''} · ${name}${more}${order.total_amount ? ` · ${won(order.total_amount)}` : ''}`;
  }
}

module.exports = { OrderStore, derive, nextStatus, STATUS, CLAIM, OPEN_STATUSES };
