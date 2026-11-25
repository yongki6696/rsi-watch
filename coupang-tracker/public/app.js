/* 장바구니 시세 — 화면 */
const LWC = window.LightweightCharts;
const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;

const S = {
  products: new Map(),
  settings: null,
  status: null,
  browser: null,
  demo: false,
  skew: 0,
  connected: false,
  everConnected: false,
  filter: pref('filter', 'all'),
  sort: pref('sort', 'recent'),
  range: pref('range', '1M'),
  ctype: pref('ctype', 'area'),
  flash: new Map(),
};

// ---------- 작은 도우미 ----------
function pref(k, d) { try { return localStorage.getItem(`cpt.${k}`) || d; } catch { return d; } }
function setPref(k, v) { try { localStorage.setItem(`cpt.${k}`, v); } catch { /* 저장 불가 */ } }
const $ = (sel, root = document) => root.querySelector(sel);
const now = () => Date.now() - S.skew;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const real = (kids) => kids.flat().filter((k) => k !== null && k !== undefined && k !== false);
const fill = (el, ...kids) => el.replaceChildren(...real(kids));
const add = (el, ...kids) => el.append(...real(kids));
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

const nf = new Intl.NumberFormat('ko-KR');
const won = (n) => (n === null || n === undefined ? '–' : `${nf.format(Math.round(n))}원`);
const dir = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const arrow = (n) => (n > 0 ? '▲' : n < 0 ? '▼' : '');
const absWon = (n) => nf.format(Math.abs(Math.round(n)));
const pctStr = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}%`;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n) => String(n).padStart(2, '0');

function fmtDate(t, { time = true, year = false } = {}) {
  const d = new Date(t);
  const y = year || d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}. ` : '';
  return `${y}${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})${time ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''}`;
}
function fmtShort(t) {
  const d = new Date(t);
  const today = new Date(now());
  if (d.toDateString() === today.toDateString()) return `오늘 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function ago(t) {
  if (!t) return '–';
  const s = Math.max(0, Math.round((now() - t) / 1000));
  if (s < 45) return '방금';
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}일 전`;
  return fmtDate(t, { time: false });
}
function until(t) {
  const s = Math.max(0, Math.round((t - now()) / 1000));
  if (s < 60) return `${s}초 후`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${pad(s % 60)}초 후`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분 후`;
}
const SOURCE = { fetch: '자동 확인', browser: '자동 확인(브라우저)', cart: '장바구니', page: '상품 페이지', manual: '직접 입력', demo: '데모' };

function toast(text, { tag = null, tagClass = '', onclick = null, ms = 4500 } = {}) {
  const el = h('div', { class: 'toast', role: 'status' }, tag && h('span', { class: `tag ${tagClass}`, text: tag }), h('span', { text }));
  if (onclick) el.addEventListener('click', () => { onclick(); el.remove(); });
  else el.addEventListener('click', () => el.remove());
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) throw new Error((data && data.error) || `요청 실패 (${res.status})`);
  return data;
}

// ---------- 가격 계산 ----------
function priceAt(hist, t) {
  let v = null;
  for (const pt of hist) { if (pt.t <= t) v = pt.p; else break; }
  return v;
}
function lastSeen(p) {
  const h = p.history;
  return Math.max(p.lastCheckedAt || 0, h.length ? h[h.length - 1].t : 0);
}
function dayChange(p) {
  const h = p.history;
  if (!h.length || h[0].t > now() - DAY) return null;
  const before = priceAt(h, now() - DAY);
  return before === null ? null : p.price - before;
}

// ---------- 상태 줄 ----------
function renderStatus() {
  const el = $('#status-line');
  const st = S.status;
  $('#live-dot').classList.toggle('on', S.connected);
  el.replaceChildren();
  if (!S.connected) {
    el.append(h('span', { text: S.everConnected ? '서버 연결이 끊겼어요 — 다시 연결하는 중…' : '서버에 연결하는 중…' }));
    return;
  }
  if (!st) return;
  if (st.running) {
    const total = st.total || 0;
    add(el,
      h('b', { text: '가격 확인 중' }),
      total ? h('span', { text: `${Math.min(st.done + 1, total)}/${total}` }) : null,
      h('div', { class: 'progress', 'aria-hidden': 'true' }, h('i', { style: `width:${total ? Math.round((st.done / total) * 100) : 30}%` })),
      st.current ? h('span', { text: String(st.current).slice(0, 28) }) : null,
    );
  } else {
    if (st.nextRunAt) {
      const d = new Date(st.nextRunAt);
      el.append(h('span', null, '다음 확인 ', h('b', { text: `${pad(d.getHours())}:${pad(d.getMinutes())}` }), ` (${until(st.nextRunAt)})`));
    }
    if (st.lastRunAt) el.append(h('span', { text: `· 마지막 확인 ${ago(st.lastRunAt)}` }));
  }
  if (st.fetchBlocked && S.settings && S.settings.fetchMode === 'auto') el.append(h('span', { class: 'badge', text: '브라우저로 확인 중', title: '빠른 요청이 차단되어 브라우저로 확인해요' }));
  if (st.cart && st.cart.error && S.settings && S.settings.cartSync) el.append(h('span', { class: 'badge err', text: `장바구니: ${st.cart.error}` }));
  const btn = $('#btn-check');
  btn.disabled = Boolean(st.running);
  btn.querySelector('svg').classList.toggle('spin', Boolean(st.running));
}

