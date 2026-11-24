'use strict';
// 주문 처리: 마켓 발주확인 / 발주완료 / 송장 저장 / 발송처리
const { getConnector } = require('./connectors');
const { getAppSettings } = require('./settings');
const { courierName, courierCode, findCourier, isDirect } = require('./couriers');
const { nowIso, str, toInt, HttpError } = require('./util');
const { STATUS } = require('./orders');

const ACTIVE = (i) => !['CANCELED', 'RETURNED', 'PENDING'].includes(i.market_state);
// DB 행(item_key) → 커넥터 형식(itemKey)
const forConnector = (items) => items.map((i) => ({ ...i, itemKey: i.item_key }));

class Actions {
  constructor({ db, orders, sync }) {
    this.db = db;
    this.orders = orders;
    this.sync = sync; // ctxFor 사용
  }

  storeOf(order) {
    const s = this.db.get('SELECT * FROM stores WHERE id = ?', order.store_id);
    if (!s) throw new HttpError(404, '스토어를 찾을 수 없습니다');
    return s;
  }

  load(id) {
    const o = this.orders.get(Number(id));
    if (!o) throw new HttpError(404, `주문을 찾을 수 없습니다 (#${id})`);
    return o;
  }

  event(order, message, level = 'info') {
    this.db.addEvent({ orderId: order.id, storeId: order.store_id, level, type: 'action', message });
  }

  markItems(itemKeys, storeId, fields) {
    for (const key of itemKeys) {
      this.db.run('UPDATE order_items SET market_state = ?, market_status = ?, updated_at = ? WHERE store_id = ? AND item_key = ?', fields.state, fields.label, nowIso(), storeId, key);
    }
  }

  // 마켓 발주확인 (결제완료 → 상품준비중/배송준비중)
  async confirmOne(order) {
    const items = order.items.filter((i) => ACTIVE(i) && i.market_state === 'NEW');
    if (!items.length) return { ok: true, message: '이미 발주확인된 주문입니다' };
    const store = this.storeOf(order);
    const connector = getConnector(store.type);
    const ctx = this.sync.ctxFor(store);
    const r = await connector.confirm(ctx, order, forConnector(items));
    if (r.ok.length) {
      this.markItems(r.ok, store.id, { state: 'CONFIRMED', label: '발주확인' });
    }
    const all = this.orders.itemsOf(order.id).filter(ACTIVE);
    const confirmed = all.length > 0 && all.every((i) => i.market_state !== 'NEW');
    this.db.run('UPDATE orders SET market_confirmed = ?, confirmed_at = COALESCE(confirmed_at, ?), updated_at = ? WHERE id = ?', confirmed ? 1 : 0, r.ok.length ? nowIso() : null, nowIso(), order.id);
    if (r.failed.length) {
      const msg = r.failed.map((f) => f.message).join(', ');
      this.event(order, `마켓 발주확인 실패: ${msg}`, 'error');
      return { ok: false, message: `마켓 발주확인 실패: ${msg}` };
    }
    this.event(order, '마켓 발주확인 완료');
    return { ok: true, message: '마켓 발주확인 완료' };
  }

  async confirm(ids, { auto = false } = {}) {
    const results = [];
    for (const id of ids) {
      try {
        const o = this.load(id);
        const r = await this.confirmOne(o);
        if (auto && r.ok) this.event(o, '자동 발주확인');
        results.push({ id: o.id, ...r });
      } catch (e) {
        results.push({ id: Number(id), ok: false, message: e.message });
      }
    }
    return results;
  }

  // 공급처에 발주 완료 (+ 설정 시 마켓 발주확인)
  async purchase(ids, info = {}) {
    const app = getAppSettings(this.db);
    const results = [];
    for (const id of ids) {
      try {
        const o = this.load(id);
        if (!['NEW', 'PURCHASED', 'INVOICED'].includes(o.status)) {
          results.push({ id: o.id, ok: false, message: `${STATUS[o.status]} 상태라 발주완료 처리할 수 없습니다` });
          continue;
        }
        const fields = [];
        const params = [];
        if (info.supplier !== undefined) fields.push('supplier = ?'), params.push(str(info.supplier) || null);
        if (info.supplierOrderNo !== undefined) fields.push('supplier_order_no = ?'), params.push(str(info.supplierOrderNo) || null);
        if (info.cost !== undefined && info.cost !== '') fields.push('cost = ?'), params.push(toInt(info.cost));
        if (info.memo !== undefined) fields.push('memo = ?'), params.push(str(info.memo) || null);
        const newStatus = o.status === 'NEW' ? 'PURCHASED' : o.status;
        this.db.run(
          `UPDATE orders SET ${fields.length ? fields.join(', ') + ', ' : ''}status = ?, purchased_at = COALESCE(purchased_at, ?), updated_at = ? WHERE id = ?`,
          ...params,
          newStatus,
          nowIso(),
          nowIso(),
          o.id
        );
        this.event(o, `발주완료${info.supplier ? ` (공급처: ${str(info.supplier)})` : ''}`);
        let warning = null;
        if (app.confirmOnPurchase && !o.market_confirmed) {
          try {
            const r = await this.confirmOne(this.load(o.id));
            if (!r.ok) warning = r.message;
          } catch (e) {
            warning = `마켓 발주확인 실패: ${e.message}`;
            this.event(o, warning, 'error');
          }
        }
        results.push({ id: o.id, ok: true, warning, message: warning ? `발주완료 처리됨 (주의: ${warning})` : '발주완료 처리됨' });
      } catch (e) {
        results.push({ id: Number(id), ok: false, message: e.message });
      }
    }
    return results;
  }

