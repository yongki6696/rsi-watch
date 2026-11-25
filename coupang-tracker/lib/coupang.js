// 쿠팡 링크 해석과 "빠른 요청(fetch)" 방식의 가격 추출.
// 쿠팡 페이지 구조는 예고 없이 바뀌므로 여러 방법을 차례로 시도한다.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 테스트 때 로컬 모의 서버로 바꿔 끼울 수 있게 환경변수로 연다.
export const COUPANG_ORIGIN = (process.env.CPT_COUPANG_ORIGIN || 'https://www.coupang.com').replace(/\/$/, '');
export const CART_URL = process.env.CPT_CART_URL || 'https://cart.coupang.com/cartView.pang';
export const LOGIN_URL = process.env.CPT_LOGIN_URL || 'https://login.coupang.com/login/login.pang';

const PRODUCT_PATH_RE = /\/v[pm]\/products\/(\d+)/;
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>]+/gi;

/**
 * 붙여넣은 글(앱 공유 문구 포함)에서 쿠팡 상품 정보를 찾는다.
 * @returns {{productId:string,itemId:string|null,vendorItemId:string|null}|{shortUrl:string}|null}
 */
export function parseCoupangInput(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/^\d{5,}$/.test(raw)) return { productId: raw, itemId: null, vendorItemId: null };
  const urls = raw.match(URL_IN_TEXT_RE) || (/coupang\.com/i.test(raw) ? [`https://${raw.replace(/^\/+/, '')}`] : []);
  for (const u of urls) {
    const parsed = parseProductUrl(u);
    if (parsed) return parsed;
  }
  for (const u of urls) {
    try {
      const url = new URL(u);
      if (/(^|\.)link\.coupang\.com$/i.test(url.hostname) || /(^|\.)coupa\.ng$/i.test(url.hostname)) {
        return { shortUrl: url.toString() };
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function parseProductUrl(u) {
  let url;
  try { url = new URL(u, COUPANG_ORIGIN); } catch { return null; }
  if (!/coupang\.com$/i.test(url.hostname) && url.origin !== COUPANG_ORIGIN) return null;
  const m = url.pathname.match(PRODUCT_PATH_RE);
  if (!m) return null;
  const num = (v) => (v && /^\d+$/.test(v) ? v : null);
  return {
    productId: m[1],
    itemId: num(url.searchParams.get('itemId')),
    vendorItemId: num(url.searchParams.get('vendorItemId')),
  };
}

export function productPageUrl({ productId, itemId, vendorItemId }) {
  const q = new URLSearchParams();
  if (itemId) q.set('itemId', itemId);
  if (vendorItemId) q.set('vendorItemId', vendorItemId);
  const qs = q.toString();
  return `${COUPANG_ORIGIN}/vp/products/${productId}${qs ? `?${qs}` : ''}`;
}

function browserHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    ...extra,
  };
}

/** link.coupang.com 같은 짧은 링크를 따라가 상품 주소를 얻는다. */
export async function resolveShortUrl(shortUrl, { timeoutMs = 15000 } = {}) {
  let current = shortUrl;
  for (let hop = 0; hop < 6; hop++) {
    const parsed = parseProductUrl(current);
    if (parsed) return parsed;
    const res = await fetch(current, {
      redirect: 'manual',
      headers: browserHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const loc = res.headers.get('location');
    if (loc) { current = new URL(loc, current).toString(); continue; }
    // 일부 짧은 링크는 HTML 안에서 이동시킨다
    const html = await res.text();
    const m = html.match(/https?:\/\/(?:www\.|m\.)?coupang\.com\/v[pm]\/products\/\d+[^"'\s<>]*/i);
    if (m) return parseProductUrl(m[0].replace(/&amp;/g, '&'));
    break;
  }
  return null;
}

export class BlockedError extends Error {
  constructor(message = '쿠팡이 자동 접속을 차단했어요.') {
    super(message);
    this.name = 'BlockedError';
    this.blocked = true;
  }
}

export function looksBlocked(status, html) {
  if (status === 403 || status === 429) return true;
  const head = String(html || '').slice(0, 5000);
  return /Access Denied|errors\.edgesuite\.net|Reference&#32;#|Request blocked|captcha/i.test(head);
}

const decodeEntities = (s) => String(s)
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

const stripTags = (s) => decodeEntities(String(s).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const toPrice = (v) => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n >= 10 && n < 1e9 ? Math.round(n) : null;
};

function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop.replace(/[.:]/g, '\\$&')}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]).trim() : null;
}

// 쿠팡 페이지 제목은 "상품명 - 카테고리 | 쿠팡" 꼴이다.
export function cleanTitle(t) {
  if (!t) return null;
  let s = String(t).replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.*?)\s*\|\s*쿠팡!?$/u);
  if (m) s = m[1].replace(/\s+-\s+[^-]{1,40}$/u, '');
  s = s.replace(/\s+-\s+쿠팡!?$/u, '');
  return s.trim() || null;
}