// ---------- 목록 ----------
const FILTERS = [
  ['all', '전체', () => true],
  ['cart', '장바구니', (p) => p.inCart],
  ['down', '내림', (p) => p.change < 0],
  ['up', '오름', (p) => p.change > 0],
  ['low', '역대 최저', (p) => isAtLow(p)],
  ['target', '목표가 도달', (p) => p.atTarget],
  ['err', '확인 실패', (p) => Boolean(p.lastError)],
];
const SORTS = [
  ['recent', '최근 변동순', (a, b) => (b.changedAt || b.addedAt) - (a.changedAt || a.addedAt)],
  ['drop', '많이 내린 순', (a, b) => a.changePct - b.changePct],
  ['rise', '많이 오른 순', (a, b) => b.changePct - a.changePct],
  ['nearlow', '최저가에 가까운 순', (a, b) => fromLow(a) - fromLow(b)],
  ['price', '가격 높은 순', (a, b) => (b.price || 0) - (a.price || 0)],
  ['name', '이름순', (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko')],
];
function isAtLow(p) { return p.price !== null && p.minPrice !== null && p.price === p.minPrice && p.maxPrice !== p.minPrice; }
function fromLow(p) { return p.price && p.minPrice ? (p.price - p.minPrice) / p.minPrice : Infinity; }

function renderSummary() {
  const all = [...S.products.values()];
  const cart = all.filter((p) => p.inCart && p.price);
  const base = cart.length ? cart : all.filter((p) => p.price);
  const total = base.reduce((s, p) => s + p.price, 0);
  let dayDiff = 0; let dayN = 0; let downs = 0; let ups = 0;
  for (const p of all) {
    const d = dayChange(p);
    if (d === null) continue;
    if (d < 0) downs++; else if (d > 0) ups++;
    if (base.includes(p)) { dayDiff += d; dayN++; }
  }
  const tile = (label, value, sub) => h('div', { class: 'card tile' }, h('div', { class: 'tile-label', text: label }), h('div', { class: 'tile-value' }, value), h('div', { class: 'tile-sub' }, sub));
  const diffSub = dayN
    ? h('span', null, '어제보다 ', h('span', { class: dir(dayDiff), text: dayDiff ? `${arrow(dayDiff)} ${absWon(dayDiff)}원` : '변동 없음' }))
    : h('span', { text: `${base.length}개 상품` });
  $('#summary').replaceChildren(
    tile(cart.length ? '장바구니 합계' : '추적 상품 합계', won(total), diffSub),
    tile('24시간 동안 내림', h('span', null, h('span', { class: 'down', text: '▼ ' }), `${downs}개`), h('span', { text: '하루 전 가격 대비' })),
    tile('24시간 동안 오름', h('span', null, h('span', { class: 'up', text: '▲ ' }), `${ups}개`), h('span', { text: `추적 ${all.length}개 중` })),
  );
}

function renderFilters() {
  const all = [...S.products.values()];
  const box = $('#filters');
  box.replaceChildren(
    ...FILTERS.filter(([k, , fn]) => k === 'all' || k === S.filter || all.some(fn)).map(([k, label, fn]) => h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(S.filter === k),
      onclick: () => { S.filter = k; setPref('filter', k); renderList(); renderFilters(); },
    }, label, h('span', { class: 'n', text: String(all.filter(fn).length) }))),
    h('select', {
      class: 'sort', 'aria-label': '정렬',
      onchange: (e) => { S.sort = e.target.value; setPref('sort', S.sort); renderList(); },
    }, ...SORTS.map(([k, label]) => { const o = h('option', { value: k, text: label }); if (k === S.sort) o.selected = true; return o; })),
  );
}

function thumb(p) {
  const box = h('div', { class: 'thumb', 'aria-hidden': 'true' });
  if (p.image) {
    const img = h('img', { src: p.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => { img.remove(); box.append(h('span', { class: 'ini', text: (p.name || '?').replace(/^\[.*?\]\s*/, '').slice(0, 1) })); });
    box.append(img);
  } else if (p.emoji) {
    box.textContent = p.emoji;
  } else {
    box.append(h('span', { class: 'ini', text: (p.name || '?').replace(/^\[.*?\]\s*/, '').slice(0, 1) }));
  }
  return box;
}

function sparkline(p, days = 30) {
  const W = 88; const H = 36; const P = 3;
  const svg = svgEl('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
  const hist = p.history;
  if (!hist.length) return svg;
  const end = Math.max(lastSeen(p), now());
  const start = Math.max(hist[0].t, end - days * DAY);
  const pts = [{ t: start, p: priceAt(hist, start) ?? hist[0].p }];
  for (const pt of hist) if (pt.t > start) pts.push(pt);
  pts.push({ t: end, p: pts[pts.length - 1].p });
  let lo = Infinity; let hi = -Infinity;
  for (const pt of pts) { lo = Math.min(lo, pt.p); hi = Math.max(hi, pt.p); }
  const x = (t) => P + ((t - start) / Math.max(1, end - start)) * (W - 2 * P);
  const y = (v) => (hi === lo ? H / 2 : P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P));
  let d = `M${x(pts[0].t).toFixed(1)} ${y(pts[0].p).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t).toFixed(1)} V${y(pts[i].p).toFixed(1)}`;
  const delta = pts[pts.length - 1].p - pts[0].p;
  const color = delta > 0 ? 'var(--up)' : delta < 0 ? 'var(--down)' : 'var(--flat)';
  svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': '1.75', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  svg.append(svgEl('circle', { cx: x(end).toFixed(1), cy: y(pts[pts.length - 1].p).toFixed(1), r: '2.5', fill: color }));
  return svg;
}

function changeEl(p, cls = 'chg') {
  if (p.price === null) return h('div', { class: `${cls} flat`, text: '확인 전' });
  if (!p.prevPrice) return h('div', { class: `${cls} flat`, text: '변동 없음' });
  return h('div', { class: `${cls} ${dir(p.change)}` },
    h('span', { class: `chg-pill ${dir(p.change)}` }, `${arrow(p.change)} ${absWon(p.change)} (${pctStr(p.changePct)})`));
}

function rowEl(p) {
  const badges = [];
  if (p.inCart) badges.push(h('span', { class: 'badge', text: '장바구니' }));
  if (p.atTarget) badges.push(h('span', { class: 'badge target', text: '목표가 도달' }));
  if (isAtLow(p)) badges.push(h('span', { class: 'badge low', text: '역대 최저' }));
  if (p.soldOut) badges.push(h('span', { class: 'badge', text: '품절' }));
  const sub = p.lastError
    ? h('span', { class: 'badge err', text: `⚠ ${p.lastError}` })
    : h('span', { text: p.changedAt ? `${ago(p.changedAt)} 변동` : p.price !== null ? `${ago(lastSeen(p))} 확인` : '가격 확인 대기 중' });
  const row = h('a', { class: 'row', href: `#/p/${encodeURIComponent(p.id)}`, 'data-id': p.id },
    thumb(p),
    h('div', { style: 'min-width:0' }, h('div', { class: 'name', text: p.name || `상품 ${p.productId}` }), h('div', { class: 'meta' }, ...badges, sub)),
    sparkline(p),
    h('div', { class: 'px' }, h('div', { class: 'px-now', text: won(p.price) }), changeEl(p)),
  );
  const f = S.flash.get(p.id);
  if (f && Date.now() - f.at < 1500) row.classList.add(`flash-${f.dir}`);
  return row;
}

function renderList() {
  const list = $('#list');
  const all = [...S.products.values()];
  if (!all.length) {
    list.replaceChildren(h('div', { class: 'empty' },
      h('h3', { text: '아직 추적 중인 상품이 없어요' }),
      h('p', { text: '쿠팡 상품 링크를 붙여넣거나, 장바구니를 통째로 가져와 보세요.' }),
      h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', text: '🛒 장바구니 가져오기', onclick: openImport }),
        h('button', { class: 'btn ghost', type: 'button', text: '링크 붙여넣기', onclick: () => $('#add-input').focus() })),
    ));
    return;
  }
  const fn = (FILTERS.find(([k]) => k === S.filter) || FILTERS[0])[2];
  const sorter = (SORTS.find(([k]) => k === S.sort) || SORTS[0])[2];
  const rows = all.filter(fn).sort(sorter);
  if (!rows.length) {
    list.replaceChildren(h('div', { class: 'empty' }, h('p', { text: '조건에 맞는 상품이 없어요.' })));
    return;
  }
  list.replaceChildren(...rows.map(rowEl));
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderSummary();
    renderFilters();
    renderList();
    if (detail.id) updateDetail();
  });
}