  // 발주완료 되돌리기 등
  revert(id) {
    const o = this.load(id);
    const map = { PURCHASED: 'NEW', INVOICED: 'PURCHASED' };
    const to = map[o.status];
    if (!to) throw new HttpError(400, `${STATUS[o.status]} 상태는 되돌릴 수 없습니다`);
    const extra = to === 'NEW' ? ', purchased_at = NULL' : ', tracking_no = NULL, courier_key = NULL, dispatch_error = NULL';
    this.db.run(`UPDATE orders SET status = ?${extra}, updated_at = ? WHERE id = ?`, to, nowIso(), o.id);
    this.event(o, `되돌리기: ${STATUS[o.status]} → ${STATUS[to]}`);
    return { ok: true, status: to };
  }

  // 마켓에서 취소된 것을 확인한 주문을 내 목록에서 취소로 표시 (마켓에는 아무것도 보내지 않음)
  cancelLocal(id) {
    const o = this.load(id);
    if (!['NEW', 'PURCHASED', 'INVOICED'].includes(o.status)) throw new HttpError(400, `${STATUS[o.status]} 상태는 취소로 표시할 수 없습니다`);
    this.db.run(`UPDATE orders SET status = 'CANCELED', claim = NULL, updated_at = ? WHERE id = ?`, nowIso(), o.id);
    this.event(o, '취소된 주문으로 표시 (내 목록에서만 처리)');
    return { ok: true, status: 'CANCELED' };
  }

