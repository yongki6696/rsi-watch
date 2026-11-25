// 주기적으로 가격을 확인하고, 결과를 저장소에 기록하고, 화면에 실시간으로 알린다.
import { fetchProductInfo, parseCoupangInput, resolveShortUrl } from './coupang.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const FETCH_BLOCK_COOLDOWN = 6 * 60 * 60 * 1000;
const msg = (e) => String((e && e.message) || e || '알 수 없는 오류').split('\n')[0].slice(0, 300);

export class Tracker {
  /**
   * @param {object} o
   * @param {import('./store.js').Store} o.store
   * @param {import('./browser.js').BrowserManager|null} o.browser
   * @param {(type:string, data:any)=>void} o.broadcast
   * @param {object|null} o.demo  데모 모드일 때 가격 흉내 함수들
   */
  constructor({ store, browser, broadcast, demo = null, log = console.log }) {
    this.store = store;
    this.browser = browser;
    this.broadcast = broadcast;
    this.demo = demo;
    this.log = log;
    this.timer = null;
    this.fetchBlockedUntil = 0;
    this.status = {
      running: false,
      reason: null,
      current: null,
      done: 0,
      total: 0,
      startedAt: null,
      lastRunAt: null,
      nextRunAt: null,
      lastSummary: null,
      cart: { lastSyncAt: null, count: null, error: null, needLogin: false },
      fetchBlocked: false,
    };
  }

  get intervalMs() {
    if (this.demo) return this.demo.intervalMs;
    return this.store.settings.intervalMinutes * 60 * 1000;
  }

  publicStatus() {
    return { ...this.status, fetchBlocked: Date.now() < this.fetchBlockedUntil, intervalMs: this.intervalMs };
  }

  emitStatus() { this.broadcast('status', this.publicStatus()); }

  start(firstDelayMs = 4000) { this.scheduleNext(firstDelayMs); }

  stop() { clearTimeout(this.timer); this.timer = null; }

  scheduleNext(delay = this.intervalMs) {
    clearTimeout(this.timer);
    this.status.nextRunAt = Date.now() + delay;
    this.timer = setTimeout(() => { this.runCycle('schedule').catch((e) => this.log('[cycle] 오류', e)); }, delay);
    this.emitStatus();
  }

  /** 설정(주기)이 바뀌면 다음 확인 시각을 다시 잡는다. */
  reschedule() {
    if (this.status.running) return;
    const base = this.status.lastRunAt || Date.now();
    this.scheduleNext(Math.max(3000, base + this.intervalMs - Date.now()));
  }

  emitProduct(p, point = null) {
    this.broadcast('product', { product: this.store.summary(p), point });
  }

  /** 새 가격을 반영하고, 변동이 있으면 알림 이벤트를 보낸다. */
  applyPrice(p, info, source, t = Date.now()) {
    const before = this.store.summary(p);
    this.store.upsertProduct({
      productId: p.productId,
      itemId: p.itemId,
      vendorItemId: p.vendorItemId,
      name: info.name,
      image: info.image,
      soldOut: info.soldOut === undefined ? undefined : Boolean(info.soldOut),
    });
    const r = this.store.recordPrice(p.id, info.price, source, t);
    const after = this.store.summary(p);
    this.emitProduct(p, r.point);
    if (r.changed) {
      const diff = info.price - r.prev;
      let kind = diff < 0 ? 'drop' : 'rise';
      if (diff < 0 && before.minPrice && info.price < before.minPrice) kind = 'low';
      if (after.targetPrice && info.price <= after.targetPrice && r.prev > after.targetPrice) kind = 'target';
      const alert = { kind, id: p.id, name: after.name, price: info.price, prev: r.prev, diff, pct: (diff / r.prev) * 100, t };
      this.broadcast('alert', alert);
      this.log(`[가격] ${after.name || p.id}: ${r.prev.toLocaleString()}원 → ${info.price.toLocaleString()}원`);
    }
    return r;
  }

  setError(p, e) {
    this.store.updateProduct(p.id, { lastError: msg(e), lastErrorAt: Date.now(), lastCheckedAt: p.lastCheckedAt });
    this.emitProduct(p);
  }

  /** 상품 하나 확인. 빠른 요청 → (차단/실패 시) 브라우저 순서. */
  async checkOne(p) {
    if (this.demo) {
      const info = this.demo.priceFor(p, this.store);
      this.applyPrice(p, info, 'demo');
      return true;
    }
    const s = this.store.settings;
    const errors = [];
    let info = null;
    let source = null;
    const useFetch = s.fetchMode === 'fetch' || (s.fetchMode === 'auto' && Date.now() >= this.fetchBlockedUntil);
    if (useFetch) {
      try {
        info = await fetchProductInfo(p);
        source = 'fetch';
      } catch (e) {
        if (e.blocked) {
          this.fetchBlockedUntil = Date.now() + FETCH_BLOCK_COOLDOWN;
          errors.push('빠른 요청이 차단됨');
        } else errors.push(msg(e));
      }
    }
    if (!info && s.fetchMode !== 'fetch' && this.browser) {
      try {
        info = await this.browser.checkProduct(p);
        source = 'browser';
      } catch (e) {
        errors.push(msg(e));
      }
    }
    if (!this.store.getProduct(p.id)) return false; // 확인 중에 삭제됨
    if (info) {
      this.applyPrice(p, info, source);
      return true;
    }
    this.setError(p, errors.join(' / ') || '가격을 확인하지 못했어요.');
    return false;
  }

