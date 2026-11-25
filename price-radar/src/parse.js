// 사용자가 붙여넣은 글(쿠팡 앱 공유 문구, 링크, 상품명)을 해석한다.

const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const PRODUCT_RE = /\/v[pm]\/products\/(\d+)/;

const digits = (v) => (v && /^\d+$/.test(v) ? v : null);

export function parseProductUrl(u) {
  let url;
  try { url = new URL(u); } catch { return null; }
  if (!/(^|\.)coupang\.com$/i.test(url.hostname)) return null;
  const m = url.pathname.match(PRODUCT_RE);
  if (!m) return null;
  return {
    productId: m[1],
    itemId: digits(url.searchParams.get('itemId')),
    vendorItemId: digits(url.searchParams.get('vendorItemId')),
    url: `https://www.coupang.com/vp/products/${m[1]}`,
  };
}

export function isShortLink(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'link.coupang.com' || h === 'coupa.ng' || h.endsWith('.coupa.ng');
  } catch { return false; }
}

// 공유 문구에 자주 붙는 군더더기
const NOISE = [
  /쿠팡을\s*추천합니다!?/g,
  /쿠팡에서\s*(확인|구매)해\s*보세요!?/g,
  /지금\s*쿠팡에서\s*확인하세요!?/g,
  /^\s*\[?쿠팡\]?\s*/g,
  /이 포스팅은[^\n]*수수료를 제공받습니다\.?/g,
];

export function cleanName(text) {
  let s = String(text || '');
  for (const re of NOISE) s = s.replace(re, ' ');
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^[-:·|,\s]+|[-:·|,\s]+$/g, '');
  return s.slice(0, 80) || null;
}

/**
 * @returns {{productId:string|null, shortUrl:string|null, url:string|null, name:string|null}}
 */
export function parseInput(text) {
  const raw = String(text || '').trim().slice(0, 1000);
  const out = { productId: null, shortUrl: null, url: null, name: null };
  if (!raw) return out;
  const urls = raw.match(URL_RE) || [];
  for (const u of urls) {
    const p = parseProductUrl(u.replace(/[)\].,]+$/, ''));
    if (p) { out.productId = p.productId; out.url = p.url; break; }
  }
  if (!out.productId) {
    const short = urls.find((u) => isShortLink(u));
    if (short) out.shortUrl = short.replace(/[)\].,]+$/, '');
  }
  if (!urls.length && /^\d{6,}$/.test(raw)) { out.productId = raw; out.url = `https://www.coupang.com/vp/products/${raw}`; return out; }
  out.name = cleanName(raw.replace(URL_RE, ' '));
  return out;
}

/** 같은 검색어를 하나로 묶기 위한 정규화 (공유 캐시 키) */
export function normalizeKeyword(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 50);
}

/** 긴 상품명을 검색에 알맞은 길이로 줄인다 */
export function keywordFromName(name) {
  const s = String(name || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s.+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = s.split(' ');
  let out = '';
  for (const w of words) {
    if ((out + ' ' + w).trim().length > 40) break;
    out = (out + ' ' + w).trim();
  }
  return out || s.slice(0, 40);
}
