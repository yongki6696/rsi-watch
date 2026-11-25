// 아주 단순한 JSON 파일 저장소. 개인용(상품 수십~수백 개) 규모를 가정한다.
// 가격 기록은 "가격이 바뀐 순간"만 남기고, 마지막 확인 시각은 상품에 따로 둔다.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  intervalMinutes: 30,      // 자동 확인 주기
  fetchMode: 'auto',        // auto: 빠른 요청 → 실패 시 브라우저 / fetch / browser
  browserMode: 'headless',  // headless: 창 없이 / window: 브라우저 창을 띄워서
  browserChannel: 'auto',   // auto: chrome → msedge → 내장 chromium
  cartSync: false,          // 로그인된 브라우저로 장바구니 자동 동기화
});

const INTERVAL_CHOICES = [10, 15, 30, 60, 120, 180, 360];
const FETCH_MODES = ['auto', 'fetch', 'browser'];
const BROWSER_MODES = ['headless', 'window'];
const CHANNELS = ['auto', 'chrome', 'msedge', 'chromium'];

export function productKey({ productId, itemId, vendorItemId }) {
  return [productId, itemId || 0, vendorItemId || 0].join('-');
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, settings: { ...DEFAULT_SETTINGS }, products: [], history: {} };
    this._timer = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
      this.data.products = Array.isArray(parsed.products) ? parsed.products : [];
      this.data.history = parsed.history && typeof parsed.history === 'object' ? parsed.history : {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 깨진 파일은 덮어쓰지 않도록 백업해 둔다
        const backup = `${this.file}.broken-${Date.now()}`;
        try { fs.copyFileSync(this.file, backup); } catch { /* ignore */ }
        console.warn(`[store] 데이터 파일을 읽지 못해 새로 시작합니다 (백업: ${backup}):`, err.message);
      }
    }
    for (const p of this.data.products) {
      if (!this.data.history[p.id]) this.data.history[p.id] = [];
    }
    return this;
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // ---------- 설정 ----------
  get settings() { return this.data.settings; }

  updateSettings(patch = {}) {
    const s = { ...this.data.settings };
    if (patch.intervalMinutes !== undefined) {
      const n = Number(patch.intervalMinutes);
      if (!INTERVAL_CHOICES.includes(n)) throw new Error(`확인 주기는 ${INTERVAL_CHOICES.join(', ')}분 중 하나여야 해요.`);
      s.intervalMinutes = n;
    }
    if (patch.fetchMode !== undefined) {
      if (!FETCH_MODES.includes(patch.fetchMode)) throw new Error('알 수 없는 가져오기 방식이에요.');
      s.fetchMode = patch.fetchMode;
    }
    if (patch.browserMode !== undefined) {
      if (!BROWSER_MODES.includes(patch.browserMode)) throw new Error('알 수 없는 브라우저 모드예요.');
      s.browserMode = patch.browserMode;
    }
    if (patch.browserChannel !== undefined) {
      if (!CHANNELS.includes(patch.browserChannel)) throw new Error('알 수 없는 브라우저 종류예요.');
      s.browserChannel = patch.browserChannel;
    }
    if (patch.cartSync !== undefined) s.cartSync = Boolean(patch.cartSync);
    this.data.settings = s;
    this.save();
    return s;
  }

  // ---------- 상품 ----------
  get products() { return this.data.products; }

  getProduct(id) { return this.data.products.find((p) => p.id === id) || null; }

  history(id) { return this.data.history[id] || []; }

  /**
   * 같은 상품이면 정보만 갱신, 없으면 새로 만든다.
   * itemId/vendorItemId 가 없는 기존 상품에 옵션 정보가 들어오면 같은 상품으로 합친다.
   */
  upsertProduct(info, { addedFrom = 'url', now = Date.now() } = {}) {
    if (!info || !info.productId) throw new Error('상품 번호가 없어요.');
    const key = productKey(info);
    let p = this.data.products.find((x) => x.id === key);
    if (!p && (info.itemId || info.vendorItemId)) {
      p = this.data.products.find((x) => x.productId === String(info.productId) && !x.itemId && !x.vendorItemId);
      if (p) {
        // 옵션 정보가 생겼으니 키를 옮긴다
        const oldId = p.id;
        p.id = key;
        p.itemId = info.itemId ? String(info.itemId) : null;
        p.vendorItemId = info.vendorItemId ? String(info.vendorItemId) : null;
        p.url = canonicalUrl(p);
        this.data.history[key] = this.data.history[oldId] || [];
        delete this.data.history[oldId];
      }
    }
    let created = false;
    if (!p) {
      created = true;
      p = {
        id: key,
        productId: String(info.productId),
        itemId: info.itemId ? String(info.itemId) : null,
        vendorItemId: info.vendorItemId ? String(info.vendorItemId) : null,
        name: null,
        image: null,
        url: null,
        addedAt: now,
        addedFrom,
        inCart: false,
        targetPrice: null,
        soldOut: false,
        lastCheckedAt: null,
        lastError: null,
        lastErrorAt: null,
      };
      p.url = canonicalUrl(p);
      this.data.products.push(p);
      this.data.history[key] = [];
    }
    if (info.name && !p.customName) p.name = String(info.name).slice(0, 300);
    if (info.image) p.image = String(info.image);
    if (info.inCart !== undefined) p.inCart = Boolean(info.inCart);
    if (info.soldOut !== undefined) p.soldOut = Boolean(info.soldOut);
    this.save();
    return { product: p, created };
  }

  updateProduct(id, patch = {}) {
    const p = this.getProduct(id);
    if (!p) return null;
    if (patch.targetPrice !== undefined) {
      if (patch.targetPrice === null || patch.targetPrice === '') p.targetPrice = null;
      else {
        const n = Math.round(Number(patch.targetPrice));
        if (!Number.isFinite(n) || n <= 0) throw new Error('목표가는 0보다 큰 숫자여야 해요.');
        p.targetPrice = n;
      }
    }
    if (patch.name !== undefined && String(patch.name).trim()) {
      p.name = String(patch.name).trim().slice(0, 300);
      p.customName = true;
    }
    for (const k of ['lastCheckedAt', 'lastError', 'lastErrorAt', 'soldOut', 'inCart', 'image']) {
      if (patch[k] !== undefined) p[k] = patch[k];
    }
    this.save();
    return p;
  }

  removeProduct(id) {
    const before = this.data.products.length;
    this.data.products = this.data.products.filter((p) => p.id !== id);
    delete this.data.history[id];
    this.save();
    return this.data.products.length !== before;
  }

  /**
   * 가격을 기록한다. 직전 가격과 같으면 기록하지 않고 확인 시각만 갱신.
   * @returns {{changed:boolean, prev:number|null, point:object|null}}
   */
  recordPrice(id, price, source, t = Date.now()) {
    const p = this.getProduct(id);
    if (!p) throw new Error('없는 상품이에요.');
    const n = Math.round(Number(price));
    if (!Number.isFinite(n) || n <= 0) throw new Error('가격이 올바르지 않아요.');
    const h = (this.data.history[id] ||= []);
    const last = h[h.length - 1];
    p.lastCheckedAt = Math.max(p.lastCheckedAt || 0, t);
    p.lastError = null;
    p.lastErrorAt = null;
    if (last && last.p === n) {
      this.save();
      return { changed: false, prev: last.p, point: null };
    }
    // 과거 시각의 기록이 늦게 들어오면 순서를 지켜 끼워 넣는다
    const point = { t, p: n, s: source };
    if (last && t < last.t) {
      let i = h.length;
      while (i > 0 && h[i - 1].t > t) i--;
      if (h[i - 1] && h[i - 1].p === n) { this.save(); return { changed: false, prev: n, point: null }; }
      h.splice(i, 0, point);
    } else {
      h.push(point);
    }
    this.save();
    return { changed: Boolean(last), prev: last ? last.p : null, point };
  }

  summary(p) {
    const h = this.history(p.id);
    const last = h[h.length - 1] || null;
    const prev = h.length > 1 ? h[h.length - 2] : null;
    let min = null; let max = null;
    for (const pt of h) {
      if (!min || pt.p < min.p) min = pt;   // 같은 최저가면 처음 기록 시각
      if (!max || pt.p > max.p) max = pt;
    }
    const price = last ? last.p : null;
    const change = last && prev ? last.p - prev.p : 0;
    return {
      ...p,
      price,
      prevPrice: prev ? prev.p : null,
      change,
      changePct: prev ? (change / prev.p) * 100 : 0,
      changedAt: prev ? last.t : null,
      minPrice: min ? min.p : null,
      minAt: min ? min.t : null,
      maxPrice: max ? max.p : null,
      maxAt: max ? max.t : null,
      firstPrice: h[0] ? h[0].p : null,
      changes: Math.max(0, h.length - 1),
      atTarget: Boolean(p.targetPrice && price && price <= p.targetPrice),
    };
  }
}

export function canonicalUrl({ productId, itemId, vendorItemId }) {
  const q = new URLSearchParams();
  if (itemId) q.set('itemId', itemId);
  if (vendorItemId) q.set('vendorItemId', vendorItemId);
  const qs = q.toString();
  return `https://www.coupang.com/vp/products/${productId}${qs ? `?${qs}` : ''}`;
}
