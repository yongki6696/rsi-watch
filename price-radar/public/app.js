/* 최저가 레이더 — 휴대폰 화면 */
import { $, h, add, fill, won, dir, arrow, absWon, pctStr, fmtDate, fmtShort, ago, minutesText, toast, stats } from './lib.js';
import { PriceChart, RANGES, hoverText } from './chart.js';

const S = {
  token: null,
  config: null,
  watches: [],
  user: null,
  status: null,
  view: null,
  detail: null,
  feedKey: 'goldbox',
  feeds: {},
  range: pref('range', '1M'),
  ctype: pref('ctype', 'area'),
  push: 'unknown', // on | off | unsupported | ios-install | denied | unconfigured
  installEvent: null,
};

// ---------- 저장소 ----------
const mem = {};
function pref(k, d) { try { const v = localStorage.getItem(`pr.${k}`); return v === null ? d : v; } catch { return k in mem ? mem[k] : d; } }
function setPref(k, v) {
  try { if (v === null) localStorage.removeItem(`pr.${k}`); else localStorage.setItem(`pr.${k}`, v); } catch { mem[k] = v; }
}

// ---------- 서버 ----------
async function api(method, path, body, retried = false) {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (res.status === 401 && data && data.relogin && !retried && path !== '/api/session') {
    await newSession();
    return api(method, path, body, true);
  }
  if (!res.ok) {
    const e = new Error((data && data.error) || `요청이 실패했어요 (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

async function newSession() {
  const r = await api('POST', '/api/session', {});
  S.token = r.token;
  setPref('token', r.token);
}

async function loadMe() {
  const d = await api('GET', '/api/me');
  S.watches = d.watches;
  S.user = d.user;
  S.status = d.status;
  rerender();
}

const signature = (ws) => ws.map((w) => `${w.id}:${w.price}:${w.changedAt}:${w.status}:${w.targetPrice}:${w.notifyDrop}`).join('|');
async function poll() {
  if (document.hidden || !S.token) return;
  try {
    const d = await api('GET', '/api/me?lite=1');
    if (signature(d.watches) !== signature(S.watches)) await loadMe();
    else { S.status = d.status; S.user = d.user; renderStatusLine(); }
  } catch { /* 다음 번에 */ }
}

// ---------- 공통 조각 ----------
const disclosure = () => h('p', { class: 'fine', text: (S.config && S.config.disclosure) || '' });
const badge = (text, cls = '') => h('span', { class: `badge ${cls}`, text });
const displayName = (w) => (w.kind === 'keyword' ? `‘${w.name}’ 최저가` : w.name || `상품 ${w.ref}`);

function thumb(src, label, size = '') {
  const box = h('div', { class: `thumb ${size}`, 'aria-hidden': 'true' });
  const ini = () => h('span', { class: 'ini', text: String(label || '?').replace(/^\[.*?\]\s*/, '').replace(/^‘/, '').slice(0, 1) });
  if (src) {
    const img = h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => { img.remove(); box.append(ini()); });
    box.append(img);
  } else box.append(ini());
  return box;
}

function changeEl(st) {
  if (st.price === null) return h('div', { class: 'chg flat', text: '확인 전' });
  if (!st.prevPrice) return h('div', { class: 'chg flat', text: '변동 없음' });
  return h('div', { class: `chg ${dir(st.change)}` }, h('span', { class: `chg-pill ${dir(st.change)}` }, `${arrow(st.change)} ${absWon(st.change)} (${pctStr(st.changePct)})`));
}

function badgesFor(w, st) {
  return [
    w.kind === 'keyword' ? badge('키워드', 'kw') : null,
    st.atTarget ? badge('목표가 도달', 'target') : null,
    st.atLow ? badge('역대 최저', 'low') : null,
    w.isRocket ? badge('로켓') : null,
    w.status === 'pending' ? badge('가격 찾는 중') : null,
    w.status === 'not_found' ? badge('검색에서 못 찾음', 'err') : null,
  ];
}

function buyLink(url, label = '쿠팡에서 보기') {
  if (!url) return null;
  return h('a', { class: 'btn buy', href: url, target: '_blank', rel: 'sponsored noopener noreferrer', text: label });
}

function openSheet(build) {
  const root = $('#sheet-root');
  let closed = false;
  // 닫을 때 뒤로 가기 기록까지 정리가 끝난 뒤에 다음 화면으로 넘어가도록 Promise 를 돌려준다
  const close = () => new Promise((resolve) => {
    if (closed) { resolve(); return; }
    closed = true;
    root.replaceChildren();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    if (history.state && history.state.sheet) {
      let done = false;
      const finish = () => { if (done) return; done = true; window.removeEventListener('popstate', finish); resolve(); };
      window.addEventListener('popstate', finish);
      history.back();
      setTimeout(finish, 500);
    } else resolve();
  });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const onPop = () => { if (!closed) { closed = true; root.replaceChildren(); document.removeEventListener('keydown', onKey); window.removeEventListener('popstate', onPop); } };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
  const bg = h('div', { class: 'sheet-bg', onclick: (e) => { if (e.target === bg) close(); } }, sheet);
  root.replaceChildren(bg);
  history.pushState({ sheet: 1 }, '');
  window.addEventListener('popstate', onPop);
  document.addEventListener('keydown', onKey);
  build(sheet, close);
  return close;
}
const sheetHead = (title, close) => h('div', { class: 'sheet-head' }, h('h2', { text: title }), h('button', { class: 'icon-btn', type: 'button', 'aria-label': '닫기', text: '✕', onclick: close }));

// ---------- 홈 ----------
function demoBanner() {
  if (!S.config || S.config.mode !== 'mock') return null;
  return h('div', { class: 'banner' }, h('b', { text: '데모 모드' }), ' — 운영자가 쿠팡 파트너스 API 키를 넣기 전이라 가상의 가격이 보여요.');
}

function pushCard() {
  if (S.push === 'on' || S.push === 'unconfigured' || S.push === 'unknown') return null;
  if (S.push === 'ios-install') {
    return h('div', { class: 'card tip' },
      h('b', { text: '아이폰은 홈 화면에 추가해야 알림이 와요' }),
      h('ol', null, h('li', { text: 'Safari 아래쪽 공유 버튼(□↑)을 누르고' }), h('li', { text: '"홈 화면에 추가"를 고른 뒤' }), h('li', { text: '홈 화면에 생긴 아이콘으로 열어 주세요.' })));
  }
  if (S.push === 'denied') return h('div', { class: 'card tip' }, h('b', { text: '알림이 차단돼 있어요' }), h('p', { text: '휴대폰 설정 → 앱/브라우저 → 알림에서 허용해 주세요.' }));
  if (S.push === 'unsupported') return null;
  return h('div', { class: 'card tip' },
    h('div', null, h('b', { text: '가격이 내리면 알림 받기' }), h('p', { text: '목표가에 닿거나 가격이 내리면 바로 알려드려요.' })),
    h('button', { class: 'btn', type: 'button', text: '알림 켜기', onclick: enablePush }));
}

function installCard() {
  if (!S.installEvent) return null;
  return h('div', { class: 'card tip' },
    h('div', null, h('b', { text: '홈 화면에 앱으로 설치' }), h('p', { text: '쿠팡 앱의 "공유"에서 바로 이 앱을 고를 수 있어요.' })),
    h('button', { class: 'btn ghost', type: 'button', text: '설치', onclick: async () => { const ev = S.installEvent; S.installEvent = null; ev.prompt(); await ev.userChoice; rerender(); } }));
}

function renderStatusLine() {
  const el = $('#status-line');
  if (!el || !S.status) return;
  const st = S.status;
  const parts = [`가격은 약 ${minutesText(st.cycleMin || 60)}마다 확인해요`];
  if (st.lastRunAt) parts.push(`마지막 확인 ${ago(st.lastRunAt)}`);
  fill(el, h('span', { text: parts.join(' · ') }), st.pausedUntil > Date.now() ? badge('쿠팡 조회 잠시 멈춤', 'err') : null);
}

function rowEl(w) {
  const st = stats(w);
  const sub = w.kind === 'keyword' && w.bestName
    ? `최저: ${w.bestName.replace(/^\[데모\]\s*/, '').slice(0, 30)}`
    : w.changedAt && st.prevPrice ? `${ago(w.changedAt)} 변동` : w.lastFoundAt ? `${ago(w.lastFoundAt)} 확인` : '';
  return h('a', { class: 'row', href: `#/w/${w.id}` },
    thumb(w.image, w.name),
    h('div', { class: 'row-main' }, h('div', { class: 'name', text: displayName(w) }), h('div', { class: 'meta' }, ...badgesFor(w, st), sub ? h('span', { text: sub }) : null)),
    h('div', { class: 'px' }, h('div', { class: 'px-now', text: won(st.price) }), changeEl(st)));
}

function showHome() {
  S.view = 'home';
  const empty = h('div', { class: 'card empty' },
    h('div', { class: 'empty-icon', text: '📡' }),
    h('h3', { text: '가격을 지켜볼 상품을 추가해 보세요' }),
    h('p', { text: '쿠팡 앱에서 상품 → 공유 → 링크 복사 후 붙여넣거나, 상품 이름을 입력하면 돼요.' }),
    h('button', { class: 'btn', type: 'button', text: '+ 상품 추가', onclick: () => openAdd() }));
  fill($('#view'),
    demoBanner(),
    pushCard(),
    installCard(),
    h('div', { class: 'status-line', id: 'status-line', 'aria-live': 'polite' }),
    S.watches.length ? h('section', { class: 'card list', 'aria-label': '내 알림' }, ...S.watches.map(rowEl)) : empty,
    S.watches.length ? h('p', { class: 'muted center', text: `${S.watches.length} / ${S.config ? S.config.maxWatches : 30}개` }) : null,
    disclosure());
  renderStatusLine();
}

// ---------- 추가 ----------
async function addWatch(body, close) {
  try {
    const r = await api('POST', '/api/watches', body);
    if (close) await close();
    toast('알림을 등록했어요.');
    await loadMe();
    location.hash = `#/w/${r.watch.id}`;
    if (S.push === 'off') setTimeout(() => toast('가격이 내렸을 때 알림을 받으려면 알림을 켜 주세요.', { ms: 6000, onclick: enablePush }), 800);
  } catch (e) { toast(e.message, { ms: 6000 }); }
}

function itemRow(it, actions) {
  return h('div', { class: 'item' },
    thumb(it.image, it.name, 'sm'),
    h('div', { class: 'row-main' },
      h('div', { class: 'name small', text: it.name }),
      h('div', { class: 'meta' }, h('b', { class: 'price', text: won(it.price) }), it.isRocket ? badge('로켓') : null)),
    h('div', { class: 'item-actions' }, ...actions));
}

export function openAdd(prefill = '', auto = false) {
  openSheet((sheet, close) => {
    const ta = h('textarea', { class: 'add-text', rows: '3', 'aria-label': '쿠팡 링크나 상품 이름', placeholder: '쿠팡 앱 → 상품 → 공유 → 링크 복사 후 붙여넣기\n상품 이름이나 검색어만 입력해도 돼요' });
    ta.value = prefill;
    const out = h('div', { class: 'add-out', 'aria-live': 'polite' });
    const findBtn = h('button', { class: 'btn', type: 'submit', text: '찾기' });
    const canPaste = navigator.clipboard && typeof navigator.clipboard.readText === 'function';
    const pasteBtn = canPaste ? h('button', {
      class: 'btn ghost', type: 'button', text: '붙여넣기',
      onclick: async () => { try { ta.value = await navigator.clipboard.readText(); if (ta.value.trim()) resolve(); } catch { toast('입력칸을 길게 눌러 붙여넣어 주세요.'); } },
    }) : null;

    async function resolve(name) {
      const text = ta.value.trim();
      if (!text && !name) { ta.focus(); return; }
      findBtn.disabled = true;
      fill(out, h('p', { class: 'muted', text: '쿠팡에서 찾는 중…' }));
      try { show(await api('POST', '/api/resolve', { text, name: name || undefined })); } catch (e) { fill(out, h('p', { class: 'err-box', text: e.message })); }
      findBtn.disabled = false;
    }

    function keywordButton(keyword) {
      if (!keyword) return null;
      return h('button', { class: 'btn ghost wide', type: 'button', onclick: () => addWatch({ kind: 'keyword', keyword }, close) }, `‘${keyword}’ 검색 최저가로 알림 받기`);
    }

    function show(r) {
      if (r.needName) {
        const name = h('input', { type: 'text', class: 'input', placeholder: '예: 탐사 샘물 2L', 'aria-label': '상품 이름' });
        fill(out,
          h('p', { text: r.shortLink ? '공유 링크만으로는 어떤 상품인지 알 수 없었어요. 상품 이름을 알려주세요.' : '상품 이름을 알려주세요. 이름으로 쿠팡에서 가격을 찾아요.' }),
          h('form', { class: 'inline', onsubmit: (e) => { e.preventDefault(); if (name.value.trim()) resolve(name.value.trim()); } }, name, h('button', { class: 'btn', type: 'submit', text: '찾기' })));
        name.focus();
        return;
      }
      if (r.match) {
        const target = h('input', { type: 'text', inputmode: 'numeric', class: 'input', placeholder: '목표가 (선택)', 'aria-label': '목표가' });
        fill(out,
          h('p', { class: 'ok-text', text: '이 상품이 맞나요?' }),
          itemRow(r.match, []),
          h('div', { class: 'inline' }, target, h('span', { class: 'muted', text: '원 이하면 알림' })),
          h('button', { class: 'btn wide', type: 'button', text: '이 상품 알림 받기', onclick: () => addWatch({ kind: 'product', productId: r.match.productId, keyword: r.keyword, targetPrice: target.value.replace(/[^\d]/g, '') || null }, close) }),
          keywordButton(r.keyword));
        return;
      }
      const parts = [];
      if (r.unavailable) parts.push(h('p', { class: 'err-box', text: r.message || '지금은 쿠팡에서 찾지 못했어요.' }));
      if (r.productId && !r.unavailable) parts.push(h('p', { class: 'muted', text: '링크의 상품이 검색 결과에 바로 보이지 않아요. 아래에서 고르거나, 그대로 등록하면 다음 확인 때 다시 찾아볼게요.' }));
      if (r.productId && r.keyword) {
        parts.push(h('button', { class: 'btn wide', type: 'button', text: '링크의 상품 그대로 등록', onclick: () => addWatch({ kind: 'product', productId: r.productId, keyword: r.keyword }, close) }));
      }
      if (r.results && r.results.length) {
        parts.push(h('p', { class: 'list-title', text: r.productId ? '비슷한 상품' : '이 중에 찾는 상품이 있나요?' }));
        parts.push(h('div', { class: 'items' }, ...r.results.map((it) => itemRow(it, [
          h('button', { class: 'btn small', type: 'button', text: '이거예요', onclick: () => addWatch({ kind: 'product', productId: it.productId, keyword: r.keyword }, close) }),
        ]))));
      } else if (!r.unavailable && !r.productId) {
        parts.push(h('p', { class: 'muted', text: '검색 결과가 없어요. 다른 이름으로 찾아보세요.' }));
      }
      parts.push(keywordButton(r.keyword));
      fill(out, ...parts);
    }

    add(sheet,
      sheetHead('알림 추가', close),
      h('form', { class: 'add-form', onsubmit: (e) => { e.preventDefault(); resolve(); } }, ta, h('div', { class: 'btn-row' }, pasteBtn, findBtn)),
      out,
      h('p', { class: 'fine', text: '안드로이드: 쿠팡 앱의 "공유"에서 이 앱(설치했다면)을 바로 고를 수 있어요.' }),
      disclosure());
    if (auto && prefill) resolve(); else setTimeout(() => ta.focus(), 50);
  });
}

// ---------- 상세 ----------
function leaveDetail() {
  if (S.detail && S.detail.chart) S.detail.chart.destroy();
  S.detail = null;
}

async function showDetail(id) {
  const cached = S.watches.find((x) => x.id === id);
  if (!S.detail || S.detail.id !== id) {
    leaveDetail();
    S.detail = { id, w: cached || null, chart: null, hovering: false, els: null, histLimit: 20 };
    buildDetail();
  }
  try {
    const d = await api('GET', `/api/watches/${id}`);
    if (!S.detail || S.detail.id !== id) return;
    S.detail.w = d.watch;
    if (d.status) S.status = d.status;
    updateDetail(false);
  } catch (e) {
    toast(e.message);
    if (e.status === 404) location.hash = '#/';
  }
}

function buildDetail() {
  S.view = 'detail';
  const D = S.detail;
  const E = {};
  E.thumb = h('div');
  E.name = h('h1', { class: 'hero-name' });
  E.badges = h('div', { class: 'meta' });
  E.price = h('div', { class: 'hero-price' });
  E.chg = h('div', { class: 'hero-chg' });
  E.when = h('div', { class: 'hero-when' });
  E.targetInfo = h('div', { class: 'hero-target' });
  E.chart = h('div', { class: 'chart', role: 'img', 'aria-label': '가격 변동 차트. 아래 표에서 모든 기록을 볼 수 있어요.' }, h('div', { class: 'chart-empty', hidden: true }));
  const seg = (list, cur, onPick, label) => {
    const box = h('div', { class: 'seg', role: 'group', 'aria-label': label });
    for (const [k, text] of list) {
      box.append(h('button', { type: 'button', 'aria-pressed': String(cur === k), text, onclick: (e) => { for (const b of box.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); onPick(k); } }));
    }
    return box;
  };
  E.buy = h('div', { class: 'buy-box' });
  E.stats = h('div', { class: 'stats' });
  E.target = h('input', { type: 'text', inputmode: 'numeric', class: 'input', placeholder: '예: 9900', 'aria-label': '목표가(원)' });
  E.targetClear = h('button', { class: 'btn ghost small', type: 'button', text: '지우기', onclick: () => saveWatch({ targetPrice: null }) });
  E.notify = h('input', { type: 'checkbox' });
  E.notify.addEventListener('change', () => saveWatch({ notifyDrop: E.notify.checked }));
  E.results = h('section', { class: 'card section', hidden: true });
  E.table = h('table', { class: 'hist' });
  E.more = h('button', { class: 'btn ghost small', type: 'button', onclick: () => { D.histLimit += 50; updateDetail(false); } });
  E.err = h('p', { class: 'err-box', hidden: true });
  D.els = E;
  fill($('#view'),
    h('div', { class: 'detail-top' }, h('a', { class: 'btn ghost small', href: '#/', text: '← 목록' })),
    h('section', { class: 'card hero' },
      h('div', { class: 'hero-head' }, E.thumb, h('div', { class: 'row-main' }, E.name, E.badges)),
      E.price, E.chg, E.when, E.targetInfo, E.err,
      h('div', { class: 'ctrl' },
        seg(RANGES.map(([k, l]) => [k, l]), S.range, (k) => { S.range = k; setPref('range', k); drawChart(true); updateStats(); }, '기간'),
        seg([['area', '라인'], ['candle', '캔들']], S.ctype, (k) => { S.ctype = k; setPref('ctype', k); drawChart(true); }, '차트 종류')),
      E.chart),
    E.buy,
    E.stats,
    h('section', { class: 'card section' },
      h('h3', { text: '알림 설정' }),
      h('form', { class: 'inline', onsubmit: (e) => { e.preventDefault(); saveWatch({ targetPrice: E.target.value.replace(/[^\d]/g, '') || null }); } },
        E.target, h('span', { class: 'muted', text: '원 이하' }), h('button', { class: 'btn small', type: 'submit', text: '저장' }), E.targetClear),
      h('label', { class: 'switch' }, E.notify, '가격이 내릴 때마다 알림 (같은 상품은 6시간에 한 번)'),
      h('p', { class: 'fine', text: '목표가에 닿으면 항상 알려드려요. 차트에 점선으로 표시돼요.' })),
    E.results,
    h('section', { class: 'card section' }, h('h3', { text: '가격 기록' }), E.table, E.more),
    h('div', { class: 'center' }, h('button', { class: 'btn danger small', type: 'button', text: '이 알림 삭제', onclick: removeWatch })),
    disclosure());
  window.scrollTo(0, 0);
  D.chart = new PriceChart(E.chart, onHover);
  if (D.w) updateDetail(true);
}

function onHover(info) {
  const D = S.detail;
  if (!D || !D.w) return;
  const st = stats(D.w);
  if (!info || st.price === null) { D.hovering = false; renderHero(); return; }
  D.hovering = true;
  const t = hoverText(info, st.price);
  D.els.price.textContent = t.price;
  D.els.chg.className = `hero-chg ${t.cls}`;
  D.els.chg.textContent = t.chg;
  D.els.when.textContent = t.when;
}

function renderHero() {
  const D = S.detail; const w = D.w; const E = D.els;
  const st = stats(w);
  E.price.textContent = won(st.price);
  if (st.price === null) { E.chg.className = 'hero-chg flat'; E.chg.textContent = w.status === 'not_found' ? '검색 결과에서 이 상품을 찾지 못했어요' : '가격을 찾는 중이에요'; } else if (!st.prevPrice) { E.chg.className = 'hero-chg flat'; E.chg.textContent = '아직 가격 변동이 없어요'; } else {
    E.chg.className = `hero-chg ${dir(st.change)}`;
    E.chg.textContent = `${arrow(st.change)} ${absWon(st.change)}원 (${pctStr(st.changePct)}) 직전 가격 대비`;
  }
  E.when.textContent = [st.changedAt ? `${ago(st.changedAt)} 변동` : null, w.lastFoundAt ? `${ago(w.lastFoundAt)} 확인` : null].filter(Boolean).join(' · ');
}

function drawChart(fit) {
  const D = S.detail;
  if (!D || !D.chart || !D.w) return;
  D.data = D.chart.setData(D.w, { range: S.range, type: S.ctype, fit });
}

const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat-l', text: label }), h('div', { class: 'stat-v', text: value }), h('div', { class: 'stat-s', text: sub || '' }));

function updateStats() {
  const D = S.detail; const w = D.w;
  const st = stats(w);
  const gap = st.price && st.minPrice ? st.price - st.minPrice : null;
  const rangeLabel = (RANGES.find(([k]) => k === S.range) || RANGES[2])[1];
  fill(D.els.stats,
    stat('역대 최저가', won(st.minPrice), st.minAt ? fmtDate(st.minAt, { time: false }) : ''),
    stat('역대 최고가', won(st.maxPrice), st.maxAt ? fmtDate(st.maxAt, { time: false }) : ''),
    stat('최저가보다', gap === null ? '–' : gap === 0 ? '지금이 최저가' : `${absWon(gap)}원 비쌈`, gap ? `+${((gap / st.minPrice) * 100).toFixed(1)}%` : ''),
    stat(`${rangeLabel} 평균`, D.data && D.data.avg ? won(D.data.avg) : '–', '시간 가중 평균'),
    stat('가격 변동', `${st.changes}회`, st.firstPrice ? `처음 ${won(st.firstPrice)}` : ''),
    stat('마지막 확인', ago(w.lastFoundAt), S.status ? `약 ${minutesText(S.status.cycleMin || 60)}마다 확인` : ''));
}

function updateDetail(fit) {
  const D = S.detail;
  if (!D || !D.w) return;
  const w = D.w; const E = D.els;
  const st = stats(w);
  E.thumb.replaceWith(E.thumb = thumb(w.image, w.name, 'lg'));
  E.name.textContent = displayName(w);
  fill(E.badges, ...badgesFor(w, st));
  if (!D.hovering) renderHero();
  if (w.targetPrice && st.price) {
    const gap = st.price - w.targetPrice;
    E.targetInfo.textContent = gap <= 0 ? `🎯 목표가 ${won(w.targetPrice)} 도달!` : `🎯 목표가 ${won(w.targetPrice)}까지 ${absWon(gap)}원 (${((gap / st.price) * 100).toFixed(1)}%) 더 내려야 해요`;
    E.targetInfo.hidden = false;
  } else E.targetInfo.hidden = true;
  E.err.hidden = w.status !== 'not_found';
  E.err.textContent = w.status === 'not_found' ? '쿠팡 검색 결과에서 이 상품을 여러 번 찾지 못했어요. 하루에 한 번만 다시 찾아봐요. 판매가 끝났거나 이름이 바뀌었을 수 있어요.' : '';
  drawChart(fit);
  fill(E.buy, buyLink(w.url, w.kind === 'keyword' ? '최저가 상품 쿠팡에서 보기' : '쿠팡에서 보기'), w.url ? disclosure() : null);
  updateStats();
  if (document.activeElement !== E.target) E.target.value = w.targetPrice ? String(w.targetPrice) : '';
  E.targetClear.hidden = !w.targetPrice;
  E.notify.checked = w.notifyDrop;
  if (w.kind === 'keyword') {
    E.results.hidden = false;
    fill(E.results, h('h3', { text: '지금 검색 결과' }),
      (w.results && w.results.length)
        ? h('div', { class: 'items' }, ...w.results.map((it) => itemRow(it, [
          h('a', { class: 'btn ghost small', href: it.url, target: '_blank', rel: 'sponsored noopener noreferrer', text: '보기' }),
          h('button', { class: 'btn small', type: 'button', text: '알림', onclick: () => addWatch({ kind: 'product', productId: it.productId, keyword: w.name }) }),
        ])))
        : h('p', { class: 'muted', text: '다음 확인 때 검색 결과가 보여요.' }));
  } else E.results.hidden = true;
  const rows = (w.history || []).slice().reverse();
  fill(E.table,
    h('thead', null, h('tr', null, h('th', { text: '일시' }), h('th', { class: 'r', text: '가격' }), h('th', { class: 'r', text: '변동' }))),
    h('tbody', null, ...rows.slice(0, D.histLimit).map((pt, i) => {
      const prev = rows[i + 1];
      const diff = prev ? pt.p - prev.p : null;
      return h('tr', null, h('td', { text: fmtShort(pt.t) }), h('td', { class: 'r', text: won(pt.p) }),
        h('td', { class: `r ${diff === null ? 'flat' : dir(diff)}`, text: diff === null ? '처음' : diff === 0 ? '–' : `${arrow(diff)} ${absWon(diff)}` }));
    })));
  if (!rows.length) fill(E.table, h('caption', { class: 'muted', text: '아직 기록이 없어요.' }));
  E.more.hidden = rows.length <= D.histLimit;
  E.more.textContent = `더 보기 (${rows.length - D.histLimit}개 더)`;
}

async function saveWatch(patch) {
  const D = S.detail;
  try {
    const r = await api('PATCH', `/api/watches/${D.id}`, patch);
    D.w = { ...D.w, ...r.watch, history: D.w.history, results: D.w.results };
    const i = S.watches.findIndex((x) => x.id === D.id);
    if (i >= 0) S.watches[i] = { ...S.watches[i], targetPrice: D.w.targetPrice, notifyDrop: D.w.notifyDrop };
    updateDetail(false);
    if (patch.targetPrice !== undefined) toast(patch.targetPrice ? `목표가 ${won(Number(patch.targetPrice))}을 저장했어요.` : '목표가를 지웠어요.');
  } catch (e) { toast(e.message); }
}

async function removeWatch() {
  if (!confirm('이 알림과 가격 기록 보기를 삭제할까요?')) return;
  try {
    await api('DELETE', `/api/watches/${S.detail.id}`);
    S.watches = S.watches.filter((x) => x.id !== S.detail.id);
    location.hash = '#/';
  } catch (e) { toast(e.message); }
}

// ---------- 특가 ----------
async function showDeals() {
  S.view = 'deals';
  const feeds = (S.config && S.config.feeds) || [{ key: 'goldbox', label: '오늘의 특가' }];
  const list = h('section', { class: 'card list', 'aria-live': 'polite' }, h('p', { class: 'muted pad', text: '불러오는 중…' }));
  const chips = h('div', { class: 'chips', role: 'tablist' }, ...feeds.map((f) => h('button', {
    class: 'chip', type: 'button', role: 'tab', 'aria-selected': String(f.key === S.feedKey), text: f.label,
    onclick: () => { S.feedKey = f.key; showDeals(); },
  })));
  fill($('#view'), chips, h('p', { class: 'fine top', text: (S.config && S.config.disclosure) || '' }), list);
  let feed = S.feeds[S.feedKey];
  if (!feed || Date.now() - feed.loadedAt > 5 * 60 * 1000) {
    try { feed = { ...(await api('GET', `/api/feed?key=${encodeURIComponent(S.feedKey)}`)), loadedAt: Date.now() }; S.feeds[S.feedKey] = feed; } catch (e) { fill(list, h('p', { class: 'err-box pad', text: e.message })); return; }
  }
  if (S.view !== 'deals') return;
  if (!feed.items.length) { fill(list, h('p', { class: 'muted pad', text: feed.note || '아직 목록이 없어요.' })); return; }
  fill(list, ...feed.items.map((it) => itemRow(it, [
    h('a', { class: 'btn ghost small', href: it.url, target: '_blank', rel: 'sponsored noopener noreferrer', text: '보기' }),
    h('button', { class: 'btn small', type: 'button', text: '알림', onclick: () => addWatch({ kind: 'product', productId: it.productId, keyword: it.name, feedKey: feed.key }) }),
  ])), feed.fetchedAt ? h('p', { class: 'muted center pad', text: `${ago(feed.fetchedAt)} 기준` }) : null);
}

// ---------- 알림(푸시) ----------
function b64uToBytes(s) {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function swReady() {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 4000))]);
}

