'use strict';
// 주문 자동 수집 스케줄러 (기본 5분 간격) + 신규주문/취소요청 알림
const { getConnector } = require('./connectors');
const { getAppSettings } = require('./settings');
const { safeJson, nowIso, kstDate } = require('./util');
const { CLAIM } = require('./orders');

class SyncEngine {
  constructor({ db, secrets, config, notifier, orders, actions, inquiries }) {
    this.db = db;
    this.inquiries = inquiries;
    this.secrets = secrets;
    this.config = config;
    this.notifier = notifier;
    this.orders = orders;
    this.actions = actions;
    this.running = null;
    this.timer = null;
    this.lastRunAt = null;
    this.nextRunAt = null;
    this.lastResult = null;
    this.backfillState = null; // 지난 주문 불러오기 진행 상황
  }

  intervalMs() {
    return Math.max(1, getAppSettings(this.db).pollIntervalMin) * 60000;
  }

  start() {
    if (this.config.disableScheduler) return;
    this.schedule(15000); // 서버 시작 15초 후 첫 수집
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    clearTimeout(this.timer);
    if (this.config.disableScheduler) {
      this.nextRunAt = null;
      return;
    }
    const ms = delay ?? this.intervalMs();
    this.nextRunAt = new Date(Date.now() + ms).toISOString();
    this.timer = setTimeout(async () => {
      try {
        await this.runAll({ manual: false });
      } catch (e) {
        console.error('[sync] 실패', e);
      }
    }, ms);
    this.timer.unref?.();
  }

  // 설정에서 주기를 바꿨을 때 다음 실행 시각 재계산
  reschedule() {
    if (this.config.disableScheduler) return;
    if (!this.running) this.schedule();
  }

  ctxFor(store, extra = {}) {
    const creds = store.credentials ? this.secrets.decrypt(store.credentials) : {};
    return {
      creds,
      state: safeJson(store.state, {}),
      config: this.config,
      store,
      initialDays: getAppSettings(this.db).initialDays,
      openGroups: () => this.orders.openGroups(store.id),
      log: (message) => this.db.addEvent({ storeId: store.id, level: 'warn', type: 'sync', message }),
      ...extra,
    };
  }

  status() {
    const stores = this.db.all('SELECT id, type, name, enabled, last_sync_at, last_success_at, last_error FROM stores ORDER BY id');
    return {
      running: !!this.running,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.config.disableScheduler ? null : this.nextRunAt,
      intervalMin: getAppSettings(this.db).pollIntervalMin,
      lastResult: this.lastResult,
      inquiriesOpen: this.inquiries ? this.inquiries.counts().open : 0,
      unseen: this.orders.unseenCount(),
      backfill: this.backfillState,
      stores,
    };
  }

  runAll(opts = {}) {
    if (this.running) {
      // 같은 범위의 수집이 진행 중이면 그 결과를 기다리고, 범위가 다르면 끝난 뒤 이어서 실행
      const same =
        (opts.storeId || null) === (this.runningOpts?.storeId || null) && (opts.backfillDays || 0) === (this.runningOpts?.backfillDays || 0);
      if (same) return this.running;
      return this.running.catch(() => {}).then(() => this.runAll(opts));
    }
    this.runningOpts = opts;
    this.running = this._runAll(opts).finally(() => {
      this.running = null;
      this.runningOpts = null;
      this.lastRunAt = nowIso();
      this.schedule();
    });
    return this.running;
  }

  // 지난 주문 불러오기 (매출 집계용) - 오래 걸릴 수 있어 진행 상황을 backfillState 로 보여준다
  backfill({ days, storeId = null }) {
    if (this.backfillState?.running) return this.backfillRun;
    const state = { running: true, days, storeId, startedAt: nowIso(), done: 0, total: 0, current: null, results: [] };
    this.backfillState = state;
    const onStore = ({ index, total, store }) => Object.assign(state, { done: index, total, current: store.name });
    this.backfillRun = this.runAll({ manual: true, storeId, backfillDays: days, onStore }).then(
      (summary) => {
        Object.assign(state, {
          running: false,
          finishedAt: nowIso(),
          current: null,
          done: summary.stores.length,
          total: summary.stores.length,
          results: summary.stores.map((r) => ({
            storeId: r.storeId,
            name: r.name,
            type: r.type,
            added: r.added || 0,
            updated: r.updated || 0,
            error: r.error || null,
            skipped: r.skipped || null,
            warnings: r.warnings || null,
          })),
        });
        return state;
      },
      (e) => {
        Object.assign(state, { running: false, finishedAt: nowIso(), current: null, error: e.message });
        return state;
      }
    );
    return this.backfillRun;
  }