function fromJsonLd(html) {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const b of blocks) {
    const body = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let json;
    try { json = JSON.parse(body); } catch { continue; }
    const list = Array.isArray(json) ? json : json['@graph'] ? json['@graph'] : [json];
    for (const node of list) {
      if (!node || !/Product/i.test(String(node['@type']))) continue;
      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const price = toPrice(offers && (offers.price ?? offers.lowPrice));
      if (!price) continue;
      const avail = String((offers && offers.availability) || '');
      return {
        price,
        name: node.name || null,
        image: Array.isArray(node.image) ? node.image[0] : node.image || null,
        soldOut: /OutOfStock|SoldOut/i.test(avail) || undefined,
        strategy: 'json-ld',
      };
    }
  }
  return null;
}

// 쿠팡 상품 페이지에서 쓰였던(또는 쓰이는) 가격 영역 class 들. 앞에 있을수록 우선.
const PRICE_CLASSES = [
  'final-price-amount',
  'prod-sale-price',
  'prod-coupon-price',
  'total-price',
  'sale-price',
  'price-value',
];

function fromPriceClasses(html) {
  for (const cls of PRICE_CLASSES) {
    const re = new RegExp(`<[a-z0-9]+[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]{0,600}?)</(?:div|span|strong|em|p|dd|li)>`, 'gi');
    let m;
    while ((m = re.exec(html))) {
      const ctx = html.slice(Math.max(0, m.index - 200), m.index);
      if (/<(del|s|strike)\b[^>]*>[^<]*$/i.test(ctx)) continue;      // 취소선 가격 제외
      const text = stripTags(m[1] + html.slice(m.index + m[0].length, m.index + m[0].length + 80));
      const pm = text.match(/(\d{1,3}(?:,\d{3})+|\d{3,9})\s*원/);
      const price = toPrice(pm && pm[1]);
      if (price) return { price, strategy: `class:${cls}` };
    }
  }
  return null;
}

/** 서버가 받은 HTML 문자열에서 상품 정보와 가격을 뽑는다. */
export function extractFromHtml(html) {
  const out = {
    name: cleanTitle(metaContent(html, 'og:title')) || cleanTitle((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]),
    image: metaContent(html, 'og:image'),
    price: null,
    soldOut: false,
    strategy: null,
  };
  if (out.image && out.image.startsWith('//')) out.image = `https:${out.image}`;
  const ld = fromJsonLd(html);
  const metaPrice = toPrice(metaContent(html, 'product:price:amount') || metaContent(html, 'og:price:amount'));
  const cls = fromPriceClasses(html);
  const pick = ld || (metaPrice ? { price: metaPrice, strategy: 'meta' } : null) || cls;
  if (pick) {
    out.price = pick.price;
    out.strategy = pick.strategy;
    if (!out.name && pick.name) out.name = cleanTitle(pick.name);
    if (!out.image && pick.image) out.image = pick.image;
    if (pick.soldOut) out.soldOut = true;
  }
  if (!out.soldOut) {
    out.soldOut = /class=["'][^"']*\b(oos-label|out-of-stock|sold-?out)\b/i.test(html) || />\s*(일시\s*)?품절\s*</.test(html);
  }
  return out;
}

/** 빠른 요청으로 상품 페이지를 받아 가격을 뽑는다. 차단되면 BlockedError. */
export async function fetchProductInfo(product, { timeoutMs = 20000 } = {}) {
  const url = productPageUrl(product);
  const res = await fetch(url, {
    headers: browserHeaders({ Referer: `${COUPANG_ORIGIN}/` }),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await res.text();
  if (looksBlocked(res.status, html)) throw new BlockedError();
  if (res.status === 404) throw new Error('상품 페이지가 없어요 (판매 종료 또는 잘못된 링크).');
  if (!res.ok) throw new Error(`쿠팡 응답 오류 (HTTP ${res.status})`);
  const info = extractFromHtml(html);
  if (!info.price) throw new Error('페이지에서 가격을 찾지 못했어요.');
  return info;
}
