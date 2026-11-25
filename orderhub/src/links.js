'use strict';
// 주문 상품 링크: 마켓 판매 페이지 + (상품코드로 알 수 있으면) 공급처 상품 페이지
const { safeJson, str } = require('./util');

const enc = (v) => encodeURIComponent(str(v));

// 마켓별 판매 페이지 (마켓 상품번호로)
const MARKET = {
  // 채널상품번호 (스토어 주소를 몰라도 main 으로 열림)
  naver: (it) => (it.product_id ? `https://smartstore.naver.com/main/products/${enc(it.product_id)}` : ''),
  // 노출상품ID + 옵션ID
  coupang: (it, extra) => {
    const pid = str(extra.displayProductId);
    if (!pid) return '';
    const vid = str(extra.vendorItemId || it.product_id);
    return `https://www.coupang.com/vp/products/${enc(pid)}${vid ? `?vendorItemId=${enc(vid)}` : ''}`;
  },
  elevenst: (it) => (it.product_id ? `https://www.11st.co.kr/products/${enc(it.product_id)}` : ''),
  gmarket: (it) => (it.product_id ? `https://item.gmarket.co.kr/Item?goodscode=${enc(it.product_id)}` : ''),
  auction: (it) => (it.product_id ? `https://itempage3.auction.co.kr/DetailView.aspx?itemno=${enc(it.product_id)}` : ''),
  lotteon: (it, extra) => {
    const spd = str(extra.spdNo || it.product_id);
    return spd ? `https://www.lotteon.com/p/product/${enc(spd)}` : '';
  },
};

// 상품코드(판매자 관리코드)로 알 수 있는 공급처 상품 페이지
const SUPPLIERS = [
  // 도매매 상품번호: dmm41674420 → domeme.domeggook.com/s/41674420
  { re: /^dmm[-_]?(\d{5,12})$/i, name: '도매매', url: (m) => `https://domeme.domeggook.com/s/${m[1]}` },
];

function supplierOf(code) {
  const c = str(code);
  for (const s of SUPPLIERS) {
    const m = c.match(s.re);
    if (m) return { name: s.name, url: s.url(m) };
  }
  return null;
}

// item: DB 행(order_items) - extra 는 JSON 문자열이어도 됨
function itemLinks(storeType, item) {
  const extra = typeof item.extra === 'string' ? safeJson(item.extra, {}) || {} : item.extra || {};
  const fn = MARKET[storeType];
  let productUrl = '';
  try {
    productUrl = fn ? fn(item, extra) : '';
  } catch {}
  const supplier = supplierOf(item.product_code);
  return { product_url: productUrl, supplier_name: supplier?.name || '', supplier_url: supplier?.url || '' };
}

module.exports = { itemLinks, supplierOf };