async function refreshPush() {
  if (!S.config || !S.config.push || !S.config.vapidPublicKey) { S.push = 'unconfigured'; return; }
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) { S.push = isIos() && !standalone() ? 'ios-install' : 'unsupported'; return; }
  if (Notification.permission === 'denied') { S.push = 'denied'; return; }
  const reg = await swReady();
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  S.push = sub ? 'on' : 'off';
  if (sub) api('POST', '/api/push/subscribe', sub.toJSON()).catch(() => {}); // 서버 쪽 정보를 최신으로
}

async function enablePush() {
  try {
    if (S.push === 'ios-install') { toast('홈 화면에 추가한 앱에서 알림을 켤 수 있어요.'); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { S.push = perm === 'denied' ? 'denied' : 'off'; rerender(); toast('알림이 허용되지 않았어요.'); return; }
    const reg = await swReady();
    if (!reg) throw new Error('알림 준비에 실패했어요. 새로고침 후 다시 시도해 주세요.');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(S.config.vapidPublicKey) });
    await api('POST', '/api/push/subscribe', sub.toJSON());
    S.push = 'on';
    toast('알림을 켰어요. 가격이 내리면 알려드릴게요.');
    await loadMe();
  } catch (e) { toast(e.message || '알림을 켜지 못했어요.'); }
}

