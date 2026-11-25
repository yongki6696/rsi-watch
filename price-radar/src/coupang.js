// 쿠팡 파트너스 Open API 클라이언트.
// 인증: HMAC-SHA256 서명 (Access Key / Secret Key). 키는 Cloudflare 비밀 변수에만 둔다.
import { enc, toInt, intEnv, hash32 } from './util.js';
import { getMeta, setMeta } from './db.js';

export const API_PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1';
const DEFAULT_BASE = 'https://api-gateway.coupang.com';

// 카테고리별 베스트 상품 (파트너스 API 카테고리 번호)
export const CATEGORIES = [
  ['1012', '식품'],
  ['1014', '생활용품'],
  ['1016', '가전디지털'],
  ['1010', '뷰티'],
  ['1013', '주방용품'],
  ['1024', '헬스/건강식품'],
  ['1011', '출산/유아동'],
  ['1029', '반려동물용품'],
];

export class BudgetError extends Error {
  constructor(message = '지금은 가격 조회가 몰려 있어요. 잠시 후 다시 시도해 주세요.') { super(message); this.name = 'BudgetError'; this.budget = true; }
}
export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

export function partnersConfigured(env) {
  return Boolean(env.COUPANG_ACCESS_KEY && env.COUPANG_SECRET_KEY) && env.MOCK_COUPANG !== '1';
}

/** yyMMdd'T'HHmmss'Z' (GMT) */
export function signedDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 서명 문자열 = 서명시각 + 메서드 + 경로 + 쿼리(물음표 없이) */
export async function authorization({ accessKey, secretKey, method, path, query = '', date = signedDate() }) {
  const signature = await hmacHex(secretKey, `${date}${method}${path}${query}`);
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${date}, signature=${signature}`;
}

export function buildQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function normalizeItem(x) {
  if (!x) return null;
  const productId = x.productId !== undefined && x.productId !== null ? String(x.productId) : null;
  const price = toInt(x.productPrice);
  if (!productId || !price) return null;
  return {
    productId,
    name: String(x.productName || '').slice(0, 200),
    price,
    image: x.productImage || null,
    url: x.productUrl || null,
    isRocket: Boolean(x.isRocket),
    isFreeShipping: Boolean(x.isFreeShipping),
    category: x.categoryName || null,
    rank: toInt(x.rank),
  };
}

const listOf = (data) => (Array.isArray(data) ? data : (data && (data.productData || data.products)) || []);

/** 지난 1시간 동안의 호출 수로 한도를 지킨다 */
export class Budget {
  constructor(env) {
    this.db = env.DB;
    this.limit = intEnv(env, 'API_HOURLY_LIMIT', 20, 1, 1000);
  }
  /** 멈춤 여부와 지난 1시간 사용량을 쿼리 한 번으로 */
  async state(now = Date.now()) {
    const row = await this.db.prepare("SELECT (SELECT value FROM meta WHERE key = 'api_paused_until') AS paused, (SELECT COUNT(*) FROM api_log WHERE t > ?) AS used")
      .bind(now - 3600 * 1000).first();
    const used = row ? row.used : 0;
    return { pausedUntil: Number(row && row.paused) || 0, used, remaining: Math.max(0, this.limit - used) };
  }
  async used(now = Date.now()) { return (await this.state(now)).used; }
  async remaining(now = Date.now()) { return (await this.state(now)).remaining; }
  async pausedUntil() { return (await this.state()).pausedUntil; }
  async pause(ms, reason) {
    await setMeta(this.db, 'api_paused_until', Date.now() + ms);
    await setMeta(this.db, 'last_api_error', JSON.stringify({ t: Date.now(), message: String(reason).slice(0, 300) }));
  }
  async record(kind, ok) {
    await this.db.prepare('INSERT INTO api_log (t, kind, ok) VALUES (?, ?, ?)').bind(Date.now(), kind, ok ? 1 : 0).run();
  }
}

export class PartnersApi {
  constructor(env) {
    this.env = env;
    this.base = (env.COUPANG_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
    this.subId = env.COUPANG_SUB_ID || null;
    this.budget = new Budget(env);
    this.mock = false;
  }

  /**
   * @param {object} o
   * @param {number} [o.minRemaining=1] 남은 호출 수가 이보다 적으면 부르지 않는다 (정기 확인은 사용자 몫을 남겨 둔다)
   */
  async call(method, sub, { query = {}, body, kind = 'other', minRemaining = 1 } = {}) {
    const now = Date.now();
    const st = await this.budget.state(now);
    if (st.pausedUntil > now) throw new BudgetError('쿠팡 API 사용을 잠시 멈춘 상태예요. 조금 뒤 자동으로 다시 시도해요.');
    if (st.remaining < minRemaining) throw new BudgetError();
    const path = `${API_PATH}${sub}`;
    const qs = buildQuery(query);
    const headers = {
      Authorization: await authorization({ accessKey: this.env.COUPANG_ACCESS_KEY, secretKey: this.env.COUPANG_SECRET_KEY, method, path, query: qs }),
      'Content-Type': 'application/json;charset=UTF-8',
    };
    await this.budget.record(kind, true); // 시도 자체를 센다 (실패해도 한도에 포함)
    let res;
    let data = null;
    try {
      res = await fetch(`${this.base}${path}${qs ? `?${qs}` : ''}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000),
      });
      data = await res.json().catch(() => null);
    } catch (e) {
      throw new ApiError(`쿠팡 API에 연결하지 못했어요 (${e.message})`);
    }
    const rCode = data && data.rCode !== undefined ? String(data.rCode) : null;
    const msg = (data && (data.rMessage || data.message)) || '';
    if (!res.ok || (rCode !== null && rCode !== '0')) {
      const text = `${res.status} ${rCode || ''} ${msg}`.trim();
      if (res.status === 429 || /limit|exceed|too many|초과|제한/i.test(msg)) await this.budget.pause(60 * 60 * 1000, `호출 한도 초과: ${text}`);
      else if (res.status === 401 || res.status === 403 || /signature|auth|access.?key|권한|인증/i.test(msg)) await this.budget.pause(30 * 60 * 1000, `인증 실패(키 확인 필요): ${text}`);
      else await setMeta(this.env.DB, 'last_api_error', JSON.stringify({ t: now, message: text.slice(0, 300) }));
      throw new ApiError(`쿠팡 API 오류: ${text}`, res.status);
    }
    return data ? data.data : null;
  }

  async search(keyword, { limit = 10, minRemaining = 1 } = {}) {
    const data = await this.call('GET', '/products/search', { query: { keyword, limit, subId: this.subId }, kind: 'search', minRemaining });
    return listOf(data).map(normalizeItem).filter(Boolean);
  }

  async goldbox({ minRemaining = 1 } = {}) {
    const data = await this.call('GET', '/products/goldbox', { query: { subId: this.subId }, kind: 'goldbox', minRemaining });
    return listOf(data).map(normalizeItem).filter(Boolean);
  }

  async best(categoryId, { limit = 20, minRemaining = 1 } = {}) {
    const data = await this.call('GET', `/products/bestcategories/${encodeURIComponent(categoryId)}`, { query: { limit, subId: this.subId }, kind: 'best', minRemaining });
    return listOf(data).map(normalizeItem).filter(Boolean);
  }

  /** 일반 쿠팡 링크 → 수익이 나는 파트너스 링크 */
  async deeplink(urls, { minRemaining = 1 } = {}) {
    const data = await this.call('POST', '/deeplink', { body: { coupangUrls: urls.slice(0, 20), subId: this.subId || undefined }, kind: 'deeplink', minRemaining });
    return listOf(data).map((x) => ({ originalUrl: x.originalUrl, shortenUrl: x.shortenUrl, landingUrl: x.landingUrl }));
  }
}