// ---------- 상세 & 차트 ----------
const RANGES = [['1D', '1일', DAY], ['1W', '1주', 7 * DAY], ['1M', '1개월', 30 * DAY], ['3M', '3개월', 90 * DAY], ['ALL', '전체', null]];
const detail = { id: null, chart: null, series: null, els: null, targetLine: null, hovering: false, histLimit: 20 };

const tzShift = (t) => Math.floor(t / 1000) - new Date(t).getTimezoneOffset() * 60; // 차트는 UTC로 그리므로 현지 시각으로 밀어준다
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function rgba(hex, a) {
  const m = hex.replace('#', '');
  const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function rangeBounds(p) {
  const hist = p.history;
  const end = Math.max(lastSeen(p), now());
  if (!hist.length) return { start: end, end };
  const span = (RANGES.find(([k]) => k === S.range) || RANGES[2])[2];
  const start = span ? Math.max(hist[0].t, end - span) : hist[0].t;
  return { start, end };
}
const STEPS = [10 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
function stepFor(span, target) { return STEPS.find((s) => span / s <= target) || STEPS[STEPS.length - 1]; }

/**
 * 차트용 데이터. lightweight-charts 는 점 사이 간격을 시간과 무관하게 똑같이 그리므로,
 * 가격이 바뀐 시점만 있는 기록을 일정한 간격으로 다시 나눠 시간 축이 왜곡되지 않게 한다.
 */
function buildSeries(p) {
  const { start, end } = rangeBounds(p);
  const hist = p.history;
  if (!hist.length || end <= start) return { line: [], candles: [], start, end, min: null, max: null, avg: null };
  const off = (t) => t - new Date(t).getTimezoneOffset() * MIN; // 현지 시각 기준으로 칸을 맞춘다
  const inRange = [{ t: start, p: priceAt(hist, start) ?? hist[0].p }];
  for (const pt of hist) if (pt.t > start && pt.t <= end) inRange.push(pt);
  let min = inRange[0]; let max = inRange[0];
  for (const pt of inRange) { if (pt.p < min.p) min = pt; if (pt.p > max.p) max = pt; }

  // 라인: 일정 간격 표본 + 구간 안에서 최저/최고가가 있었다면 놓치지 않게 반영
  const span = end - start;
  const step = stepFor(span, 300);
  const line = [];
  const push = (t, v) => { const time = tzShift(t); if (line.length && line[line.length - 1].time >= time) line[line.length - 1].value = v; else line.push({ time, value: v }); };
  push(start, inRange[0].p);
  let i = 1; let cur = inRange[0].p;
  const firstGrid = Math.ceil(off(start) / step) * step - (off(start) - start);
  for (let g = firstGrid; g < end + step; g += step) {
    const t = Math.min(g, end);
    let v = null;
    while (i < inRange.length && inRange[i].t <= t) {
      cur = inRange[i].p;
      if (cur === min.p || cur === max.p) v = cur;
      i++;
    }
    push(t, v ?? cur);
    if (t === end) break;
  }

  // 캔들: 기간에 맞는 칸(1시간~1주) 단위 시가/고가/저가/종가
  const cstep = S.range === '1D' ? HOUR : S.range === '1W' ? 6 * HOUR : span > 400 * DAY ? 7 * DAY : DAY;
  const candles = [];
  let j = 0; let last = null;
  const b0 = Math.floor(off(start) / cstep) * cstep - (off(start) - start);
  for (let b = b0; b <= end; b += cstep) {
    const bEnd = b + cstep;
    let o = last; let hi = last; let lo = last; let c = last;
    while (j < inRange.length && inRange[j].t < bEnd) {
      const v = inRange[j].p;
      if (o === null) { o = v; hi = v; lo = v; }
      hi = Math.max(hi, v); lo = Math.min(lo, v); c = v; last = v; j++;
    }
    if (o === null) continue;
    candles.push({ time: tzShift(Math.max(b, start)), open: o, high: hi, low: lo, close: c });
  }
  // 같은 시각이 겹치면 합친다
  const merged = [];
  for (const c of candles) {
    const prev = merged[merged.length - 1];
    if (prev && prev.time >= c.time) { prev.high = Math.max(prev.high, c.high); prev.low = Math.min(prev.low, c.low); prev.close = c.close; } else merged.push(c);
  }

  // 시간 가중 평균
  let area = 0;
  for (let k = 0; k < inRange.length; k++) {
    const t0 = inRange[k].t; const t1 = k + 1 < inRange.length ? inRange[k + 1].t : end;
    area += inRange[k].p * Math.max(0, t1 - t0);
  }
  return { line, candles: merged, start, end, min, max, avg: span > 0 ? area / span : inRange[0].p, first: inRange[0].p, lastP: inRange[inRange.length - 1].p };
}

function createChart(el) {
  const text2 = cssVar('--text-2');
  const chart = LWC.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: cssVar('--surface') }, textColor: text2, fontSize: 11, fontFamily: cssVar('--font') },
    grid: { vertLines: { visible: false }, horzLines: { color: cssVar('--grid') } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.12 } },
    timeScale: {
      borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true,
      tickMarkFormatter: (time, type) => {
        const d = new Date(time * 1000);
        if (type === 0) return `${d.getUTCFullYear()}년`;
        if (type === 1) return `${d.getUTCMonth() + 1}월`;
        if (type === 2) return `${d.getUTCMonth() + 1}.${d.getUTCDate()}`;
        return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      },
    },
    crosshair: {
      mode: LWC.CrosshairMode.Magnet,
      vertLine: { color: cssVar('--text-3'), width: 1, style: LWC.LineStyle.Solid, labelBackgroundColor: cssVar('--btn') },
      horzLine: { color: cssVar('--text-3'), width: 1, style: LWC.LineStyle.Solid, labelBackgroundColor: cssVar('--btn') },
    },
    localization: {
      locale: 'ko-KR',
      priceFormatter: (v) => nf.format(Math.round(v)),
      timeFormatter: (time) => {
        const d = new Date(time * 1000);
        return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      },
    },
    handleScroll: { vertTouchDrag: false },
  });
  chart.subscribeCrosshairMove(onCrosshair);
  return chart;
}

