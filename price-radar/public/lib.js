// 화면 공통 도우미
export const DAY = 86400000;
export const HOUR = 3600000;
export const MIN = 60000;

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs, ...kids) {
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
  add(el, ...kids);
  return el;
}
const real = (kids) => kids.flat().filter((k) => k !== null && k !== undefined && k !== false);
export function add(el, ...kids) {
  for (const k of real(kids)) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
export function fill(el, ...kids) { el.replaceChildren(); return add(el, ...kids); }
export function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

export const nf = new Intl.NumberFormat('ko-KR');
export const won = (n) => (n === null || n === undefined ? '–' : `${nf.format(Math.round(n))}원`);
export const dir = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
export const arrow = (n) => (n > 0 ? '▲' : n < 0 ? '▼' : '');
export const absWon = (n) => nf.format(Math.abs(Math.round(n)));
export const pctStr = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}%`;
export const pad = (n) => String(n).padStart(2, '0');
const WD = ['일', '월', '화', '수', '목', '금', '토'];

export function fmtDate(t, { time = true } = {}) {
  const d = new Date(t);
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}. ` : '';
  return `${y}${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})${time ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''}`;
}
export function fmtShort(t) {
  const d = new Date(t);
  if (d.toDateString() === new Date().toDateString()) return `오늘 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function ago(t) {
  if (!t) return '–';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return '방금';
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}일 전`;
  return fmtDate(t, { time: false });
}
export function minutesText(m) {
  if (m < 60) return `${m}분`;
  const hh = Math.round(m / 60);
  return hh < 24 ? `${hh}시간` : `${Math.round(hh / 24)}일`;
}

export const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export function rgba(hex, a) {
  const m = String(hex).replace('#', '');
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(m)) return `rgba(139, 143, 150, ${a})`;
  const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function toast(text, { ms = 4500, onclick = null } = {}) {
  const box = $('#toasts');
  const el = h('div', { class: 'toast', role: 'status', text });
  el.addEventListener('click', () => { if (onclick) onclick(); el.remove(); });
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

export function priceAt(hist, t) {
  let v = null;
  for (const pt of hist) { if (pt.t <= t) v = pt.p; else break; }
  return v;
}

/** 기록(상세 화면) 또는 서버가 준 요약값(목록)으로 직전 대비 변동, 최저/최고가 등을 계산한다 */
export function stats(item) {
  if (!item.history) {
    const price = item.price ?? null;
    const prev = item.prevPrice ?? null;
    const min = item.minPrice ?? null;
    const max = item.maxPrice ?? null;
    const change = price !== null && prev !== null ? price - prev : 0;
    return {
      price, prevPrice: prev, change, changePct: prev ? (change / prev) * 100 : 0, changedAt: prev !== null ? item.changedAt : null,
      minPrice: min, minAt: null, maxPrice: max, maxAt: null, firstPrice: null, firstAt: null, changes: null,
      atLow: Boolean(price !== null && min !== null && max !== null && price === min && min !== max),
      atTarget: Boolean(item.targetPrice && price && price <= item.targetPrice),
    };
  }
  const hist = item.history;
  const last = hist[hist.length - 1] || null;
  const prev = hist.length > 1 ? hist[hist.length - 2] : null;
  let min = null; let max = null;
  for (const pt of hist) { if (!min || pt.p < min.p) min = pt; if (!max || pt.p > max.p) max = pt; }
  const price = item.price ?? (last ? last.p : null);
  const change = last && prev ? last.p - prev.p : 0;
  return {
    price,
    prevPrice: prev ? prev.p : null,
    change,
    changePct: prev ? (change / prev.p) * 100 : 0,
    changedAt: prev ? last.t : null,
    minPrice: min ? min.p : null,
    minAt: min ? min.t : null,
    maxPrice: max ? max.p : null,
    maxAt: max ? max.t : null,
    firstPrice: hist[0] ? hist[0].p : null,
    firstAt: hist[0] ? hist[0].t : null,
    changes: Math.max(0, hist.length - 1),
    atLow: Boolean(min && max && price === min.p && min.p !== max.p),
    atTarget: Boolean(item.targetPrice && price && price <= item.targetPrice),
  };
}