// ---------------- 데모(키가 없을 때) ----------------
const VARIANTS = ['베스트', '대용량', '실속형', '프리미엄', '1+1 기획', '무료배송', '로켓 특가', '세트', '리필', '미니'];
const GOLDBOX = ['무선 이어폰', '전동 칫솔', '에어프라이어', '캠핑 의자', '텀블러 600ml', '물티슈 100매 x 10팩', '고구마 3kg', '노트북 거치대', '수건 10장', '세탁세제 3L', '단백질 쉐이크', '보조배터리 20000mAh'];

function mockPrice(productId, base, t) {
  // 3시간마다 바뀌는 계단식 가격 + 가끔 특가
  const bucket = Math.floor(t / (3 * 3600 * 1000));
  const r = hash32(`${productId}:${bucket}`) / 0xffffffff;
  const wave = (r - 0.5) * 0.18 + (r > 0.93 ? -0.18 : 0);
  return Math.max(100, Math.round((base * (1 + wave)) / 10) * 10);
}

function mockItem(seed, name, t, idOverride = null) {
  const productId = idOverride || String(9000000000 + (hash32(seed) % 899999999));
  const base = 3000 + (hash32(`b:${seed}`) % 120) * 900;
  return {
    productId,
    name: `[데모] ${name}`,
    price: mockPrice(productId, base, t),
    image: null,
    url: idOverride ? `https://www.coupang.com/vp/products/${idOverride}` : `https://www.coupang.com/np/search?q=${encodeURIComponent(name)}`,
    isRocket: hash32(`r:${seed}`) % 3 !== 0,
    isFreeShipping: true,
    category: null,
    rank: null,
  };
}

export class MockPartners {
  constructor() { this.mock = true; this.budget = null; }
  async search(keyword, { hintProductId = null } = {}) {
    const t = Date.now();
    const label = String(keyword).trim() || '상품';
    return VARIANTS.map((v, i) => ({ ...mockItem(`${label}:${i}`, `${label} ${v}`, t, i === 0 ? hintProductId : null), rank: i + 1 }));
  }
  async goldbox() { const t = Date.now(); return GOLDBOX.map((n, i) => ({ ...mockItem(`gold:${n}`, n, t), rank: i + 1 })); }
  async best(categoryId) {
    const t = Date.now();
    const cat = (CATEGORIES.find(([id]) => id === String(categoryId)) || [null, '상품'])[1];
    return VARIANTS.map((v, i) => ({ ...mockItem(`best:${categoryId}:${i}`, `${cat} ${v}`, t), rank: i + 1 }));
  }
  async deeplink(urls) { return urls.map((u) => ({ originalUrl: u, shortenUrl: u, landingUrl: u })); }
}

export function makeApi(env) {
  return partnersConfigured(env) ? new PartnersApi(env) : new MockPartners();
}
