/*
 * 쿠팡 페이지(상품 상세 또는 장바구니) 안에서 실행되는 추출 함수.
 *  - 서버의 브라우저 자동화(Playwright page.evaluate)와
 *  - 사용자가 직접 누르는 북마클릿이 똑같이 이 함수를 쓴다.
 *
 * 주의: 이 함수는 문자열로 변환되어 한 줄짜리 북마클릿이 되므로
 *   1) 함수 밖의 변수를 쓰면 안 되고
 *   2) 줄 주석(슬래시 두 개)을 쓰면 안 되며, 모든 문장은 세미콜론으로 끝내고
 *   3) 퍼센트 기호와 샵 기호를 쓰지 않는다 (북마크 주소창에서 깨짐).
 *
 * 클래스 이름은 쿠팡이 자주 바꾸므로, 알려진 선택자를 먼저 시도하고
 * 실패하면 "화면에서 가장 크게 쓰인 가격 글자" 같은 일반 규칙으로 찾는다.
 */
export function extractPage() {
  var PRICE_RE = /(\d{1,3}(?:,\d{3})+|\d{3,9})\s*원/;
  var NUM_RE = /(\d{1,3}(?:,\d{3})+|\d{4,9})/;
  var ONLY_PRICE_RE = /^[\s₩]{0,2}(\d{1,3}(?:,\d{3})+|\d{3,9})\s*원[\s~)]{0,2}$/;
  var NOISE_RE = /배송|적립|할인|쿠폰|캐시|포인트|최대|절약|당\s*[\d,]+\s*원|단위|개당|이상\s*구매|합계|총\s*(상품|결제|주문)/;
  var PRODUCT_RE = /\/v[pm]\/products\/(\d+)/;
  var isCart = /cart/i.test(location.hostname + location.pathname);

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function toNum(s) {
    var t = norm(s);
    var m = t.match(PRICE_RE) || t.match(NUM_RE);
    if (!m) { return null; }
    var n = parseInt(m[1].replace(/,/g, ''), 10);
    return n >= 10 && n < 1000000000 ? n : null;
  }
  function parseHref(h) {
    var u;
    try { u = new URL(h, location.href); } catch (e) { return null; }
    var m = u.pathname.match(PRODUCT_RE);
    if (!m) { return null; }
    var it = u.searchParams.get('itemId') || '';
    var v = u.searchParams.get('vendorItemId') || '';
    return { productId: m[1], itemId: /^\d+$/.test(it) ? it : null, vendorItemId: /^\d+$/.test(v) ? v : null };
  }
  function keyOf(x) { return x.productId + '-' + (x.itemId || 0) + '-' + (x.vendorItemId || 0); }
  function css(el) { return window.getComputedStyle(el); }
  function struck(el) {
    for (var e = el; e && e.nodeType === 1 && e !== document.body; e = e.parentElement) {
      var tn = e.tagName;
      if (tn === 'DEL' || tn === 'S' || tn === 'STRIKE') { return true; }
      var td = String(css(e).textDecorationLine || css(e).textDecoration || '');
      if (td.indexOf('line-through') >= 0) { return true; }
    }
    return false;
  }
  function shown(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { return false; }
    var cs = css(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }
  function topOf(el) { return el.getBoundingClientRect().top + (window.scrollY || 0); }
  function fontSize(el) {
    var max = parseFloat(css(el).fontSize) || 0;
    var kids = el.getElementsByTagName('*');
    for (var i = 0; i < kids.length && i < 12; i++) {
      var f = parseFloat(css(kids[i]).fontSize) || 0;
      if (f > max) { max = f; }
    }
    return max;
  }
  function labelText(el) {
    var parts = [];
    var prev = el.previousElementSibling;
    if (prev) { parts.push(norm(prev.textContent).slice(-20)); }
    var par = el.parentElement;
    if (par) {
      var pt = norm(par.textContent);
      if (pt.length <= 30) { parts.push(pt); }
      var pprev = par.previousElementSibling;
      if (pprev && norm(pprev.textContent).length <= 20) { parts.push(norm(pprev.textContent)); }
    }
    return parts.join(' ');
  }
  function priceEls(root) {
    var out = [];
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var tn = el.tagName;
      if (tn === 'SCRIPT' || tn === 'STYLE' || tn === 'NOSCRIPT' || tn === 'OPTION' || tn === 'SELECT') { continue; }
      var raw = el.textContent;
      if (!raw || raw.length > 40) { continue; }
      var t = norm(raw);
      if (!ONLY_PRICE_RE.test(t)) { continue; }
      var inner = false;
      for (var j = 0; j < el.children.length; j++) {
        if (ONLY_PRICE_RE.test(norm(el.children[j].textContent))) { inner = true; break; }
      }
      if (inner) { continue; }
      if (NOISE_RE.test(labelText(el))) { continue; }
      if (!shown(el) || struck(el)) { continue; }
      out.push({ el: el, price: toNum(t), font: fontSize(el), top: topOf(el) });
    }
    return out;
  }
  function meta(p) {
    var m = document.querySelector('meta[property="' + p + '"]') || document.querySelector('meta[name="' + p + '"]');
    return m ? norm(m.getAttribute('content')) : '';
  }
  function cleanTitle(t) {
    var s = norm(t);
    var m = s.match(/^(.*?)\s*\|\s*쿠팡!?$/);
    if (m) { s = m[1].replace(/\s+-\s+[^-]{1,40}$/, ''); }
    return s.replace(/\s+-\s+쿠팡!?$/, '').trim();
  }
  function absUrl(s) {
    if (!s) { return null; }
    try { return new URL(s, location.href).href; } catch (e) { return null; }
  }
  function imgSrc(img) {
    if (!img) { return null; }
    return absUrl(img.currentSrc || img.getAttribute('data-src') || img.getAttribute('src'));
  }

  function productPage() {
    var info = parseHref(location.href);
    if (!info) { return []; }
    var price = null;
    var how = null;
    var sels = ['.final-price-amount', '.prod-sale-price .total-price', '.prod-coupon-price .total-price', '.total-price',
      '[class*="final-price"]', '[class*="sale-price"]', '[class*="salePrice"]', '.prod-price .price'];
    for (var i = 0; i < sels.length && !price; i++) {
      var els = document.querySelectorAll(sels[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!shown(el) || struck(el) || topOf(el) > 2200) { continue; }
        var n = toNum(el.textContent);
        if (n) { price = n; how = 'selector:' + sels[i]; break; }
      }
    }
    if (!price) {
      var cands = priceEls(document.body).filter(function (c) { return c.top < 1600; });
      cands.sort(function (a, b) { return (b.font - a.font) || (a.top - b.top); });
      if (cands.length) { price = cands[0].price; how = 'largest-price-text'; }
    }
    var name = cleanTitle(meta('og:title'));
    if (!name) {
      var h = document.querySelector('.prod-buy-header__title, [class*="product-title"], [class*="productTitle"], h1, h2');
      name = h ? norm(h.textContent) : cleanTitle(document.title);
    }
    var soldOut = false;
    var btns = document.querySelectorAll('button, a, .oos-label, [class*="sold-out"], [class*="soldout"], [class*="out-of-stock"]');
    for (var k = 0; k < btns.length; k++) {
      var b = btns[k];
      var bt = norm(b.textContent);
      if (bt.length > 12 || !/품절|구매\s*불가/.test(bt)) { continue; }
      if (shown(b) && topOf(b) < 1600) { soldOut = true; break; }
    }
    info.name = name ? name.slice(0, 300) : null;
    info.image = absUrl(meta('og:image')) || null;
    info.price = price;
    info.soldOut = soldOut;
    info.how = how;
    return [info];
  }

  function cartPage() {
    var groups = {};
    var order = [];
    var nodes = document.querySelectorAll('a[href*="/products/"], [data-product-id], [data-productid]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var info = n.tagName === 'A' ? parseHref(n.href) : null;
      if (!info) {
        var pid = n.getAttribute('data-product-id') || n.getAttribute('data-productid');
        if (!pid || !/^\d+$/.test(pid)) { continue; }
        var iid = n.getAttribute('data-item-id') || n.getAttribute('data-itemid') || '';
        var vid = n.getAttribute('data-vendor-item-id') || n.getAttribute('data-vendoritemid') || '';
        info = { productId: pid, itemId: /^\d+$/.test(iid) ? iid : null, vendorItemId: /^\d+$/.test(vid) ? vid : null };
      }
      var key = keyOf(info);
      if (!groups[key]) { groups[key] = { info: info, nodes: [] }; order.push(key); }
      groups[key].nodes.push(n);
    }
    function hasOther(el, key) {
      for (var g = 0; g < order.length; g++) {
        if (order[g] === key) { continue; }
        var ns = groups[order[g]].nodes;
        for (var q = 0; q < ns.length; q++) { if (el.contains(ns[q])) { return true; } }
      }
      return false;
    }
    var items = [];
    for (var o = 0; o < order.length; o++) {
      var key2 = order[o];
      var grp = groups[key2];
      var container = null;
      var priceLevel = 0;
      for (var e = grp.nodes[0].parentElement; e && e !== document.body; e = e.parentElement) {
        if (hasOther(e, key2)) { break; }
        container = e;
        if (!priceLevel && priceEls(e).length) { priceLevel = 1; continue; }
        if (priceLevel) { priceLevel++; if (priceLevel > 3 || norm(e.textContent).length > 1500) { break; } }
      }
      if (!container) { continue; }
      var cands = priceEls(container);
      var qty = 1;
      var qi = container.querySelector('input[type="number"], input[name*="qty" i], input[name*="quantity" i], input[class*="quantity"], select');
      if (qi && /^\d+$/.test(String(qi.value))) { qty = parseInt(qi.value, 10) || 1; }
      var qm = norm(container.textContent).match(/수량\s*:?\s*(\d+)/);
      if (qty === 1 && qm) { qty = parseInt(qm[1], 10) || 1; }
      var price = null;
      if (qty > 1) {
        for (var c1 = 0; c1 < cands.length && !price; c1++) {
          for (var c2 = 0; c2 < cands.length; c2++) {
            if (c1 !== c2 && cands[c2].price === cands[c1].price * qty) { price = cands[c1].price; break; }
          }
        }
      }
      if (!price && cands.length) {
        cands.sort(function (a, b) { return (b.font - a.font) || (a.top - b.top); });
        price = cands[0].price;
      }
      var name = '';
      for (var a = 0; a < grp.nodes.length; a++) {
        var t = norm(grp.nodes[a].textContent);
        if (t.length > name.length && t.length < 300 && !PRICE_RE.test(t)) { name = t; }
      }
      var img = container.querySelector('img');
      if (!name && img) { name = norm(img.getAttribute('alt')); }
      var ctext = norm(container.textContent);
      var hasControl = Boolean(container.querySelector('input[type="checkbox"], input[type="number"], select, button[class*="quantity"], [class*="quantity"], [class*="count"]')) || /수량/.test(ctext);
      items.push({
        productId: grp.info.productId,
        itemId: grp.info.itemId,
        vendorItemId: grp.info.vendorItemId,
        name: name ? name.slice(0, 300) : null,
        image: imgSrc(img),
        price: price,
        qty: qty,
        soldOut: /품절|구매\s*불가|판매\s*종료/.test(ctext),
        control: hasControl
      });
    }
    var withControl = items.filter(function (x) { return x.control; });
    if (withControl.length) { items = withControl; }
    return items.map(function (x) { delete x.control; return x; });
  }

  var list = isCart ? cartPage() : productPage();
  return { v: 1, kind: isCart ? 'cart' : 'product', page: location.href, at: Date.now(), items: list };
}

/** 북마클릿 코드(한 줄). origin 은 가격 추적기 주소 (예: http://192.168.0.10:3000). */
export function buildBookmarklet(origin) {
  const src = extractPage.toString()
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s*\n\s*/g, ' ');
  const safeOrigin = JSON.stringify(String(origin).replace(/\/$/, ''));
  const code = `(function(){try{if(!/coupang\\.com$/.test(location.hostname)){alert('쿠팡 상품 페이지나 장바구니에서 눌러주세요.');return;}`
    + `var r=(${src})();`
    + `if(!r.items.length){alert('이 페이지에서 상품을 찾지 못했어요. 상품 상세 페이지나 장바구니에서 눌러주세요.');return;}`
    + `var u=${safeOrigin}+'/'+String.fromCharCode(35)+'import='+encodeURIComponent(JSON.stringify(r));`
    + `var w=window.open(u,'_blank');if(!w){location.href=u;}`
    + `}catch(e){alert('가격 추적기 오류: '+e.message);}})();`;
  if (/[%#]/.test(code)) throw new Error('bookmarklet must not contain % or #');
  return `javascript:${code}`;
}