async function disablePush() {
  try {
    const reg = await swReady();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    S.push = 'off';
    toast('이 기기의 알림을 껐어요.');
    await loadMe();
  } catch (e) { toast(e.message); }
}

// ---------- 설정 ----------
function showSettings() {
  S.view = 'settings';
  const pushLine = {
    on: '켜져 있어요', off: '꺼져 있어요', denied: '휴대폰 설정에서 차단돼 있어요', 'ios-install': '홈 화면에 추가한 앱에서 켤 수 있어요',
    unsupported: '이 브라우저는 알림을 지원하지 않아요', unconfigured: '운영자가 아직 알림을 설정하지 않았어요', unknown: '확인 중',
  }[S.push];
  const night = h('input', { type: 'checkbox' });
  night.checked = Boolean(S.user && S.user.nightOk);
  night.addEventListener('change', async () => { try { await api('PATCH', '/api/me', { nightOk: night.checked }); S.user.nightOk = night.checked; toast(night.checked ? '밤에도 바로 알려드릴게요.' : '밤 알림은 아침 8시에 모아서 보내요.'); } catch (e) { toast(e.message); } });
  const codeBox = h('code', { class: 'code', text: '••••••••' });
  fill($('#view'),
    h('section', { class: 'card section' },
      h('h3', { text: '알림' }),
      h('p', null, '상태: ', h('b', { text: pushLine }), S.user && S.user.devices ? ` · 등록 기기 ${S.user.devices}대` : ''),
      h('div', { class: 'btn-row' },
        S.push === 'off' ? h('button', { class: 'btn', type: 'button', text: '알림 켜기', onclick: async () => { await enablePush(); showSettings(); } }) : null,
        S.push === 'on' ? h('button', { class: 'btn ghost', type: 'button', text: '테스트 알림 보내기', onclick: async () => { try { const r = await api('POST', '/api/push/test', {}); toast(r.sent ? '테스트 알림을 보냈어요.' : '보낼 기기가 없어요. 알림을 다시 켜 주세요.'); } catch (e) { toast(e.message); } } }) : null,
        S.push === 'on' ? h('button', { class: 'btn ghost', type: 'button', text: '이 기기 알림 끄기', onclick: async () => { await disablePush(); showSettings(); } }) : null),
      h('label', { class: 'switch' }, night, '밤 9시~아침 8시에도 바로 받기'),
      h('p', { class: 'fine', text: '꺼 두면 밤사이 알림은 아침 8시 이후에 모아서 보내요.' }),
      isIos() && !standalone() ? h('p', { class: 'fine', text: '아이폰: Safari 공유 버튼 → "홈 화면에 추가" 후 그 아이콘으로 열어야 알림을 받을 수 있어요.' }) : null),
    h('section', { class: 'card section' },
      h('h3', { text: '내 기기 코드' }),
      h('p', { class: 'fine', text: '회원가입 없이 이 기기에 목록이 저장돼요. 다른 기기(또는 홈 화면 앱)로 옮기려면 이 코드를 그 기기에 입력하세요. 다른 사람에게 알려주지 마세요.' }),
      codeBox,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost small', type: 'button', text: '코드 보기', onclick: () => { codeBox.textContent = S.token; } }),
        h('button', { class: 'btn ghost small', type: 'button', text: '복사', onclick: async () => { try { await navigator.clipboard.writeText(S.token); toast('복사했어요.'); } catch { codeBox.textContent = S.token; toast('코드를 길게 눌러 복사해 주세요.'); } } }),
        h('button', { class: 'btn ghost small', type: 'button', text: '다른 기기 코드 입력', onclick: enterCode }))),
    h('section', { class: 'card section' },
      h('h3', { text: '이 서비스' }),
      h('p', { class: 'fine', text: `${(S.config && S.config.appName) || '최저가 레이더'}는 쿠팡이 운영하는 서비스가 아니에요. 가격은 쿠팡 파트너스 API로 확인한 시점의 값이라 실제 결제 금액(쿠폰·카드 할인 등)과 다를 수 있어요.` }),
      S.config && S.config.mode === 'mock' ? h('p', { class: 'fine', text: '지금은 데모 모드예요 (가상 가격).' }) : null,
      disclosure(),
      h('p', null, h('a', { href: '/privacy.html', text: '개인정보 처리방침' })),
      h('button', { class: 'btn danger small', type: 'button', text: '내 데이터 모두 삭제', onclick: deleteAll })));
}