  async _runAll({ manual = false, storeId = null, backfillDays = 0, onStore } = {}) {
    const stores = this.db.all('SELECT * FROM stores WHERE enabled = 1' + (storeId ? ' AND id = ?' : '') + ' ORDER BY id', ...(storeId ? [storeId] : []));
    const summary = { stores: [], newOrders: 0, claims: 0, canceled: 0, inquiries: 0, errors: 0, at: nowIso() };
    const alerts = { newOrders: [], claims: [], canceled: [], address: [], errors: [], recovered: [], imported: [], inquiries: [] };

    for (const [index, store] of stores.entries()) {
      onStore?.({ index, total: stores.length, store });
      const r = await this.syncStore(store, { manual, backfillDays }, alerts);
      summary.stores.push(r);
      if (r.error) summary.errors++;
      summary.newOrders += r.newOrders || 0;
      summary.claims += r.claims || 0;
      summary.canceled += r.canceled || 0;
      summary.inquiries += r.inquiries || 0;
    }
    if (!backfillDays) this.lastResult = summary;
    await this.sendAlerts(alerts);

    // 자동 발주확인
    const app = getAppSettings(this.db);
    if (app.autoConfirm && alerts.newOrders.length && this.actions) {
      try {
        await this.actions.confirm(alerts.newOrders.map((a) => a.orderId), { auto: true });
      } catch (e) {
        this.db.addEvent({ level: 'error', type: 'action', message: `자동 발주확인 실패: ${e.message}` });
      }
    }
    if (Math.random() < 0.02) this.db.pruneEvents();
    return summary;
  }