  update(id, input = {}) {
    const o = this.load(id);
    const map = { supplier: 'supplier', supplierOrderNo: 'supplier_order_no', memo: 'memo' };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) {
      if (k in input) sets.push(`${col} = ?`), params.push(str(input[k]) || null);
    }
    if ('cost' in input) sets.push('cost = ?'), params.push(input.cost === '' || input.cost === null ? null : toInt(input.cost));
    if (input.clearAddressChanged) sets.push('address_changed = 0');
    if (!sets.length) return this.load(id);
    this.db.run(`UPDATE orders SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, nowIso(), o.id);
    return this.load(id);
  }

  validateInvoice(storeType, courierKey, trackingNo) {
    const t = str(trackingNo).replace(/\s/g, '');
    if (!courierKey) throw new HttpError(400, '택배사를 선택해주세요');
    // 직접발송(스마트스토어 직접전달 · 쿠팡 업체직송): 송장번호 없어도 됨
    if (isDirect(courierKey)) {
      if (!courierCode(courierKey, storeType)) throw new HttpError(400, '이 마켓은 직접발송(송장번호 없이 발송)을 지원하지 않습니다. 택배사를 선택해주세요');
      if (t && !/^[A-Za-z0-9-]{1,30}$/.test(t)) throw new HttpError(400, '송장번호 칸은 비우거나 영문/숫자로 입력해주세요');
      return t.replace(/-/g, '');
    }
    if (!t) throw new HttpError(400, '송장번호를 입력해주세요');
    if (!/^[A-Za-z0-9-]{6,30}$/.test(t)) throw new HttpError(400, '송장번호 형식을 확인해주세요 (영문/숫자 6~30자)');
    if (!courierCode(courierKey, storeType)) {
      throw new HttpError(400, `${courierName(courierKey)}는 이 마켓에서 지원하지 않는 택배사입니다`);
    }
    return t.replace(/-/g, '');
  }

  saveInvoice(id, { courierKey, trackingNo }) {
    const o = this.load(id);
    if (!['NEW', 'PURCHASED', 'INVOICED'].includes(o.status)) throw new HttpError(400, `${STATUS[o.status]} 상태에서는 송장을 입력할 수 없습니다`);
    const t = this.validateInvoice(o.store_type, courierKey, trackingNo);
    this.db.run(
      `UPDATE orders SET courier_key = ?, tracking_no = ?, status = 'INVOICED', purchased_at = COALESCE(purchased_at, ?), dispatch_error = NULL, updated_at = ? WHERE id = ?`,
      courierKey,
      t,
      nowIso(),
      nowIso(),
      o.id
    );
    this.event(o, `송장 저장: ${courierName(courierKey)} ${t}`.trim());
    return this.load(id);
  }

  async dispatchOne(order) {
    if (!order.courier_key || (!order.tracking_no && !isDirect(order.courier_key))) throw new HttpError(400, '택배사와 송장번호를 먼저 입력해주세요');
    if (!['NEW', 'PURCHASED', 'INVOICED'].includes(order.status)) throw new HttpError(400, `${STATUS[order.status]} 상태라 발송처리할 수 없습니다`);
    const store = this.storeOf(order);
    const connector = getConnector(store.type);
    // 발주확인이 안 된 상품은 먼저 발주확인 (쿠팡·11번가는 필수)
    if (order.items.some((i) => ACTIVE(i) && i.market_state === 'NEW')) {
      const c = await this.confirmOne(order);
      if (!c.ok) throw new HttpError(400, c.message);
      order = this.load(order.id);
    }
    const items = order.items.filter((i) => ACTIVE(i) && (i.market_state === 'NEW' || i.market_state === 'CONFIRMED'));
    if (!items.length) throw new HttpError(400, '발송처리할 상품이 없습니다 (취소되었거나 이미 발송됨)');
    const ctx = this.sync.ctxFor(store);
    const r = await connector.dispatch(ctx, order, forConnector(items), { courierKey: order.courier_key, trackingNo: order.tracking_no });
    if (r.ok.length) this.markItems(r.ok, store.id, { state: 'SHIPPED', label: '발송완료' });
    const ts = nowIso();
    if (!r.failed.length) {
      this.db.run(`UPDATE orders SET status = 'SHIPPED', dispatched_at = ?, dispatch_error = NULL, market_status = '발송완료', updated_at = ? WHERE id = ?`, ts, ts, order.id);
      this.event(order, `발송처리 완료: ${courierName(order.courier_key)} ${order.tracking_no}`);
      return { ok: true, message: '발송처리 완료' };
    }
    const msg = r.failed.map((f) => f.message).join(', ');
    this.db.run(`UPDATE orders SET status = 'INVOICED', dispatch_error = ?, updated_at = ? WHERE id = ?`, msg, ts, order.id);
    this.event(order, `발송처리 실패: ${msg}`, 'error');
    return { ok: false, message: `발송처리 실패: ${msg}` };
  }

  async dispatch(ids) {
    const results = [];
    for (const id of ids) {
      try {
        const r = await this.dispatchOne(this.load(id));
        results.push({ id: Number(id), ...r });
      } catch (e) {
        try {
          const o = this.load(id);
          this.db.run('UPDATE orders SET dispatch_error = ?, updated_at = ? WHERE id = ?', e.message, nowIso(), o.id);
          this.event(o, `발송처리 실패: ${e.message}`, 'error');
        } catch {}
        results.push({ id: Number(id), ok: false, message: e.message });
      }
    }
    return results;
  }

  // 송장 일괄 등록: rows = [{ orderNo, courier, trackingNo }]
  async bulkInvoices(rows, { dispatch = false } = {}) {
    const report = [];
    const toDispatch = [];
    for (const row of rows) {
      const key = str(row.orderNo);
      const courierKey = row.courierKey || findCourier(row.courier);
      if (!key) continue;
      const matches = this.db.all(
        `SELECT DISTINCT o.id FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
         WHERE o.status IN ('NEW','PURCHASED','INVOICED') AND (o.order_no = ? OR o.group_key = ? OR i.item_key = ? OR i.order_no = ?)`,
        key,
        key,
        key,
        key
      );
      if (!matches.length) {
        report.push({ orderNo: key, ok: false, message: '처리 대기 중인 주문을 찾지 못했습니다' });
        continue;
      }
      if (!courierKey) {
        report.push({ orderNo: key, ok: false, message: `택배사를 알 수 없습니다: ${row.courier || '(비어있음)'}` });
        continue;
      }
      for (const m of matches) {
        try {
          this.saveInvoice(m.id, { courierKey, trackingNo: row.trackingNo });
          report.push({ orderNo: key, id: m.id, ok: true, message: '송장 저장' });
          if (dispatch) toDispatch.push(m.id);
        } catch (e) {
          report.push({ orderNo: key, id: m.id, ok: false, message: e.message });
        }
      }
    }
    if (toDispatch.length) {
      const res = await this.dispatch(toDispatch);
      for (const r of res) {
        const line = report.find((x) => x.id === r.id && x.ok);
        if (line) {
          line.ok = r.ok;
          line.message = r.ok ? '발송처리 완료' : r.message;
        }
      }
    }
    return report;
  }
}

module.exports = { Actions };