function ensureSeries() {
  const { chart } = detail;
  const want = S.ctype;
  if (detail.series && detail.seriesType === want) return;
  if (detail.series) { chart.removeSeries(detail.series); detail.series = null; detail.targetLine = null; }
  // 가격이 한 번도 안 바뀐 구간이면 눈금이 같은 숫자로 도배되지 않게 위아래 여유를 준다
  const autoscaleInfoProvider = (original) => {
    const r = original();
    if (r && r.priceRange && r.priceRange.maxValue - r.priceRange.minValue < 1) {
      const v = r.priceRange.minValue;
      return { ...r, priceRange: { minValue: v * 0.95, maxValue: v * 1.05 } };
    }
    return r;
  };
  if (want === 'candle') {
    detail.series = chart.addCandlestickSeries({
      upColor: cssVar('--up'), downColor: cssVar('--down'), wickUpColor: cssVar('--up'), wickDownColor: cssVar('--down'),
      borderVisible: false, priceLineVisible: true, priceLineStyle: LWC.LineStyle.Solid, priceLineWidth: 1, autoscaleInfoProvider,
    });
  } else {
    detail.series = chart.addAreaSeries({
      lineWidth: 2, lineType: LWC.LineType.WithSteps, priceLineVisible: true, priceLineStyle: LWC.LineStyle.Solid, priceLineWidth: 1,
      crosshairMarkerRadius: 4, crosshairMarkerBorderColor: cssVar('--surface'), crosshairMarkerBorderWidth: 2, autoscaleInfoProvider,
    });
  }
  detail.seriesType = want;
}

function setChartData(fit) {
  const p = S.products.get(detail.id);
  if (!p || !detail.chart) return;
  ensureSeries();
  const data = buildSeries(p);
  detail.data = data;
  const emptyEl = detail.els.chartEmpty;
  const tooShort = !p.history.length || data.end - p.history[0].t < 30 * MIN;
  emptyEl.hidden = !tooShort;
  emptyEl.textContent = p.history.length
    ? `첫 가격 ${won(p.history[0].p)}을 기록했어요. 다음 확인부터 변동이 차트에 쌓여요.`
    : '아직 기록된 가격이 없어요. 첫 확인을 기다리는 중…';
  if (tooShort) { data.line = []; data.candles = []; }
  const trend = data.lastP !== undefined ? data.lastP - data.first : 0;
  const color = trend > 0 ? cssVar('--up') : trend < 0 ? cssVar('--down') : cssVar('--text-2');
  if (detail.seriesType === 'candle') {
    const flat = cssVar('--flat');
    detail.series.setData(data.candles.map((c) => (c.open === c.close ? { ...c, color: flat, wickColor: flat } : c)));
    detail.series.setMarkers([]);
  } else {
    detail.series.applyOptions({ lineColor: color, topColor: rgba(color.startsWith('#') ? color : '#8b8f96', 0.22), bottomColor: rgba(color.startsWith('#') ? color : '#8b8f96', 0.0), priceLineColor: color });
    detail.series.setData(data.line);
    const marks = [];
    if (data.line.length > 1 && data.min && data.max && data.min.p !== data.max.p) {
      const near = (t) => { let best = data.line[0]; const tt = tzShift(t); for (const pt of data.line) { if (pt.time <= tt) best = pt; else break; } return best ? best.time : tt; };
      const findT = (target, from) => { const tt = tzShift(from); for (const pt of data.line) if (pt.time >= tt && pt.value === target) return pt.time; return near(from); };
      const t0 = data.line[0].time; const t1 = data.line[data.line.length - 1].time;
      const inside = (t) => (t - t0) / Math.max(1, t1 - t0) > 0.05 && (t - t0) / Math.max(1, t1 - t0) < 0.93; // 가장자리 글자는 잘리므로 생략
      const tMin = findT(data.min.p, data.min.t); const tMax = findT(data.max.p, data.max.t);
      if (inside(tMin)) marks.push({ time: tMin, position: 'belowBar', color: cssVar('--text-2'), shape: 'arrowUp', text: `최저 ${nf.format(data.min.p)}` });
      if (inside(tMax)) marks.push({ time: tMax, position: 'aboveBar', color: cssVar('--text-2'), shape: 'arrowDown', text: `최고 ${nf.format(data.max.p)}` });
      marks.sort((a, b) => a.time - b.time);
    }
    detail.series.setMarkers(marks);
  }
  if (detail.targetLine) { detail.series.removePriceLine(detail.targetLine); detail.targetLine = null; }
  if (p.targetPrice) {
    detail.targetLine = detail.series.createPriceLine({ price: p.targetPrice, color: cssVar('--text-2'), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: '목표가' });
  }
  if (fit) detail.chart.timeScale().fitContent();
}

