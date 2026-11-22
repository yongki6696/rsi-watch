'use strict';
// 매출 집계: 마켓(스토어)별 / 일자별
// 매출 = 취소·반품을 뺀 상품 결제금액 합계 (배송비는 따로), 날짜 = 결제일(KST) 기준
const { safeJson, kstDate, HttpError } = require('./util');
const { getAppSettings } = require('./settings');
const { cell, marketLabel } = require('./csv');

const DAY_EXPR = "date(COALESCE(o.paid_at, o.ordered_at, o.created_at), '+9 hours')";
const VALID_ORDER = "o.status NOT IN ('CANCELED','RETURNED')";
const VALID_ITEM = "i.market_state NOT IN ('CANCELED','RETURNED','PENDING')";
const MAX_DAYS = 366;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const ZERO = () => ({ orders: 0, amount: 0, shipping: 0, qty: 0 });

function parseDay(value, label) {
  const v = String(value || '').trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== v) throw new HttpError(400, `${label} 날짜가 올바르지 않습니다 (예: 2026-11-01)`);
  return v;
}

// to → from 순서(최신 날짜 먼저)
function dayList(from, to) {
  const out = [];
  const end = Date.parse(`${from}T00:00:00Z`);
  for (let t = Date.parse(`${to}T00:00:00Z`); t >= end; t -= 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function weekday(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function add(target, src) {
  target.orders += src.orders || 0;
  target.amount += src.amount || 0;
  target.shipping += src.shipping || 0;
  target.qty += src.qty || 0;
}

class SalesReport {
  constructor(db) {
    this.db = db;
  }

  // 이 날짜부터의 주문은 오더허브에 모두 있음 (첫 연결 때 불러온 기간 또는 지난 주문 불러오기)
  coverageFrom(store) {
    const state = safeJson(store.state, {});
    if (state.coverageFrom) return state.coverageFrom;
    const days = getAppSettings(this.db).initialDays || 7;
    return kstDate(new Date(Date.parse(store.created_at) - days * 86400000));
  }

  report({ from, to }) {
    from = parseDay(from, '시작');
    to = parseDay(to, '종료');
    if (from > to) [from, to] = [to, from];
    const span = dayList(from, to).length;
    if (span > MAX_DAYS) throw new HttpError(400, `한 번에 최대 ${MAX_DAYS}일까지 조회할 수 있습니다`);

    const itemRows = this.db.all(
      `SELECT o.store_id AS storeId, ${DAY_EXPR} AS day,
         COUNT(DISTINCT COALESCE(NULLIF(o.order_no, ''), o.group_key)) AS orders,
         SUM(COALESCE(i.amount, i.unit_price * COALESCE(i.quantity, 1), 0)) AS amount,
         SUM(COALESCE(i.quantity, 1)) AS qty
       FROM orders o JOIN order_items i ON i.order_id = o.id
       WHERE ${VALID_ORDER} AND ${VALID_ITEM} AND ${DAY_EXPR} BETWEEN ? AND ?
       GROUP BY o.store_id, day`,
      from,
      to
    );
    // 배송비는 주문(배송 묶음)당 1번 - 살아있는 상품이 하나라도 있는 주문만
    const shipRows = this.db.all(
      `SELECT o.store_id AS storeId, ${DAY_EXPR} AS day, SUM(COALESCE(o.shipping_fee, 0)) AS shipping
       FROM orders o
       WHERE ${VALID_ORDER} AND ${DAY_EXPR} BETWEEN ? AND ?
         AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND ${VALID_ITEM})
       GROUP BY o.store_id, day`,
      from,
      to
    );

    const stores = this.db.all('SELECT id, type, name, enabled, state, created_at FROM stores ORDER BY id');
    const storeMap = new Map(stores.map((s) => [s.id, { id: s.id, type: s.type, name: s.name, enabled: !!s.enabled, coverageFrom: this.coverageFrom(s), ...ZERO() }]));
    const days = new Map(dayList(from, to).map((d) => [d, { date: d, weekday: weekday(d), ...ZERO(), stores: {} }]));
    const cellOf = (storeId, day) => {
      const d = days.get(day);
      if (!d || !storeMap.has(storeId)) return null;
      return (d.stores[storeId] ||= ZERO());
    };
    for (const r of itemRows) {
      const c = cellOf(r.storeId, r.day);
      if (c) add(c, { orders: r.orders, amount: r.amount, qty: r.qty });
    }
    for (const r of shipRows) {
      const c = cellOf(r.storeId, r.day);
      if (c) c.shipping += r.shipping || 0;
    }
    const total = ZERO();
    for (const d of days.values()) {
      for (const [id, c] of Object.entries(d.stores)) {
        add(d, c);
        add(storeMap.get(Number(id)), c);
      }
      add(total, d);
    }
    return { from, to, days: span, stores: [...storeMap.values()], daily: [...days.values()], total };
  }

  // 엑셀(CSV): 마켓별 또는 일자별(선택한 스토어별 칸 포함)
  csv({ from, to, view = 'stores', storeIds = null, shipping = false }) {
    const r = this.report({ from, to });
    const picked = r.stores.filter((s) => !storeIds || storeIds.includes(s.id));
    const sum = (c) => (c ? c.amount + (shipping ? c.shipping : 0) : 0);
    const label = shipping ? '매출(배송비 포함)' : '매출';
    const lines = [];
    const row = (cells) => lines.push(cells.map(cell).join(','));
    if (view === 'daily') {
      row(['날짜', '요일', '주문건수', label, ...picked.flatMap((s) => [`${s.name} 주문건수`, `${s.name} ${label}`])]);
      const tot = ZERO();
      const per = new Map(picked.map((s) => [s.id, ZERO()]));
      for (const d of r.daily) {
        const day = ZERO();
        for (const s of picked) {
          const c = d.stores[s.id];
          if (!c) continue;
          add(day, c);
          add(per.get(s.id), c);
        }
        add(tot, day);
        row([d.date, d.weekday, day.orders, sum(day), ...picked.flatMap((s) => [d.stores[s.id]?.orders || 0, sum(d.stores[s.id])])]);
      }
      row(['합계', '', tot.orders, sum(tot), ...picked.flatMap((s) => [per.get(s.id).orders, sum(per.get(s.id))])]);
    } else {
      row(['판매처', '마켓', '주문건수', label]);
      const tot = ZERO();
      for (const s of picked) {
        add(tot, s);
        row([s.name, marketLabel(s.type), s.orders, sum(s)]);
      }
      row(['합계', '', tot.orders, sum(tot)]);
    }
    const name = `orderhub_sales_${view === 'daily' ? 'daily' : 'stores'}_${r.from.replace(/-/g, '')}-${r.to.replace(/-/g, '')}.csv`;
    return { name, body: '﻿' + lines.join('\r\n') + '\r\n' };
  }
}

module.exports = { SalesReport, MAX_DAYS };