  async syncStore(store, { manual, backfillDays = 0 }, alerts) {
    const ts = nowIso();
    const result = { storeId: store.id, name: store.name, type: store.type, newOrders: 0, claims: 0, canceled: 0, inquiries: 0, updated: 0, added: 0 };
    let connector;
    try {
      connector = getConnector(store.type);
      if (backfillDays && !connector.backfill) {
        result.skipped = `${connector.label}은(는) 지난 주문 불러오기를 지원하지 않습니다`;
        return result;
      }
      const ctx = this.ctxFor(store, { manual, backfillDays });
      const firstSync = !ctx.state._syncedOnce;
      // 첫 연결·지난 주문 불러오기로 가져온 주문은 알림 없이 저장
      const quiet = firstSync || !!backfillDays;
      const { groups, state, warnings } = await connector.fetch(ctx);
      let imported = 0;
      for (const g of groups || []) {
        const ch = this.orders.applyGroup(store, g);
        if (!ch) continue;
        result.updated++;
        if (ch.isNew) result.added++;
        // 첫 연결·지난 주문으로 조용히 가져온 주문은 '새 주문' 숫자에 넣지 않음
        if (ch.isNew && quiet) this.orders.markSeen({ ids: [ch.orderId] });
        if (ch.isNew && ch.status === 'NEW') {
          if (quiet) imported++;
          else {
            result.newOrders++;
            alerts.newOrders.push({ store, orderId: ch.orderId });
            this.db.addEvent({ orderId: ch.orderId, storeId: store.id, type: 'new_order', message: '신규주문 알림 대상' });
          }
        }
        if (!ch.isNew && ch.claim && ch.claim !== ch.prevClaim) {
          result.claims++;
          alerts.claims.push({ store, orderId: ch.orderId, claim: ch.claim, prevStatus: ch.prevStatus });
        }
        if (!ch.isNew && (ch.status === 'CANCELED' || ch.status === 'RETURNED') && ch.prevStatus !== ch.status) {
          result.canceled++;
          alerts.canceled.push({ store, orderId: ch.orderId, prevStatus: ch.prevStatus, status: ch.status });
        }
        if (ch.addressChangedNow) alerts.address.push({ store, orderId: ch.orderId });
      }
      const newState = { ...(state || {}), _syncedOnce: true };
      // 매출 집계용: 이 날짜 이후 주문은 모두 수집됨
      if (!newState.coverageFrom) {
        const base = firstSync ? Date.now() : Date.parse(store.created_at);
        newState.coverageFrom = kstDate(new Date(base - (getAppSettings(this.db).initialDays || 7) * 86400000));
      }
      if (backfillDays) {
        const from = kstDate(new Date(Date.now() - backfillDays * 86400000));
        if (from < newState.coverageFrom) newState.coverageFrom = from;
        newState.backfilledAt = ts;
        if (!ctx.state._syncedOnce) delete newState._syncedOnce; // 첫 수집은 평소 수집에서 (기존 문의 알림 방지 등)
        if (warnings?.length) {
          result.warnings = warnings;
          this.db.addEvent({ storeId: store.id, level: 'warn', type: 'sync', message: `지난 주문 불러오기 일부 실패: ${warnings.join(' / ')}`.slice(0, 500) });
        }
        this.db.addEvent({ storeId: store.id, type: 'sync', message: `지난 ${backfillDays}일 주문 불러오기: ${result.added}건 추가, ${result.updated - result.added}건 갱신` });
        this.db.run('UPDATE stores SET state = ? WHERE id = ?', JSON.stringify(newState), store.id);
        return result;
      }
      // 고객 문의 수집 (실패해도 주문 수집은 정상 처리)
      if (connector.fetchInquiries && this.inquiries && getAppSettings(this.db).collectInquiries !== false) {
        try {
          const list = await connector.fetchInquiries({ ...ctx, firstSync });
          for (const q of list || []) {
            const r = this.inquiries.apply(store, q);
            if (r?.isNew && !q.answered && !firstSync) {
              result.inquiries++;
              alerts.inquiries.push({ store, id: r.id });
            }
          }
          delete newState.inquiryError;
        } catch (e) {
          if (newState.inquiryError !== e.message) {
            this.db.addEvent({ storeId: store.id, level: 'warn', type: 'sync', message: `문의 수집 실패 (주문 수집은 정상): ${e.message}` });
          }
          newState.inquiryError = e.message;
        }
      }
      if (firstSync) {
        alerts.imported.push({ store, count: imported });
        if (imported) this.db.addEvent({ storeId: store.id, type: 'sync', message: `첫 연결: 최근 주문 ${imported}건을 불러왔습니다` });
      }
      if (store.last_error) {
        alerts.recovered.push({ store });
        this.db.addEvent({ storeId: store.id, type: 'sync', message: '수집이 정상화되었습니다' });
      }
      this.db.run(
        'UPDATE stores SET state = ?, last_sync_at = ?, last_success_at = ?, last_error = NULL WHERE id = ?',
        JSON.stringify(newState),
        ts,
        ts,
        store.id
      );
    } catch (e) {
      result.error = e.message;
      if (backfillDays) {
        // 지난 주문 불러오기 실패는 평소 수집 상태(오류 표시/알림)에 영향을 주지 않음
        this.db.addEvent({ storeId: store.id, level: 'error', type: 'sync', message: `지난 주문 불러오기 실패: ${e.message}` });
        return result;
      }
      const firstError = !store.last_error;
      this.db.run('UPDATE stores SET last_sync_at = ?, last_error = ? WHERE id = ?', ts, e.message, store.id);
      if (firstError || store.last_error !== e.message) {
        this.db.addEvent({ storeId: store.id, level: 'error', type: 'sync', message: `수집 실패: ${e.message}` });
      }
      if (firstError) alerts.errors.push({ store, message: e.message });
      if (!e.network) console.error(`[sync] ${store.name}:`, e.message);
    }
    return result;
  }