function onCrosshair(param) {
  const p = S.products.get(detail.id);
  if (!p || !detail.els) return;
  const d = param && param.time !== undefined && detail.series ? param.seriesData.get(detail.series) : null;
  if (!d || !param.point || param.point.x < 0) { detail.hovering = false; renderHero(p); return; }
  detail.hovering = true;
  const v = d.value !== undefined ? d.value : d.close;
  const { heroPrice, heroChg, heroWhen } = detail.els;
  heroPrice.textContent = won(v);
  const diff = v - p.price;
  heroChg.className = `hero-chg ${dir(diff)}`;
  heroChg.textContent = diff === 0 ? '지금과 같은 가격' : `지금보다 ${absWon(diff)}원 ${diff > 0 ? '비쌌어요' : '쌌어요'} (${arrow(diff)} ${pctStr((diff / p.price) * 100)})`;
  const t = new Date(param.time * 1000);
  const when = `${t.getUTCMonth() + 1}월 ${t.getUTCDate()}일 ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  heroWhen.textContent = d.close !== undefined ? `${when} · 시작 ${nf.format(d.open)} · 고 ${nf.format(d.high)} · 저 ${nf.format(d.low)}` : `${when} 기준`;
}

function renderHero(p) {
  const { heroPrice, heroChg, heroWhen } = detail.els;
  heroPrice.textContent = won(p.price);
  if (p.price === null) { heroChg.className = 'hero-chg flat'; heroChg.textContent = '가격 확인 전'; } else if (!p.prevPrice) { heroChg.className = 'hero-chg flat'; heroChg.textContent = '아직 가격 변동이 없어요'; } else {
    heroChg.className = `hero-chg ${dir(p.change)}`;
    heroChg.textContent = `${arrow(p.change)} ${absWon(p.change)}원 (${pctStr(p.changePct)}) 직전 가격 대비`;
  }
  heroWhen.textContent = [p.changedAt ? `${ago(p.changedAt)} 변동` : null, p.lastCheckedAt ? `${ago(p.lastCheckedAt)} 확인` : null].filter(Boolean).join(' · ');
}

function stat(label, value, sub, cls = '') {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-l', text: label }), h('div', { class: `stat-v ${cls}`, text: value }), h('div', { class: 'stat-s', text: sub || '' }));
}

function updateDetail() {
  const p = S.products.get(detail.id);
  if (!p) { location.hash = '#/'; return; }
  const E = detail.els;
  E.name.textContent = p.name || `상품 ${p.productId}`;
  E.thumb.replaceWith(E.thumb = thumb(p));
  fill(E.badges,
    p.inCart ? h('span', { class: 'badge', text: '장바구니' }) : null,
    p.atTarget ? h('span', { class: 'badge target', text: '목표가 도달' }) : null,
    isAtLow(p) ? h('span', { class: 'badge low', text: '역대 최저' }) : null,
    p.soldOut ? h('span', { class: 'badge', text: '품절' }) : null,
  );
  if (!detail.hovering) renderHero(p);
  E.error.hidden = !p.lastError;
  E.error.textContent = p.lastError ? `⚠ 마지막 확인 실패 (${ago(p.lastErrorAt)}): ${p.lastError}` : '';
  setChartData(false);
  const data = detail.data || {};
  const rangeLabel = (RANGES.find(([k]) => k === S.range) || RANGES[2])[1];
  const gap = p.price && p.minPrice ? p.price - p.minPrice : null;
  E.stats.replaceChildren(
    stat('역대 최저가', won(p.minPrice), p.minAt ? fmtDate(p.minAt, { time: false }) : ''),
    stat('역대 최고가', won(p.maxPrice), p.maxAt ? fmtDate(p.maxAt, { time: false }) : ''),
    stat('최저가보다', gap === null ? '–' : gap === 0 ? '지금이 최저가' : `${absWon(gap)}원 비쌈`, gap ? `+${((gap / p.minPrice) * 100).toFixed(1)}%` : ''),
    stat(`${rangeLabel} 평균`, data.avg ? won(data.avg) : '–', '시간 가중 평균'),
    stat('가격 변동', `${p.changes}회`, p.firstPrice ? `처음 ${won(p.firstPrice)} · ${fmtDate(p.history[0].t, { time: false })}` : ''),
    stat('마지막 확인', ago(lastSeen(p)), p.lastCheckedAt ? fmtShort(p.lastCheckedAt) : ''),
  );
  if (document.activeElement !== E.target) E.target.value = p.targetPrice ? String(p.targetPrice) : '';
  E.targetClear.hidden = !p.targetPrice;
  // 기록 표
  const rows = p.history.slice().reverse();
  const shown = rows.slice(0, detail.histLimit);
  E.table.replaceChildren(
    h('thead', null, h('tr', null, h('th', { text: '일시' }), h('th', { class: 'r', text: '가격' }), h('th', { class: 'r', text: '변동' }), h('th', { text: '확인 방법' }))),
    h('tbody', null, ...shown.map((pt) => {
      const idx = p.history.indexOf(pt);
      const prev = idx > 0 ? p.history[idx - 1].p : null;
      const diff = prev === null ? null : pt.p - prev;
      return h('tr', null,
        h('td', { text: fmtShort(pt.t) }),
        h('td', { class: 'r', text: won(pt.p) }),
        h('td', { class: `r ${diff === null ? 'flat' : dir(diff)}`, text: diff === null ? '처음' : `${arrow(diff)} ${absWon(diff)}` }),
        h('td', { text: SOURCE[pt.s] || pt.s || '' }));
    })),
  );
  E.more.hidden = rows.length <= detail.histLimit;
  E.more.textContent = `더 보기 (${rows.length - detail.histLimit}개 더)`;
}

function openDetail(id) {
  closeDetail();
  const p = S.products.get(id);
  if (!p) { location.hash = '#/'; return; }
  detail.id = id;
  detail.histLimit = 20;
  const view = $('#view-detail');
  const E = {};
  const segRange = h('div', { class: 'seg', role: 'group', 'aria-label': '기간' }, ...RANGES.map(([k, label]) => h('button', {
    type: 'button', 'aria-pressed': String(S.range === k), text: label,
    onclick: (e) => { S.range = k; setPref('range', k); for (const b of segRange.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); setChartData(true); updateDetail(); },
  })));
  const segType = h('div', { class: 'seg', role: 'group', 'aria-label': '차트 종류' }, ...[['area', '라인'], ['candle', '캔들']].map(([k, label]) => h('button', {
    type: 'button', 'aria-pressed': String(S.ctype === k), text: label,
    onclick: (e) => { S.ctype = k; setPref('ctype', k); for (const b of segType.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); setChartData(true); },
  })));
  E.thumb = thumb(p);
  E.name = h('h1', { class: 'hero-name' });
  E.badges = h('div', { class: 'meta' });
  E.heroPrice = h('div', { class: 'hero-price' });
  E.heroChg = h('div', { class: 'hero-chg' });
  E.heroWhen = h('div', { class: 'hero-when' });
  E.chart = h('div', { class: 'chart', role: 'img', 'aria-label': '가격 변동 차트. 아래 표에서 모든 기록을 볼 수 있어요.' });
  E.chartEmpty = h('div', { class: 'chart-empty' });
  E.chart.append(E.chartEmpty);
  E.error = h('div', { class: 'err-box', hidden: true });
  E.stats = h('div', { class: 'stats' });
  E.target = h('input', { type: 'text', inputmode: 'numeric', placeholder: '예: 9900', 'aria-label': '목표가(원)' });
  E.targetClear = h('button', { class: 'btn ghost small', type: 'button', text: '지우기', onclick: () => saveTarget(null) });
  E.table = h('table', { class: 'hist' });
  E.more = h('button', { class: 'btn ghost small more', type: 'button', onclick: () => { detail.histLimit += 50; updateDetail(); } });
  detail.els = E;

  view.replaceChildren(
    h('div', { class: 'detail-top' },
      h('a', { class: 'btn ghost small', href: '#/', text: '← 목록' }),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn ghost small', type: 'button', text: '지금 확인', onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try { await api('POST', `/api/products/${encodeURIComponent(id)}/check`); toast('가격을 확인하고 있어요…'); } catch (err) { toast(err.message); }
        setTimeout(() => { b.disabled = false; }, 3000);
      } }),
      h('a', { class: 'btn ghost small', href: p.url, target: '_blank', rel: 'noopener noreferrer', text: '쿠팡에서 보기 ↗' }),
    ),
    h('section', { class: 'card hero' },
      h('div', { class: 'hero-head' }, E.thumb, h('div', { style: 'min-width:0' }, E.name, E.badges)),
      E.heroPrice, E.heroChg, E.heroWhen, E.error,
      h('div', { class: 'ctrl' }, segRange, segType),
      E.chart,
    ),
    E.stats,
    h('section', { class: 'card section' },
      h('h3', { text: '목표가 알림' }),
      h('form', { class: 'target-form', onsubmit: (e) => { e.preventDefault(); saveTarget(E.target.value); } },
        E.target, h('span', { text: '원 이하가 되면' }), h('button', { class: 'btn small', type: 'submit', text: '저장' }), E.targetClear),
      h('p', { class: 'help', text: '가격이 목표가 이하로 내려가면 화면에 알림이 뜨고, 차트에 점선으로 표시돼요.' }),
    ),
    h('section', { class: 'card section' }, h('h3', { text: '가격 기록' }), E.table, E.more),
    h('section', { class: 'section', style: 'text-align:center' },
      h('button', { class: 'btn danger small', type: 'button', text: '이 상품 추적 그만하기', onclick: async () => {
        if (!confirm('이 상품과 가격 기록을 삭제할까요?')) return;
        try { await api('DELETE', `/api/products/${encodeURIComponent(id)}`); location.hash = '#/'; } catch (err) { toast(err.message); }
      } })),
  );
  $('#view-list').hidden = true;
  view.hidden = false;
  window.scrollTo(0, 0);
  detail.chart = createChart(E.chart);
  detail.seriesType = null;
  updateDetail();
  setChartData(true);
}

function closeDetail() {
  if (detail.chart) { detail.chart.remove(); }
  Object.assign(detail, { id: null, chart: null, series: null, seriesType: null, els: null, targetLine: null, hovering: false, data: null });
  $('#view-detail').hidden = true;
  $('#view-detail').replaceChildren();
  $('#view-list').hidden = false;
}

async function saveTarget(v) {
  const raw = v === null ? null : String(v).replace(/[^\d]/g, '');
  try {
    await api('PATCH', `/api/products/${encodeURIComponent(detail.id)}`, { targetPrice: raw || null });
    toast(raw ? `목표가 ${won(Number(raw))}을 저장했어요.` : '목표가를 지웠어요.');
  } catch (e) { toast(e.message); }
}

// ---------- 시트(설정/가져오기) ----------
function openSheet(build) {
  const root = $('#sheet-root');
  const close = () => { root.replaceChildren(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
  const bg = h('div', { class: 'sheet-bg', onclick: (e) => { if (e.target === bg) close(); } }, sheet);
  build(sheet, close);
  root.replaceChildren(bg);
  document.addEventListener('keydown', onKey);
  const first = sheet.querySelector('button, input, select, a');
  if (first) first.focus();
  return close;
}
const closeBtn = (close) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': '닫기', text: '✕', onclick: close });

async function copyText(text, fallbackEl) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* http 에서는 막힘 */ }
  if (fallbackEl) {
    fallbackEl.focus(); fallbackEl.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }
  return false;
}

async function openImport() {
  let bm;
  try { bm = await api('GET', '/api/bookmarklet'); } catch (e) { toast(e.message); return; }
  openSheet((sheet, close) => {
    const code = h('textarea', { class: 'code', readonly: true, 'aria-label': '북마클릿 코드' });
    code.value = bm.code;
    const link = h('a', { class: 'bm-link', href: bm.code, title: '이 버튼을 북마크바로 끌어다 놓으세요' }, '🛒 시세에 담기');
    link.addEventListener('click', (e) => { e.preventDefault(); toast('이 버튼은 북마크바로 끌어다 놓아 사용해요.'); });
    const isMobile = /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);
    const pc = h('div', null,
      h('div', { class: 'step' }, h('div', { class: 'step-n', text: '1' }), h('div', { class: 'step-b' },
        h('p', { text: '아래 버튼을 브라우저의 북마크바로 끌어다 놓으세요.' }), link,
        h('small', { text: '북마크바가 안 보이면 Ctrl + Shift + B (맥: ⌘ + Shift + B)' }))),
      h('div', { class: 'step' }, h('div', { class: 'step-n', text: '2' }), h('div', { class: 'step-b' },
        h('p', null, '쿠팡에 로그인한 뒤 ', h('a', { href: 'https://cart.coupang.com/cartView.pang', target: '_blank', rel: 'noopener noreferrer', text: '장바구니' }), '를 여세요.'))),
      h('div', { class: 'step' }, h('div', { class: 'step-n', text: '3' }), h('div', { class: 'step-b' },
        h('p', { text: '북마크바의 "🛒 시세에 담기"를 누르면 장바구니 상품과 가격이 이 화면으로 들어와요.' }),
        h('small', { text: '상품 상세 페이지에서 누르면 그 상품 하나만 추가돼요. 장바구니에서 다시 누를 때마다 가격이 새로 기록돼요.' }))),
    );
    const mobile = h('div', null,
      h('div', { class: 'step' }, h('div', { class: 'step-n', text: '1' }), h('div', { class: 'step-b' },
        h('p', { text: '아래 코드를 복사하세요.' }), code,
        h('button', { class: 'btn small', type: 'button', text: '코드 복사', onclick: async () => toast((await copyText(bm.code, code)) ? '복사했어요.' : '길게 눌러 전체 선택 후 복사해 주세요.') }))),
      h('div', { class: 'step' }, h('div', { class: 'step-n', text: '2' }), h('div', { class: 'step-b' },
        h('p', { text: '아무 페이지나 북마크(즐겨찾기)에 추가한 뒤, 북마크를 편집해 이름을 "시세"로, 주소를 복사한 코드로 바꾸세요.' }))),
      h('div', { class: 'step' }, h('div', { class: 'step-n', text: '3' }), h('div', { class: 'step-b' },
        h('p', { text: '휴대폰 브라우저(크롬·사파리)로 m.coupang.com 장바구니를 열고, 주소창에 "시세"를 입력해 북마크를 누르세요.' }),
        h('small', { text: '쿠팡 앱 안에서는 동작하지 않아요. 휴대폰과 이 서버가 같은 와이파이에 있어야 해요.' }))),
    );
    const tabs = h('div', { class: 'seg' });
    const show = (m) => { pc.hidden = m !== 'pc'; mobile.hidden = m !== 'mobile'; for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.m === m)); };
    for (const [m, label] of [['pc', 'PC'], ['mobile', '휴대폰']]) tabs.append(h('button', { type: 'button', 'data-m': m, text: label, onclick: () => show(m) }));
    show(isMobile ? 'mobile' : 'pc');
    add(sheet,
      h('div', { class: 'sheet-head' }, h('div', null, h('h2', { text: '장바구니 가져오기' }), h('p', { class: 'lead', text: '쿠팡 장바구니에 담긴 상품을 한 번에 추적 목록에 넣어요.' })), closeBtn(close)),
      h('div', { class: 'tabs' }, tabs),
      pc, mobile,
      h('div', { class: 'field' },
        h('div', { class: 'field-l', text: '자동으로 계속 동기화하려면' }),
        h('div', { class: 'field-d', text: S.demo
          ? '데모 모드에서는 쓸 수 없어요.'
          : '설정에서 "장바구니 자동 동기화"를 켜고, 이 서버가 실행 중인 PC에서 쿠팡에 한 번 로그인하면 확인 주기마다 장바구니를 직접 읽어와요.' }),
        S.demo ? null : h('div', { class: 'field-c' }, h('button', { class: 'btn ghost small', type: 'button', text: '설정 열기', onclick: () => { close(); openSettings(); } })),
      ),
    );
  });
}

function openSettings() {
  openSheet((sheet, close) => {
    const s = S.settings || {};
    const put = async (patch) => {
      try { const r = await api('PUT', '/api/settings', patch); S.settings = r.settings; renderStatus(); } catch (e) { toast(e.message); }
    };
    const radio = (name, options, value, onPick) => h('div', { class: 'radio' }, ...options.map(([v, label, desc]) => {
      const input = h('input', { type: 'radio', name, value: v });
      input.checked = v === value;
      input.addEventListener('change', () => onPick(v));
      return h('label', null, input, h('span', null, label, desc ? h('small', { text: desc }) : null));
    }));
    const interval = h('select', { 'aria-label': '확인 주기', onchange: (e) => put({ intervalMinutes: Number(e.target.value) }) },
      ...[10, 15, 30, 60, 120, 180, 360].map((m) => { const o = h('option', { value: String(m), text: m < 60 ? `${m}분마다` : `${m / 60}시간마다` }); if (m === s.intervalMinutes) o.selected = true; return o; }));
    const cart = h('input', { type: 'checkbox' });
    cart.checked = Boolean(s.cartSync);
    cart.addEventListener('change', () => put({ cartSync: cart.checked }));
    const br = S.browser || {};
    const cartSt = (S.status && S.status.cart) || {};
    const notifyBtn = h('button', { class: 'btn ghost small', type: 'button', text: '브라우저 알림 켜기', onclick: async () => {
      if (!('Notification' in window)) { toast('이 브라우저는 알림을 지원하지 않아요.'); return; }
      if (!window.isSecureContext) { toast('알림은 이 PC에서 http://localhost 로 열었을 때만 쓸 수 있어요.'); return; }
      const r = await Notification.requestPermission();
      toast(r === 'granted' ? '가격이 내리면 알림을 보내드려요.' : '알림이 허용되지 않았어요.');
    } });
    add(sheet,
      h('div', { class: 'sheet-head' }, h('h2', { text: '설정' }), closeBtn(close)),
      S.demo ? h('div', { class: 'banner', text: '데모 모드에서는 20초마다 가상의 가격이 바뀌어요. 아래 설정은 실제 모드에서 적용돼요.' }) : null,
      h('div', { class: 'field' }, h('div', { class: 'field-l', text: '가격 확인 주기' }),
        h('div', { class: 'field-d', text: '너무 자주 확인하면 쿠팡이 접속을 막을 수 있어요. 30분 이상을 권장해요.' }),
        h('div', { class: 'field-c' }, interval)),
      h('div', { class: 'field' }, h('div', { class: 'field-l', text: '가격을 가져오는 방법' }),
        h('div', { class: 'field-c' }, radio('fetchMode', [
          ['auto', '자동 (추천)', '빠른 요청을 먼저 쓰고, 쿠팡이 막으면 브라우저로 확인해요.'],
          ['fetch', '빠른 요청만', '가볍지만 쿠팡이 자주 막아요.'],
          ['browser', '브라우저만', '크롬/엣지를 자동으로 열어 실제 화면에서 가격을 읽어요. 가장 확실해요.'],
        ], s.fetchMode, (v) => put({ fetchMode: v })))),
      h('div', { class: 'field' }, h('div', { class: 'field-l', text: '브라우저 창' }),
        h('div', { class: 'field-c' }, radio('browserMode', [
          ['headless', '숨기기', '창 없이 뒤에서 확인해요.'],
          ['window', '보이기', '숨기기 모드가 막힐 때 쓰세요. 확인용 창이 하나 열려 있어요(최소화해 두면 돼요).'],
        ], s.browserMode, (v) => put({ browserMode: v })))),
      h('div', { class: 'field' }, h('div', { class: 'field-l', text: '사용할 브라우저' }),
        h('div', { class: 'field-c' }, h('select', { 'aria-label': '사용할 브라우저', onchange: (e) => put({ browserChannel: e.target.value }) },
          ...[['auto', '자동 (크롬 → 엣지 → 내장)'], ['chrome', '크롬'], ['msedge', '엣지'], ['chromium', '내장 크로미움']].map(([v, label]) => { const o = h('option', { value: v, text: label }); if (v === s.browserChannel) o.selected = true; return o; })),
          br.channel ? h('span', { class: 'kv' }, '사용 중: ', h('b', { text: br.channel })) : null),
        br.lastError ? h('div', { class: 'err-box', text: br.lastError }) : null),
      h('div', { class: 'field' }, h('div', { class: 'field-l', text: '장바구니 자동 동기화' }),
        h('div', { class: 'field-d', text: '확인할 때마다 쿠팡 장바구니를 직접 열어 새로 담은 상품은 추가하고 가격을 기록해요. 이 서버가 돌아가는 PC에서 한 번 로그인해야 해요.' }),
        h('div', { class: 'field-c' },
          h('label', { class: 'switch' }, cart, '켜기'),
          h('button', { class: 'btn ghost small', type: 'button', text: br.loginOpen ? '로그인 창 열림' : '쿠팡 로그인 창 열기', disabled: S.demo || br.loginOpen, onclick: async () => {
            try { await api('POST', '/api/browser/login'); toast('PC에 쿠팡 로그인 창을 열었어요. 로그인 후 창을 닫아주세요.', { ms: 8000 }); close(); } catch (e) { toast(e.message); }
          } }),
          h('button', { class: 'btn ghost small', type: 'button', text: '지금 동기화', disabled: S.demo, onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            b.textContent = '동기화 중…';
            try { const r = await api('POST', '/api/cart/sync'); toast(`장바구니 ${r.ids.length}개 확인 (새 상품 ${r.added}개)`); } catch (err) { toast(err.message, { ms: 8000 }); }
            b.disabled = false;
            b.textContent = '지금 동기화';
          } })),
        cartSt.lastSyncAt ? h('div', { class: 'kv', style: 'margin-top:6px' }, `마지막 동기화 ${ago(cartSt.lastSyncAt)} · ${cartSt.count}개`) : null,
        cartSt.error ? h('div', { class: 'err-box', text: cartSt.error }) : null),
      h('div', { class: 'field' }, h('div', { class: 'field-l', text: '알림' }),
        h('div', { class: 'field-d', text: '이 화면이 열려 있으면 가격이 바뀔 때 아래에 알림이 떠요. PC에서는 브라우저 알림도 받을 수 있어요.' }),
        h('div', { class: 'field-c' }, notifyBtn)),
    );
  });
}

// ---------- 실시간 ----------
function applyState(st) {
  S.skew = Date.now() - st.serverTime;
  S.settings = st.settings;
  S.status = st.status;
  S.browser = st.browser;
  S.demo = st.demo;
  S.products = new Map(st.products.map((p) => [p.id, p]));
  $('#demo-pill').hidden = !S.demo;
  $('#demo-banner').hidden = !S.demo;
  renderStatus();
  scheduleRender();
}

async function load() {
  try { applyState(await api('GET', '/api/state')); } catch (e) { toast(`불러오기 실패: ${e.message}`); }
}

function onProduct({ product, point }) {
  const old = S.products.get(product.id);
  const history = old ? old.history.slice() : [];
  if (point && !history.some((x) => x.t === point.t && x.p === point.p)) {
    history.push(point);
    history.sort((a, b) => a.t - b.t);
  }
  if (point && old && old.price !== null && old.price !== point.p) S.flash.set(product.id, { dir: point.p > old.price ? 'up' : 'down', at: Date.now() });
  S.products.set(product.id, { ...product, history });
  scheduleRender();
}

const ALERT_TAG = { drop: ['▼ 내림', 'down'], rise: ['▲ 오름', 'up'], low: ['★ 역대 최저', 'down'], target: ['🎯 목표가', 'down'] };
function onAlert(a) {
  const [tag, cls] = ALERT_TAG[a.kind] || ['알림', ''];
  const name = String(a.name || '상품').replace(/^\[데모\]\s*/, '');
  const text = `${name.slice(0, 36)} ${won(a.prev)} → ${won(a.price)}`;
  toast(text, { tag, tagClass: cls, onclick: () => { location.hash = `#/p/${encodeURIComponent(a.id)}`; } });
  if (a.kind !== 'rise' && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(`${tag} ${won(a.price)}`, { body: `${name} (${arrow(a.diff)} ${absWon(a.diff)}원)`, tag: a.id }); } catch { /* 무시 */ }
  }
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => {
    const was = S.everConnected;
    S.connected = true; S.everConnected = true;
    renderStatus();
    if (was) load();
  });
  es.addEventListener('error', () => { S.connected = false; renderStatus(); });
  es.addEventListener('status', (e) => { S.status = JSON.parse(e.data); renderStatus(); });
  es.addEventListener('product', (e) => onProduct(JSON.parse(e.data)));
  es.addEventListener('removed', (e) => { S.products.delete(JSON.parse(e.data).id); scheduleRender(); });
  es.addEventListener('settings', (e) => { S.settings = JSON.parse(e.data); renderStatus(); });
  es.addEventListener('browser', (e) => { S.browser = JSON.parse(e.data); });
  es.addEventListener('alert', (e) => onAlert(JSON.parse(e.data)));
}