  /** 장바구니 목록(북마클릿 또는 브라우저 동기화)을 반영한다. */
  importItems(items, { kind = 'cart', source = 'cart' } = {}) {
    const res = { added: 0, updated: 0, priced: 0, ids: [] };
    const seen = new Set();
    for (const it of items || []) {
      if (!it || !/^\d+$/.test(String(it.productId || ''))) continue;
      const { product, created } = this.store.upsertProduct({
        productId: String(it.productId),
        itemId: it.itemId || null,
        vendorItemId: it.vendorItemId || null,
        name: it.name,
        image: it.image,
        inCart: kind === 'cart' ? true : undefined,
        soldOut: it.soldOut === undefined ? undefined : Boolean(it.soldOut),
      }, { addedFrom: kind });
      seen.add(product.id);
      res.ids.push(product.id);
      if (created) res.added++; else res.updated++;
      const price = Math.round(Number(it.price));
      if (Number.isFinite(price) && price > 0) {
        this.applyPrice(product, { price }, source);
        res.priced++;
      } else {
        this.emitProduct(product);
      }
    }
    if (kind === 'cart') {
      for (const p of this.store.products) {
        if (p.inCart && !seen.has(p.id)) {
          this.store.updateProduct(p.id, { inCart: false });
          this.emitProduct(p);
        }
      }
    }
    return res;
  }

  async syncCart() {
    if (!this.browser) throw new Error('브라우저 자동화를 쓸 수 없어요.');
    try {
      const items = await this.browser.syncCart();
      const res = this.importItems(items, { kind: 'cart', source: 'cart' });
      this.status.cart = { lastSyncAt: Date.now(), count: items.length, error: null, needLogin: false };
      this.emitStatus();
      return res;
    } catch (e) {
      this.status.cart = { ...this.status.cart, error: msg(e), needLogin: Boolean(e.needLogin) };
      this.emitStatus();
      throw e;
    }
  }

  async runCycle(reason = 'manual') {
    if (this.status.running) return false;
    clearTimeout(this.timer);
    const st = this.status;
    Object.assign(st, { running: true, reason, current: null, done: 0, total: 0, startedAt: Date.now(), nextRunAt: null });
    this.emitStatus();
    let ok = 0; let fail = 0;
    try {
      if (this.demo) {
        for (const p of this.demo.pickForTick(this.store)) { await this.checkOne(p); ok++; }
      } else {
        const covered = new Set();
        if (this.store.settings.cartSync && this.browser) {
          st.current = '장바구니';
          this.emitStatus();
          try {
            const r = await this.syncCart();
            for (const id of r.ids) covered.add(id);
            ok += r.priced;
          } catch (e) {
            this.log('[장바구니] 동기화 실패:', msg(e));
          }
        }
        const list = this.store.products.filter((p) => !covered.has(p.id));
        st.total = list.length;
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          if (!this.store.getProduct(p.id)) continue;
          st.current = p.name || `상품 ${p.productId}`;
          st.done = i;
          this.emitStatus();
          if (await this.checkOne(p)) ok++; else fail++;
          if (i < list.length - 1) await sleep(rand(2500, 6000)); // 쿠팡에 부담을 주지 않도록 천천히
        }
        st.done = list.length;
      }
    } finally {
      if (this.browser) await this.browser.idle().catch(() => {});
      // "확인 끝"과 "다음 확인 시각"이 한 번에 바뀌도록 같이 갱신한다
      st.running = false;
      st.current = null;
      st.lastRunAt = Date.now();
      st.lastSummary = { ok, fail, at: st.lastRunAt };
      this.scheduleNext();
    }
    return true;
  }

  /** 붙여넣은 링크로 상품을 추가하고, 곧바로 한 번 확인한다. */
  async addFromInput(text) {
    let parsed = parseCoupangInput(text);
    if (!parsed) throw Object.assign(new Error('쿠팡 상품 링크를 찾지 못했어요. 상품 페이지 주소를 붙여넣어 주세요.'), { status: 400 });
    if (parsed.shortUrl) {
      const short = parsed.shortUrl;
      parsed = null;
      if (!this.demo) {
        try { parsed = await resolveShortUrl(short); } catch { /* 브라우저로 재시도 */ }
        if (!parsed && this.browser && this.store.settings.fetchMode !== 'fetch') {
          try { parsed = await this.browser.resolveUrl(short); } catch { /* ignore */ }
        }
      }
      if (!parsed) throw Object.assign(new Error('짧은 공유 링크를 풀지 못했어요. 쿠팡 상품 페이지를 열어 주소창의 주소를 붙여넣어 주세요.'), { status: 400 });
    }
    const { product, created } = this.store.upsertProduct(parsed, { addedFrom: 'url' });
    this.emitProduct(product);
    // 응답은 바로 돌려주고 가격 확인은 뒤에서
    this.checkOne(product).catch((e) => this.setError(product, e));
    return { product: this.store.summary(product), created };
  }
}