  async sendAlerts(alerts) {
    const n = this.notifier;
    if (!n) return;
    const label = (store) => `${store.name}`;

    // 홈 화면 앱 아이콘 숫자 배지 = 아직 확인하지 않은 신규주문 수
    const badgeCount = alerts.newOrders.length ? this.orders.unseenCount() : undefined;
    // 신규주문: 5건까지는 개별 알림, 그 이상은 요약 1건
    if (alerts.newOrders.length && alerts.newOrders.length <= 5) {
      for (const a of alerts.newOrders) {
        const o = this.orders.get(a.orderId);
        if (!o) continue;
        await n.send({
          type: 'newOrder',
          title: `🛒 신규주문 · ${label(a.store)}`,
          body: this.orders.describe(o),
          url: `/#/order/${o.id}`,
          tag: `order-${o.id}`,
          badgeCount,
        });
      }
    } else if (alerts.newOrders.length > 5) {
      const byStore = {};
      for (const a of alerts.newOrders) byStore[a.store.name] = (byStore[a.store.name] || 0) + 1;
      await n.send({
        type: 'newOrder',
        title: `🛒 신규주문 ${alerts.newOrders.length}건`,
        body: Object.entries(byStore)
          .map(([k, v]) => `${k} ${v}건`)
          .join(' · '),
        url: '/#/orders/new',
        tag: 'new-orders',
        badgeCount,
      });
    }

    for (const a of alerts.claims) {
      const o = this.orders.get(a.orderId);
      if (!o) continue;
      const urgent = a.prevStatus === 'PURCHASED' || a.prevStatus === 'INVOICED';
      await n.send({
        type: 'claim',
        title: `⚠️ ${CLAIM[a.claim] || '클레임'} · ${label(a.store)}`,
        body: `${this.orders.describe(o)}${urgent ? '\n이미 발주한 주문입니다. 공급처 주문을 확인하세요!' : ''}`,
        url: `/#/order/${o.id}`,
        tag: `claim-${o.id}`,
        priority: 'high',
      });
    }

    for (const a of alerts.canceled) {
      const o = this.orders.get(a.orderId);
      if (!o) continue;
      const afterPurchase = a.prevStatus === 'PURCHASED' || a.prevStatus === 'INVOICED';
      if (!afterPurchase && a.status === 'CANCELED' && a.prevStatus !== 'NEW') continue;
      await n.send({
        type: 'claim',
        title: `🚫 주문${a.status === 'RETURNED' ? '반품' : '취소'} · ${label(a.store)}`,
        body: `${this.orders.describe(o)}${afterPurchase ? '\n발주완료된 주문이 취소되었습니다. 공급처 주문도 취소하세요!' : ''}`,
        url: `/#/order/${o.id}`,
        tag: `cancel-${o.id}`,
        priority: afterPurchase ? 'high' : 'default',
      });
    }

    for (const a of alerts.address) {
      const o = this.orders.get(a.orderId);
      if (!o) continue;
      await n.send({
        type: 'claim',
        title: `📍 배송지 변경 · ${label(a.store)}`,
        body: `${o.receiver_name} · ${o.address1 || ''} ${o.address2 || ''}`.trim(),
        url: `/#/order/${o.id}`,
        tag: `addr-${o.id}`,
        priority: 'high',
      });
    }

    if (alerts.inquiries.length && alerts.inquiries.length <= 3) {
      for (const a of alerts.inquiries) {
        const q = this.inquiries.get(a.id);
        if (!q) continue;
        await n.send({
          type: 'inquiry',
          title: `💬 ${q.kind === 'product' ? '상품문의' : '고객문의'} · ${label(a.store)}`,
          body: this.inquiries.describe(q),
          url: '/#/inquiries',
          tag: `inquiry-${q.id}`,
        });
      }
    } else if (alerts.inquiries.length > 3) {
      await n.send({ type: 'inquiry', title: `💬 새 문의 ${alerts.inquiries.length}건`, body: '답변을 기다리는 문의가 있습니다.', url: '/#/inquiries', tag: 'inquiries' });
    }

    for (const a of alerts.errors) {
      await n.send({
        type: 'error',
        title: `❗ 주문 수집 오류 · ${label(a.store)}`,
        body: a.message.slice(0, 300),
        url: '/#/stores',
        tag: `error-${a.store.id}`,
      });
    }
    for (const a of alerts.recovered) {
      await n.send({ type: 'error', title: `✅ 주문 수집 정상화 · ${label(a.store)}`, body: '다시 정상적으로 주문을 수집하고 있습니다.', url: '/', tag: `error-${a.store.id}`, priority: 'low' });
    }
    for (const a of alerts.imported) {
      await n.send({
        type: 'newOrder',
        title: `🔗 ${label(a.store)} 연결 완료`,
        body: a.count ? `처리 대기 중인 최근 주문 ${a.count}건을 불러왔습니다.` : '연결되었습니다. 이제 새 주문이 들어오면 알려드릴게요.',
        url: '/#/orders/new',
        tag: `import-${a.store.id}`,
        priority: 'low',
      });
    }
  }
}

module.exports = { SyncEngine };