// ---------- 가져오기(북마클릿에서 넘어온 데이터) ----------
async function handleImportHash() {
  if (!location.hash.startsWith('#import=')) return false;
  const raw = location.hash.slice('#import='.length);
  history.replaceState(null, '', location.pathname + location.search);
  let payload;
  try { payload = JSON.parse(decodeURIComponent(raw)); } catch { toast('가져온 데이터를 읽지 못했어요.'); return true; }
  try {
    const r = await api('POST', '/api/import', payload);
    const what = r.kind === 'cart' ? '장바구니에서' : '상품 페이지에서';
    toast(`${what} ${r.ids.length}개 가져왔어요 (새 상품 ${r.added}개, 가격 ${r.priced}개 기록)`, { ms: 7000 });
    await load();
    if (r.kind !== 'cart' && r.ids.length === 1) location.hash = `#/p/${encodeURIComponent(r.ids[0])}`;
  } catch (e) { toast(`가져오기 실패: ${e.message}`); }
  return true;
}

// ---------- 라우팅 ----------
function route() {
  if (location.hash.startsWith('#import=')) { handleImportHash(); return; }
  const m = location.hash.match(/^#\/p\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (detail.id !== id) {
      if (S.products.has(id)) openDetail(id);
      else if (S.products.size) location.hash = '#/';
    }
  } else if (detail.id) {
    closeDetail();
    scheduleRender();
  }
}

// ---------- 시작 ----------
$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#add-input');
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const btn = $('#add-btn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/products', { url: text });
    input.value = '';
    toast(r.created ? '추가했어요. 가격을 확인하고 있어요…' : '이미 추적 중인 상품이에요.');
  } catch (err) { toast(err.message, { ms: 6000 }); }
  btn.disabled = false;
});
$('#btn-check').addEventListener('click', async () => {
  try { await api('POST', '/api/check'); } catch (e) { toast(e.message); }
});
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-import').addEventListener('click', openImport);
window.addEventListener('hashchange', route);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (detail.id) { const id = detail.id; closeDetail(); openDetail(id); } });
setInterval(() => { if (S.status && !S.status.running) renderStatus(); }, 1000);
setInterval(() => scheduleRender(), 60000); // "n분 전" 표시 갱신

(async () => {
  await load();
  connect();
  if (!(await handleImportHash())) route();
})();