async function enterCode() {
  const code = prompt('다른 기기에서 복사한 코드를 붙여넣으세요');
  if (!code) return;
  const t = code.trim();
  if (!/^[\w-]{20,100}$/.test(t)) { toast('코드 형식이 올바르지 않아요.'); return; }
  const old = S.token;
  S.token = t;
  try {
    await api('GET', '/api/me?lite=1', undefined, true);
    setPref('token', t);
    await loadMe();
    await refreshPush();
    toast('목록을 불러왔어요.');
    location.hash = '#/';
  } catch {
    S.token = old;
    toast('코드가 맞지 않아요.');
  }
}

async function deleteAll() {
  if (!confirm('내 알림과 기기 정보를 모두 지울까요? 되돌릴 수 없어요.')) return;
  try {
    await disablePush().catch(() => {});
    await api('DELETE', '/api/me');
    setPref('token', null);
    S.token = null;
    await newSession();
    await loadMe();
    toast('모두 지웠어요.');
    location.hash = '#/';
  } catch (e) { toast(e.message); }
}

// ---------- 라우팅 ----------
function rerender() {
  if (S.view === 'home') showHome();
  else if (S.view === 'detail' && S.detail) {
    const fresh = S.watches.find((x) => x.id === S.detail.id);
    if (fresh && S.detail.w && fresh.changedAt !== S.detail.w.changedAt) showDetail(S.detail.id);
  } else if (S.view === 'settings') showSettings();
}

function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/w\/(\d+)/);
  if (m) showDetail(Number(m[1]));
  else {
    leaveDetail();
    if (hash.startsWith('#/deals')) showDeals();
    else if (hash.startsWith('#/settings')) showSettings();
    else showHome();
  }
  const tab = m ? 'home' : hash.startsWith('#/deals') ? 'deals' : hash.startsWith('#/settings') ? 'settings' : 'home';
  for (const a of document.querySelectorAll('.tabbar a')) a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false');
  $('#fab').hidden = Boolean(m) || tab !== 'home';
}

// ---------- 시작 ----------
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvent = e; if (S.view === 'home') showHome(); });
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
$('#fab').addEventListener('click', () => openAdd());

(async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // 알림을 눌렀을 때 이미 열려 있는 앱 화면을 그 상품으로 옮긴다
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open' && typeof e.data.url === 'string' && e.data.url.startsWith('/')) {
        location.hash = new URL(e.data.url, location.origin).hash || '#/';
      }
    });
  }
  try {
    S.config = await api('GET', '/api/config');
    document.title = S.config.appName;
    $('#app-name').textContent = S.config.appName;
    S.token = pref('token', null);
    if (!S.token) await newSession();
    await loadMe();
  } catch (e) {
    fill($('#view'), h('div', { class: 'card empty' }, h('h3', { text: '서버에 연결하지 못했어요' }), h('p', { text: e.message }), h('button', { class: 'btn', type: 'button', text: '다시 시도', onclick: () => location.reload() })));
    return;
  }
  // 다른 앱의 "공유"로 들어온 경우 (안드로이드 설치 앱)
  if (location.pathname === '/share') {
    const q = new URLSearchParams(location.search);
    const shared = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join(' ');
    history.replaceState(null, '', '/');
    route();
    if (shared) openAdd(shared, true);
  } else {
    route();
  }
  await refreshPush();
  if (S.view === 'home') showHome();
  setInterval(poll, 180 * 1000); // 무료 플랜의 DB 읽기 한도를 아끼려고 3분마다 (화면이 보일 때만)
  setInterval(() => { if (S.view === 'home') renderStatusLine(); }, 30 * 1000);
})();
