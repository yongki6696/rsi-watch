/* 오더허브 프론트엔드 (의존성 없음) */
'use strict';

// ===================== 공통 도우미 =====================
const ICONS = {
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/><path d="M3 9h18"/>',
  bell: '<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 003.4 0"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  refresh: '<path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  truck: '<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  phone: '<path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  ext: '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1118 0z"/><circle cx="12" cy="10" r="3"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/>',
  phoneDev: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L23 6H6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chat: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
};

function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', `ic ${cls}`.trim());
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

// null/false/빈 문자열은 건너뛰는 안전한 append (기본 Element.append 는 null 을 "null" 글자로 넣음)
function append(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pad2 = (n) => String(n).padStart(2, '0');
const won = (n) => (n === null || n === undefined || n === '' ? '' : `${Number(n).toLocaleString('ko-KR')}원`);

function fmtDT(iso, withYear = false) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const base = `${d.getMonth() + 1}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withYear ? `${d.getFullYear()}.${base}` : base;
}

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

function until(iso) {
  if (!iso) return '';
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return '곧';
  if (s < 3600) return `${Math.ceil(s / 60)}분 후`;
  return `${Math.round(s / 3600)}시간 후`;
}

function toast(msg, type = '') {
  const root = $('#toast-root');
  const el = h('div', { class: `toast ${type}` }, msg);
  root.append(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3200);
}

async function copyText(text, btn) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (btn) {
      btn.classList.add('done');
      btn.replaceChildren(icon('check', 'sm'));
      setTimeout(() => {
        btn.classList.remove('done');
        btn.replaceChildren(icon('copy', 'sm'));
      }, 1400);
    } else toast('복사했습니다');
  } catch {
    toast('복사하지 못했습니다', 'err');
  }
}

async function api(method, path, body) {
  const opts = { method, headers: { 'X-OrderHub': '1' }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('서버에 연결할 수 없습니다. 인터넷 연결을 확인해주세요.');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    S.authed = false;
    renderAuth(false);
    throw new Error('로그인이 필요합니다');
  }
  if (!res.ok) throw new Error((data && data.error) || `오류가 발생했습니다 (${res.status})`);
  return data;
}

// 버튼 로딩 처리
async function withBtn(btn, fn) {
  if (btn) {
    btn.disabled = true;
    btn.classList.add('loading');
  }
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'err');
    return undefined;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  }
}

function switchEl(checked, onchange, label) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked, e) });
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }), label ? h('span', null, label) : null);
}

function notice(type, ...content) {
  const ic = { info: 'info', warn: 'alert', err: 'alert', ok: 'check' }[type] || 'info';
  return h('div', { class: `notice ${type}` }, icon(ic, 'sm'), h('div', null, ...content));
}

// ===================== 상태 =====================
const S = {
  authed: false,
  meta: null,
  tab: 'new',
  q: '',
  store: '',
  page: 1,
  orders: [],
  total: 0,
  counts: {},
  selected: new Set(),
  sync: null,
  view: null,
  sheetOrderId: null,
  pushedSheet: false,
};

const STATUS = { NEW: '신규주문', PURCHASED: '발주완료', INVOICED: '송장입력', SHIPPED: '발송완료', DELIVERED: '배송완료', CANCELED: '취소', RETURNED: '반품' };
const CLAIM = { CANCEL: '취소요청', RETURN: '반품요청', EXCHANGE: '교환요청' };
const TABS = [
  ['new', '신규주문'],
  ['purchased', '발주완료'],
  ['shipped', '발송완료'],
  ['delivered', '배송완료'],
  ['claim', '취소·반품'],
  ['all', '전체'],
];

function connector(type) {
  return (S.meta?.connectors || []).find((c) => c.type === type) || { label: type, short: '?', color: '#888' };
}

function storeBadge(type, name) {
  const c = connector(type);
  return h('span', { class: 'store-badge' }, h('span', { class: 'mk', style: { '--c': c.color } }, c.short), h('span', { class: 'nm' }, name || c.label));
}

function statusBadge(status) {
  return h('span', { class: `st st-${status}` }, STATUS[status] || status);
}

function courierOptions(storeType, selected) {
  const list = (S.meta?.couriers || []).filter((c) => storeType === 'demo' || c[storeType] !== false);
  const opts = list.map((c) => h('option', { value: c.key, selected: c.key === selected ? 'selected' : null }, c.name));
  if (selected && selected.startsWith('CUSTOM:')) opts.push(h('option', { value: selected, selected: 'selected' }, `직접입력(${selected.slice(7)})`));
  return opts;
}

// ===================== 부팅 / 인증 =====================
async function boot() {
  registerSW();
  try {
    const st = await api('GET', '/api/auth/status');
    if (st.setupRequired) return renderAuth(true);
    if (!st.loggedIn) return renderAuth(false);
    S.authed = true;
    await startApp();
  } catch (e) {
    $('#app').replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, h('div', { class: 'brand-logo' }), h('h1', null, '연결 오류'), h('p', null, e.message), h('button', { class: 'btn primary block', onclick: () => location.reload() }, '다시 시도'))));
  }
}

function renderAuth(setup) {
  closeSheet(true);
  const pw = h('input', { class: 'input', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', placeholder: setup ? '새 비밀번호 (8자 이상)' : '비밀번호', required: true, minlength: setup ? 8 : null });
  const pw2 = setup ? h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '비밀번호 확인', required: true }) : null;
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, setup ? '시작하기' : '로그인');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        if (setup && pw.value !== pw2.value) return toast('비밀번호 확인이 일치하지 않습니다', 'err');
        await withBtn(btn, async () => {
          await api('POST', setup ? '/api/auth/setup' : '/api/auth/login', { password: pw.value });
          S.authed = true;
          await startApp();
        });
      },
    },
    pw,
    pw2,
    btn
  );
  $('#app').replaceChildren(
    h(
      'div',
      { class: 'auth' },
      h(
        'div',
        { class: 'auth-card' },
        h('div', { class: 'brand-logo' }),
        h('h1', null, setup ? '오더허브 시작하기' : '오더허브'),
        h('p', null, setup ? '이 서버의 관리자 비밀번호를 정해주세요. 주문자 개인정보가 보호됩니다.' : '스마트스토어·쿠팡·11번가 주문 관리'),
        form
      )
    )
  );
  setTimeout(() => pw.focus(), 50);
}

async function startApp() {
  S.meta = await api('GET', '/api/meta');
  renderShell();
  window.addEventListener('hashchange', route);
  if (!location.hash || location.hash === '#' || location.hash === '#/') location.replace('#/orders/new');
  route();
  refreshSync();
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshSync();
  }, 30000);
  setInterval(() => {
    if (document.visibilityState === 'visible' && S.view === 'orders' && !S.sheetOrderId && !isTyping()) loadOrders({ silent: true });
  }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshSync();
      if (S.view === 'orders' && !isTyping()) loadOrders({ silent: true });
    }
  });
}

function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
}

// ===================== 레이아웃 =====================
function renderShell() {
  const nav = h(
    'nav',
    { class: 'nav' },
    h('div', { class: 'nav-brand brand' }, h('span', { class: 'brand-logo' }), '오더허브'),
    h('a', { href: '#/orders/new', 'data-nav': 'orders' }, icon('box'), '주문', h('span', { class: 'badge hidden', id: 'navBadge' })),
    h('a', { href: '#/inquiries', 'data-nav': 'inquiries' }, icon('chat'), '문의', h('span', { class: 'badge hidden', id: 'inqBadge' })),
    h('a', { href: '#/stores', 'data-nav': 'stores' }, icon('store'), '스토어', h('span', { class: 'badge hidden', id: 'storeBadge' }, '!')),
    h('a', { href: '#/notify', 'data-nav': 'notify' }, icon('bell'), '알림'),
    h('a', { href: '#/settings', 'data-nav': 'settings' }, icon('sliders'), '설정')
  );
  const syncBtn = h('button', { class: 'icon-btn', id: 'syncBtn', title: '지금 수집', 'aria-label': '지금 주문 수집', onclick: () => syncNow() }, icon('refresh'));
  const top = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }), '오더허브'),
    h('div', { class: 'spacer' }),
    h('a', { class: 'sync-pill', id: 'syncPill', href: '#/stores' }, h('span', { class: 'dot' }), '불러오는 중'),
    syncBtn
  );
  $('#app').replaceChildren(h('div', { class: 'shell' }, top, nav, h('main', { class: 'view', id: 'view' })));
}

function setNav(name) {
  S.view = name;
  for (const a of $$('.nav a')) a.classList.toggle('active', a.dataset.nav === name);
}

function route() {
  if (!S.authed) return;
  const hash = location.hash || '#/orders/new';
  let m;
  if ((m = hash.match(/^#\/order\/(\d+)$/))) {
    if (S.view !== 'orders') renderOrders(S.tab);
    openOrder(Number(m[1]));
    return;
  }
  closeSheet(true);
  S.pushedSheet = false;
  if ((m = hash.match(/^#\/orders(?:\/(\w+))?$/))) return renderOrders(m[1] || 'new');
  if (hash === '#/inquiries') return renderInquiries();
  if (hash === '#/stores') return renderStores();
  if (hash === '#/notify') return renderNotify();
  if (hash === '#/settings') return renderSettings();
  location.replace('#/orders/new');
}

// ===================== 수집 상태 =====================
async function refreshSync() {
  try {
    S.sync = await api('GET', '/api/sync/status');
    paintSync();
  } catch {}
}

function paintSync() {
  const pill = $('#syncPill');
  if (!pill || !S.sync) return;
  const st = S.sync;
  const errs = st.stores.filter((s) => s.enabled && s.last_error);
  const active = st.stores.filter((s) => s.enabled);
  let dotCls = 'dot';
  let text;
  if (st.running) {
    dotCls += ' run';
    text = '주문 수집 중…';
  } else if (!active.length) {
    dotCls += ' err';
    text = '스토어를 연결해주세요';
  } else if (errs.length) {
    dotCls += ' err';
    text = `수집 오류 ${errs.length}곳`;
  } else {
    text = `${st.intervalMin}분마다 자동수집 · ${st.lastRunAt ? ago(st.lastRunAt) : '대기 중'}`;
  }
  pill.replaceChildren(h('span', { class: dotCls }), text);
  pill.title = st.nextRunAt ? `다음 수집: ${fmtDT(st.nextRunAt)} (${until(st.nextRunAt)})` : '';
  const ib = $('#inqBadge');
  if (ib) {
    ib.textContent = String(st.inquiriesOpen || 0);
    ib.classList.toggle('hidden', !st.inquiriesOpen);
  }
  const sb = $('#storeBadge');
  if (sb) sb.classList.toggle('hidden', !(errs.length || !active.length));
  const btn = $('#syncBtn');
  if (btn) btn.classList.toggle('spin', !!st.running);
}

async function syncNow(storeId) {
  const btn = $('#syncBtn');
  btn?.classList.add('spin');
  try {
    const r = await api('POST', '/api/sync', storeId ? { storeId } : {});
    const parts = [];
    if (r.newOrders) parts.push(`신규주문 ${r.newOrders}건`);
    if (r.claims) parts.push(`클레임 ${r.claims}건`);
    if (r.canceled) parts.push(`취소 ${r.canceled}건`);
    if (r.inquiries) parts.push(`문의 ${r.inquiries}건`);
    if (r.errors) toast(`수집 오류 ${r.errors}곳 - 스토어 화면에서 확인하세요`, 'err');
    else toast(parts.length ? `수집 완료: ${parts.join(', ')}` : r.stores.length ? '수집 완료: 새 주문 없음' : '연결된 스토어가 없습니다', parts.length ? 'ok' : '');
    await refreshSync();
    if (S.view === 'orders') await loadOrders({ silent: true });
    if (S.view === 'stores') await renderStores();
    if (S.view === 'inquiries') await renderInquiries();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn?.classList.remove('spin');
  }
}

function paintCounts() {
  const c = S.counts || {};
  for (const [key] of TABS) {
    const el = $(`#tab-${key} .n`);
    if (el) {
      const n = key === 'claim' ? c.claimOpen || 0 : c[key] || 0;
      el.textContent = n ? String(n) : '';
      el.classList.toggle('hot', key === 'claim' && n > 0);
    }
  }
  const pending = (c.new || 0) + (c.claimOpen || 0);
  const nb = $('#navBadge');
  if (nb) {
    nb.textContent = String(pending);
    nb.classList.toggle('hidden', !pending);
  }
  document.title = c.new ? `(${c.new}) 오더허브` : '오더허브';
  try {
    if (navigator.setAppBadge) c.new ? navigator.setAppBadge(c.new) : navigator.clearAppBadge();
  } catch {}
}

// ===================== 주문 목록 =====================
let searchTimer = null;

function renderOrders(tab) {
  const changedTab = S.tab !== tab || S.view !== 'orders';
  if (!changedTab && $('#orderList')) {
    // 같은 탭으로 돌아온 경우(상세 닫기 등): 스크롤 유지하고 조용히 새로고침
    loadOrders({ silent: true });
    return;
  }
  S.tab = tab;
  setNav('orders');
  S.selected.clear();
  const view = $('#view');
  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    TABS.map(([key, label]) =>
      h('button', { class: `tab ${key === tab ? 'active' : ''}`, id: `tab-${key}`, role: 'tab', onclick: () => (location.hash = `#/orders/${key}`) }, label, h('span', { class: 'n' }))
    )
  );
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: '주문 검색 (이름·전화·주문번호)',
    value: S.q,
    oninput: (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.q = e.target.value;
        loadOrders();
      }, 300);
    },
  });
  const storeSel = h(
    'select',
    {
      class: 'input',
      'aria-label': '스토어 필터',
      onchange: (e) => {
        S.store = e.target.value;
        loadOrders();
      },
    },
    h('option', { value: '' }, '전체 스토어')
  );
  api('GET', '/api/stores')
    .then((r) => {
      for (const s of r.stores) append(storeSel, h('option', { value: s.id, selected: String(s.id) === String(S.store) ? 'selected' : null }, s.name));
    })
    .catch(() => {});
  const moreBtn = h('button', { class: 'icon-btn', title: '송장 일괄등록 / 엑셀', 'aria-label': '더보기', onclick: () => openToolsMenu() }, icon('list'));
  const toolbar = h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search', 'sm'), search), storeSel, moreBtn);
  view.replaceChildren(tabs, toolbar, h('div', { id: 'bulkbar' }), h('div', { class: 'list', id: 'orderList' }), h('div', { id: 'moreRow' }));
  paintCounts();
  loadOrders();
}

async function loadOrders({ silent = false, append: more = false } = {}) {
  if (!more) S.page = 1;
  const list = $('#orderList');
  if (!list) return;
  if (!silent && !more) list.replaceChildren(h('div', { class: 'empty' }, '불러오는 중…'));
  try {
    const qs = new URLSearchParams({ tab: S.tab, page: S.page, limit: 50 });
    if (S.q) qs.set('q', S.q);
    if (S.store) qs.set('store', S.store);
    const r = await api('GET', `/api/orders?${qs}`);
    S.counts = r.counts;
    S.total = r.total;
    S.orders = more ? S.orders.concat(r.orders) : r.orders;
    // 사라진 주문은 선택 해제
    const ids = new Set(S.orders.map((o) => o.id));
    for (const id of [...S.selected]) if (!ids.has(id)) S.selected.delete(id);
    paintCounts();
    paintList();
  } catch (e) {
    if (!silent) list.replaceChildren(h('div', { class: 'empty' }, h('b', null, '불러오지 못했습니다'), e.message));
  }
}

function paintList() {
  const list = $('#orderList');
  if (!list) return;
  if (!S.orders.length) {
    const msgs = {
      new: ['🎉', '처리할 신규주문이 없습니다', '새 주문이 들어오면 알림으로 알려드릴게요.'],
      purchased: ['📦', '송장 입력을 기다리는 주문이 없습니다', '신규주문에서 [발주완료]를 누르면 이곳으로 옵니다.'],
      shipped: ['🚚', '발송완료된 주문이 없습니다', ''],
      delivered: ['✅', '배송완료된 주문이 없습니다', ''],
      claim: ['🙂', '취소·반품·교환 주문이 없습니다', ''],
      all: ['🗂️', '주문이 없습니다', '스토어를 연결하면 주문을 자동으로 수집합니다.'],
    };
    const [em, t, d] = msgs[S.tab] || msgs.all;
    const noStores = S.sync && !S.sync.stores.length;
    list.replaceChildren(
      h(
        'div',
        { class: 'empty', style: { gridColumn: '1 / -1' } },
        h('div', { class: 'big' }, em),
        h('b', null, S.q ? '검색 결과가 없습니다' : t),
        S.q ? '' : noStores ? '먼저 스토어를 연결해주세요.' : d,
        noStores ? h('div', { style: { marginTop: '14px' } }, h('a', { class: 'btn primary', href: '#/stores' }, icon('plus', 'sm'), '스토어 연결하기')) : null
      )
    );
  } else {
    list.replaceChildren(...S.orders.map(orderCard));
  }
  const moreRow = $('#moreRow');
  if (moreRow) {
    moreRow.replaceChildren(
      S.orders.length < S.total
        ? h('div', { class: 'more-row' }, h('button', { class: 'btn', onclick: (e) => withBtn(e.currentTarget, () => ((S.page += 1), loadOrders({ append: true }))) }, `더 보기 (${S.orders.length}/${S.total})`))
        : ''
    );
  }
  paintBulkbar();
}

function orderFlags(o) {
  const f = [];
  if (o.claim && o.status !== 'CANCELED' && o.status !== 'RETURNED') f.push(h('span', { class: 'chip red' }, icon('alert', 'sm'), CLAIM[o.claim]));
  if (o.address_changed) f.push(h('span', { class: 'chip orange' }, icon('pin', 'sm'), '배송지 변경'));
  if (['NEW', 'PURCHASED', 'INVOICED'].includes(o.status)) {
    if (o.status !== 'NEW' && !o.market_confirmed) f.push(h('span', { class: 'chip' }, '마켓 발주확인 전'));
    if (o.ship_due) {
      const left = new Date(o.ship_due).getTime() - Date.now();
      if (left < 0) f.push(h('span', { class: 'chip red' }, `발송기한 지남 ${fmtDT(o.ship_due).split(' ')[0]}`));
      else if (left < 24 * 3600000) f.push(h('span', { class: 'chip orange' }, `발송기한 ${fmtDT(o.ship_due)}`));
    }
    if (o.customs_code) f.push(h('span', { class: 'chip violet' }, '통관부호'));
  }
  if (o.status === 'INVOICED' && !o.dispatch_error) f.push(h('span', { class: 'chip violet' }, '송장 미전송'));
  return f;
}

function itemSummary(o) {
  const items = o.items || [];
  const first = items[0];
  if (!first) return '';
  return h(
    'div',
    { class: 'order-prod' },
    first.product_name,
    first.option_name ? h('span', { class: 'opt' }, ` · ${first.option_name}`) : '',
    h('span', { class: 'opt' }, ` ×${first.quantity}`),
    items.length > 1 ? h('span', { class: 'opt' }, ` 외 ${items.length - 1}건`) : ''
  );
}

function orderCard(o) {
  const selected = S.selected.has(o.id);
  const urgent = (o.claim && ['PURCHASED', 'INVOICED'].includes(o.status)) || o.address_changed;
  const card = h('article', { class: `card order ${selected ? 'selected' : ''} ${urgent ? 'urgent' : ''}`, 'data-id': o.id });
  const cb = h('input', {
    type: 'checkbox',
    checked: selected,
    'aria-label': '선택',
    onchange: (e) => {
      if (e.target.checked) S.selected.add(o.id);
      else S.selected.delete(o.id);
      card.classList.toggle('selected', e.target.checked);
      paintBulkbar();
    },
  });
  const top = h('div', { class: 'order-top' }, h('label', { class: 'check' }, cb), storeBadge(o.store_type, o.store_name), statusBadge(o.status), h('span', { class: 'time', title: fmtDT(o.paid_at, true) }, `${fmtDT(o.paid_at || o.created_at)} · ${ago(o.paid_at || o.created_at)}`));
  const body = h(
    'div',
    { class: 'order-body', onclick: () => openOrderNav(o.id), role: 'button', tabindex: '0' },
    h('div', { class: 'order-who' }, h('b', null, o.receiver_name || o.orderer_name || '(이름 없음)'), h('span', null, o.receiver_phone || '')),
    itemSummary(o),
    h('div', { class: 'order-addr' }, [o.address1, o.address2].filter(Boolean).join(' ')),
    h('div', { class: 'flags' }, orderFlags(o))
  );
  const foot = h('div', { class: 'order-foot' }, h('span', { class: 'amount' }, won(o.total_amount)));
  const actions = h('div', { class: 'actions' });
  if (o.status === 'NEW') {
    append(actions, 
      h('button', { class: 'btn sm', onclick: () => openOrderNav(o.id) }, '상세'),
      h('button', { class: 'btn sm primary', onclick: (e) => withBtn(e.currentTarget, () => doPurchase([o.id])) }, icon('check', 'sm'), '발주완료')
    );
    append(foot, actions);
    append(card, top, body, foot);
  } else if (o.status === 'PURCHASED' || o.status === 'INVOICED') {
    const sel = h('select', { class: 'input', 'aria-label': '택배사' }, courierOptions(o.store_type, o.courier_key || S.meta.settings.defaultCourier));
    const inp = h('input', { class: 'input mono', inputmode: 'numeric', placeholder: '송장번호', value: o.tracking_no || '', 'aria-label': '송장번호' });
    const sendBtn = h('button', { class: 'btn primary', onclick: (e) => withBtn(e.currentTarget, () => doInvoice(o.id, sel.value, inp.value, true)) }, icon('send', 'sm'), '발송');
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendBtn.click();
    });
    const extra = o.dispatch_error ? h('div', { class: 'err-line' }, `발송 실패: ${o.dispatch_error}`) : null;
    append(card, top, body, h('div', { class: 'quick-inv' }, sel, inp, sendBtn), extra, h('div', { class: 'order-foot' }, h('span', { class: 'amount' }, won(o.total_amount)), o.supplier ? h('span', { class: 'muted small' }, `공급처 ${o.supplier}`) : ''));
  } else if (o.status === 'SHIPPED' || o.status === 'DELIVERED') {
    append(foot, h('span', { class: 'inv-line' }, icon('truck', 'sm'), h('b', null, courierNameOf(o.courier_key)), h('span', { class: 'mono' }, o.tracking_no || '')));
    append(card, top, body, foot);
  } else {
    append(foot, h('span', { class: 'muted small' }, o.market_status || ''));
    append(card, top, body, foot);
  }
  return card;
}

function courierNameOf(key) {
  if (!key) return '';
  if (key.startsWith('CUSTOM:')) return `직접입력(${key.slice(7)})`;
  return (S.meta?.couriers || []).find((c) => c.key === key)?.name || key;
}

function paintBulkbar() {
  const bar = $('#bulkbar');
  if (!bar) return;
  const n = S.selected.size;
  if (!n) return bar.replaceChildren();
  const ids = [...S.selected];
  const selOrders = S.orders.filter((o) => S.selected.has(o.id));
  const btns = [];
  if (selOrders.some((o) => o.status === 'NEW')) {
    btns.push(h('button', { class: 'btn primary', onclick: (e) => withBtn(e.currentTarget, () => doPurchase(ids.filter((id) => selOrders.find((o) => o.id === id)?.status === 'NEW'))) }, '발주완료'));
    btns.push(h('button', { class: 'btn', onclick: (e) => withBtn(e.currentTarget, () => doConfirm(ids)) }, '마켓 발주확인'));
  }
  if (selOrders.some((o) => o.status === 'INVOICED')) {
    btns.push(h('button', { class: 'btn ok', onclick: (e) => withBtn(e.currentTarget, () => doDispatch(ids.filter((id) => selOrders.find((o) => o.id === id)?.status === 'INVOICED'))) }, '송장 전송(발송처리)'));
  }
  btns.push(h('button', { class: 'btn', onclick: () => downloadCsv(ids) }, icon('download', 'sm'), 'CSV'));
  btns.push(
    h(
      'button',
      {
        class: 'btn ghost',
        style: { color: 'inherit' },
        onclick: () => {
          S.selected.clear();
          paintList();
        },
      },
      '해제'
    )
  );
  const allBtn = h(
    'button',
    {
      class: 'btn ghost',
      style: { color: 'inherit' },
      onclick: () => {
        S.orders.forEach((o) => S.selected.add(o.id));
        paintList();
      },
    },
    '전체선택'
  );
  bar.replaceChildren(h('div', { class: 'bulkbar' }, h('b', null, `${n}건 선택`), allBtn, ...btns));
}

function showResults(results, okMsg) {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const warn = ok.filter((r) => r.warning);
  if (bad.length) toast(`${ok.length ? `${ok.length}건 ${okMsg}, ` : ''}${bad.length}건 실패\n${bad.map((b) => b.message).slice(0, 3).join('\n')}`, 'err');
  else if (warn.length) toast(`${ok.length}건 ${okMsg}\n주의: ${warn[0].warning}`, 'err');
  else toast(`${ok.length}건 ${okMsg}`, 'ok');
}

async function afterAction() {
  await loadOrders({ silent: true });
  if (S.sheetOrderId) await openOrder(S.sheetOrderId, { refresh: true });
}

async function doPurchase(ids, info) {
  if (!ids.length) return;
  const r = await api('POST', '/api/orders/purchase', { ids, ...(info || {}) });
  showResults(r.results, '발주완료 처리');
  ids.forEach((id) => S.selected.delete(id));
  await afterAction();
}

async function doConfirm(ids) {
  const r = await api('POST', '/api/orders/confirm', { ids });
  showResults(r.results, '마켓 발주확인');
  await afterAction();
}

async function doDispatch(ids) {
  const r = await api('POST', '/api/orders/dispatch', { ids });
  showResults(r.results, '발송처리 완료');
  ids.forEach((id) => S.selected.delete(id));
  await afterAction();
}

async function doInvoice(id, courierKey, trackingNo, dispatch) {
  if (!String(trackingNo).trim()) throw new Error('송장번호를 입력해주세요');
  const r = await api('POST', `/api/orders/${id}/invoice`, { courierKey, trackingNo, dispatch });
  toast(r.message, r.ok ? 'ok' : 'err');
  await afterAction();
}

function downloadCsv(ids) {
  const qs = new URLSearchParams();
  if (ids && ids.length) qs.set('ids', ids.join(','));
  else {
    qs.set('tab', S.tab);
    if (S.store) qs.set('store', S.store);
    if (S.q) qs.set('q', S.q);
  }
  const a = h('a', { href: `/api/orders/export.csv?${qs}`, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

function openToolsMenu() {
  openSheet('도구', (body, close) => {
    append(body, 
      h(
        'div',
        { class: 'sec' },
        h('div', { class: 'sec-h' }, icon('upload', 'sm'), '송장 일괄등록'),
        h('p', { class: 'muted small', style: { margin: '0 0 10px' } }, '공급처에서 받은 송장번호를 엑셀에서 복사해 붙여넣어 한 번에 등록·발송처리합니다.'),
        h('button', { class: 'btn primary block', onclick: () => (close(), openBulkInvoice()) }, '송장 일괄등록 열기')
      ),
      h(
        'div',
        { class: 'sec' },
        h('div', { class: 'sec-h' }, icon('download', 'sm'), '엑셀(CSV) 다운로드'),
        h('p', { class: 'muted small', style: { margin: '0 0 10px' } }, `현재 탭(${TABS.find((t) => t[0] === S.tab)?.[1]})의 주문을 받는분·주소·상품 정보와 함께 내려받습니다. 공급처 발주서로 활용하세요.`),
        h('button', { class: 'btn block', onclick: () => (close(), downloadCsv()) }, 'CSV 다운로드')
      )
    );
  });
}

// ===================== 송장 일괄등록 =====================
function parseInvoiceText(text, defaultCourier) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim().replace(/^="?|"$/g, '').replace(/^"|"$/g, '').trim());
    if (cells.length < 2) continue;
    if (/주문/.test(cells[0]) && !/\d{5,}/.test(cells[0])) continue; // 머리글
    if (cells.length === 2) rows.push({ orderNo: cells[0], courierKey: defaultCourier, courier: '', trackingNo: cells[1] });
    else rows.push({ orderNo: cells[0], courier: cells[1], trackingNo: cells[2] });
  }
  return rows;
}

function openBulkInvoice() {
  openSheet('송장 일괄등록', (body) => {
    const courierSel = h('select', { class: 'input' }, courierOptions('demo', S.meta.settings.defaultCourier));
    const ta = h('textarea', { class: 'input', placeholder: '주문번호[탭]택배사[탭]송장번호\n2026112212345678\tCJ대한통운\t123456789012\n\n또는 2열: 주문번호[탭]송장번호 (위에서 고른 기본 택배사 사용)' });
    const file = h('input', {
      type: 'file',
      accept: '.csv,.txt,text/csv,text/plain',
      class: 'hidden',
      onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const buf = await f.arrayBuffer();
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('\uFFFD')) text = new TextDecoder('euc-kr').decode(buf);
        ta.value = text.replace(/^\uFEFF/, '');
        preview();
      },
    });
    const info = h('div', { class: 'muted small', style: { margin: '6px 0 12px' } });
    const report = h('ul', { class: 'report' });
    const preview = () => {
      const rows = parseInvoiceText(ta.value, courierSel.value);
      info.textContent = rows.length ? `${rows.length}건 인식됨` : '';
    };
    ta.addEventListener('input', preview);
    const run = (dispatch) => async (e) =>
      withBtn(e.currentTarget, async () => {
        const rows = parseInvoiceText(ta.value, courierSel.value);
        if (!rows.length) throw new Error('인식된 송장이 없습니다. 형식을 확인해주세요.');
        const r = await api('POST', '/api/orders/invoices/bulk', { rows, dispatch });
        const ok = r.report.filter((x) => x.ok).length;
        report.replaceChildren(...r.report.map((x) => h('li', null, h('span', { class: x.ok ? 'ok' : 'bad' }, x.ok ? '✓' : '✕'), h('span', { class: 'mono' }, x.orderNo), h('span', { class: 'muted' }, x.message))));
        toast(`${ok}/${r.report.length}건 ${dispatch ? '발송처리' : '저장'} 완료`, ok === r.report.length ? 'ok' : 'err');
        loadOrders({ silent: true });
      });
    append(body, 
      h(
        'div',
        { class: 'sec' },
        notice('info', '엑셀에서 ', h('b', null, '주문번호 · 택배사 · 송장번호'), ' 3개 열을 복사해 붙여넣으세요. 오더허브에서 받은 CSV의 주문번호(또는 상품주문번호)를 그대로 쓰면 됩니다.'),
        h('div', { class: 'field' }, h('span', null, '기본 택배사 (2열 형식일 때)'), courierSel),
        ta,
        info,
        h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => file.click() }, icon('upload', 'sm'), 'CSV 파일 선택'), file),
        h('div', { class: 'btn-row', style: { marginTop: '12px' } }, h('button', { class: 'btn', onclick: run(false) }, '송장만 저장'), h('button', { class: 'btn primary', style: { flex: '1' }, onclick: run(true) }, icon('send', 'sm'), '저장 후 발송처리')),
        report
      )
    );
  });
}

// ===================== 시트(모달) =====================
let sheetCleanup = null;

function openSheet(title, build, { onClose } = {}) {
  closeSheet(true);
  const root = $('#sheet-root');
  const body = h('div', { class: 'sheet-body' });
  const close = () => {
    closeSheet(true);
    onClose?.();
  };
  const head = h('div', { class: 'sheet-head' }, h('h3', null, title), h('button', { class: 'icon-btn', 'aria-label': '닫기', onclick: close }, icon('x')));
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, head, body);
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e) => e.target === backdrop && close() }, sheet);
  root.replaceChildren(backdrop);
  document.body.style.overflow = 'hidden';
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  sheetCleanup = () => document.removeEventListener('keydown', onKey);
  build(body, close, head);
  return { body, close, head };
}

function closeSheet(silent) {
  const root = $('#sheet-root');
  if (root && root.firstChild) root.replaceChildren();
  document.body.style.overflow = '';
  sheetCleanup?.();
  sheetCleanup = null;
  S.sheetOrderId = null;
}

// ===================== 주문 상세 =====================
function kv(label, value, { copy = true, strong = false, href } = {}) {
  const v = value === null || value === undefined || value === '' ? null : String(value);
  const valueEl = h('div', { class: `v ${strong ? 'strong' : ''}` }, v ? (href ? h('a', { href }, v) : v) : h('span', { class: 'muted' }, '-'));
  const btn = v && copy ? h('button', { class: 'copy', 'aria-label': `${label} 복사`, onclick: (e) => copyText(v, e.currentTarget) }, icon('copy', 'sm')) : h('span');
  return h('div', { class: 'kv' }, h('div', { class: 'k' }, label), valueEl, btn);
}

function purchaseText(o) {
  const lines = [
    `받는분: ${o.receiver_name || ''}`,
    `연락처: ${o.receiver_phone || ''}${o.receiver_phone2 ? ` / ${o.receiver_phone2}` : ''}`,
    `우편번호: ${o.zipcode || ''}`,
    `주소: ${[o.address1, o.address2].filter(Boolean).join(' ')}`,
  ];
  if (o.delivery_memo) lines.push(`배송메모: ${o.delivery_memo}`);
  if (o.customs_code) lines.push(`개인통관고유부호: ${o.customs_code}`);
  for (const i of o.items) {
    if (['CANCELED', 'RETURNED'].includes(i.market_state)) continue;
    lines.push(`상품: ${i.product_name}${i.option_name ? ` / ${i.option_name}` : ''} / ${i.quantity}개`);
  }
  return lines.join('\n');
}

function openOrderNav(id) {
  S.pushedSheet = true;
  location.hash = `#/order/${id}`;
}

async function openOrder(id, { refresh = false } = {}) {
  let o;
  try {
    o = await api('GET', `/api/orders/${id}`);
  } catch (e) {
    toast(e.message, 'err');
    if (!refresh) location.hash = `#/orders/${S.tab}`;
    return;
  }
  const scrollTop = refresh ? $('.sheet-body')?.scrollTop : 0;
  const { body } = openSheet(`${connector(o.store_type).label} 주문 ${o.order_no || ''}`, (b) => renderOrderDetail(b, o), {
    onClose: () => {
      if (!location.hash.startsWith('#/order/')) return;
      if (S.pushedSheet) {
        S.pushedSheet = false;
        history.back();
      } else location.replace(`#/orders/${S.tab}`);
    },
  });
  S.sheetOrderId = o.id;
  if (refresh && scrollTop) body.scrollTop = scrollTop;
}

function renderOrderDetail(body, o) {
  const open = ['NEW', 'PURCHASED', 'INVOICED'].includes(o.status);

  // 상단 요약
  append(body, 
    h(
      'div',
      { class: 'sec' },
      h('div', { class: 'order-top' }, storeBadge(o.store_type, o.store_name), statusBadge(o.status), h('span', { class: 'time' }, fmtDT(o.paid_at || o.created_at, true))),
      h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: '10px' } }, h('b', { style: { fontSize: '19px' } }, o.receiver_name || o.orderer_name || ''), h('b', { class: 'amount', style: { fontSize: '18px' } }, won(o.total_amount))),
      h('div', { class: 'flags', style: { marginTop: '8px' } }, orderFlags(o))
    )
  );

  // 경고
  if (o.claim && open)
    append(
      body,
      notice(
        'err',
        h('b', null, `${CLAIM[o.claim]} 접수됨. `),
        o.status === 'NEW' ? '발주하지 말고 마켓 셀러센터에서 요청을 처리하세요. ' : '이미 발주한 주문입니다. 공급처 주문 취소 가능 여부를 확인하고 셀러센터에서 처리하세요. ',
        h(
          'button',
          {
            class: 'btn xs',
            onclick: (e) =>
              withBtn(e.currentTarget, async () => {
                if (!confirm('마켓에서 취소된 것을 확인했나요?\n오더허브 목록에서 취소로 표시합니다. (마켓에는 아무것도 전송하지 않습니다)')) return;
                await api('POST', `/api/orders/${o.id}/cancel-local`);
                toast('취소된 주문으로 표시했습니다');
                await afterAction();
              }),
          },
          '취소된 주문으로 표시'
        )
      )
    );
  if (o.status === 'CANCELED') append(body, notice('err', h('b', null, '취소된 주문입니다. '), o.purchased_at ? '공급처 발주를 취소했는지 꼭 확인하세요.' : ''));
  if (o.address_changed)
    append(body, 
      notice(
        'warn',
        h('b', null, '구매자가 배송지를 변경했습니다. '),
        '아래 주소로 다시 확인하세요. ',
        h('button', { class: 'btn xs', onclick: (e) => withBtn(e.currentTarget, async () => (await api('POST', `/api/orders/${o.id}/update`, { clearAddressChanged: true }), afterAction())) }, '확인함')
      )
    );
  if (o.dispatch_error) append(body, notice('err', h('b', null, '발송처리 실패: '), o.dispatch_error));

  // 받는 분
  const copyAllBtn = h('button', { class: 'btn sm primary', onclick: () => copyText(purchaseText(o)) }, icon('clipboard', 'sm'), '발주정보 전체복사');
  append(body, 
    h(
      'div',
      { class: 'sec' },
      h('div', { class: 'sec-h' }, '받는 분', h('span', { class: 'right' }, copyAllBtn)),
      kv('이름', o.receiver_name, { strong: true }),
      kv('연락처', o.receiver_phone, { href: o.receiver_phone ? `tel:${o.receiver_phone.replace(/[^0-9+]/g, '')}` : null }),
      o.receiver_phone2 ? kv('연락처2', o.receiver_phone2) : null,
      kv('우편번호', o.zipcode),
      kv('주소', o.address1),
      kv('상세주소', o.address2),
      kv('배송메모', o.delivery_memo),
      o.customs_code ? kv('통관부호', o.customs_code, { strong: true }) : null
    )
  );

  // 상품
  append(body, 
    h(
      'div',
      { class: 'sec' },
      h('div', { class: 'sec-h' }, `상품 ${o.items.length}건`),
      o.items.map((i) =>
        h(
          'div',
          { class: 'item-row' },
          h('div', { class: 'nm' }, i.product_name, ' ', h('button', { class: 'btn xs ghost', onclick: () => copyText(i.product_name) }, icon('copy', 'sm'))),
          i.option_name ? h('div', { class: 'meta' }, `옵션: ${i.option_name}`) : null,
          h(
            'div',
            { class: 'meta' },
            h('span', null, `수량 ${i.quantity}개`),
            i.amount !== null ? h('span', null, won(i.amount)) : null,
            i.product_code ? h('span', null, `코드 ${i.product_code}`) : null,
            h('span', { class: ['CANCELED', 'RETURNED'].includes(i.market_state) ? 'chip red' : i.claim ? 'chip red' : 'chip' }, i.market_status || i.market_state)
          ),
          h('div', { class: 'meta muted' }, `상품주문번호 ${i.item_key}`)
        )
      )
    )
  );

  // 발주 정보
  if (open || o.supplier || o.cost) {
    const supplier = h('input', { class: 'input', placeholder: '예) 도매꾹, 오너클랜', value: o.supplier || '' });
    const supNo = h('input', { class: 'input', placeholder: '공급처 주문번호', value: o.supplier_order_no || '' });
    const cost = h('input', { class: 'input mono', inputmode: 'numeric', placeholder: '매입가(원)', value: o.cost ?? '' });
    const memo = h('input', { class: 'input', placeholder: '메모', value: o.memo || '' });
    const marginBox = h('div', { class: 'margin-box' });
    const paintMargin = () => {
      const c = Number(String(cost.value).replace(/[^0-9]/g, ''));
      if (!c || !o.total_amount) return marginBox.replaceChildren(h('span', { class: 'muted' }, '매입가를 입력하면 마진이 계산됩니다'));
      const m = o.total_amount - c;
      marginBox.replaceChildren(h('span', null, `결제 ${won(o.total_amount)} − 매입 ${won(c)}`), h('b', { class: m >= 0 ? 'plus' : 'minus' }, `마진 ${won(m)}`));
    };
    cost.addEventListener('input', paintMargin);
    paintMargin();
    const info = () => ({ supplier: supplier.value, supplierOrderNo: supNo.value, cost: cost.value, memo: memo.value });
    const btns = h('div', { class: 'btn-row' });
    if (o.status === 'NEW') {
      append(btns, 
        h('button', { class: 'btn primary', style: { flex: '1' }, onclick: (e) => withBtn(e.currentTarget, () => doPurchase([o.id], info())) }, icon('check', 'sm'), '발주완료 처리'),
        !o.market_confirmed ? h('button', { class: 'btn', onclick: (e) => withBtn(e.currentTarget, () => doConfirm([o.id])) }, '마켓 발주확인만') : null
      );
    } else {
      append(btns, h('button', { class: 'btn', style: { flex: '1' }, onclick: (e) => withBtn(e.currentTarget, async () => (await api('POST', `/api/orders/${o.id}/update`, info()), toast('저장했습니다', 'ok'), afterAction())) }, '발주정보 저장'));
      if (open && !o.market_confirmed) append(btns, h('button', { class: 'btn', onclick: (e) => withBtn(e.currentTarget, () => doConfirm([o.id])) }, '마켓 발주확인'));
      if (o.status === 'PURCHASED' || o.status === 'INVOICED')
        append(btns, 
          h(
            'button',
            {
              class: 'btn ghost',
              onclick: (e) =>
                withBtn(e.currentTarget, async () => {
                  if (!confirm(o.status === 'PURCHASED' ? '발주완료를 취소하고 신규주문으로 되돌릴까요?\n(마켓 발주확인은 되돌려지지 않습니다)' : '저장된 송장을 지우고 발주완료 상태로 되돌릴까요?')) return;
                  await api('POST', `/api/orders/${o.id}/revert`);
                  toast('되돌렸습니다');
                  await afterAction();
                }),
            },
            icon('undo', 'sm'),
            '되돌리기'
          )
        );
    }
    append(body, 
      h(
        'div',
        { class: 'sec' },
        h('div', { class: 'sec-h' }, icon('cart', 'sm'), '발주 정보', o.purchased_at ? h('span', { class: 'right muted small' }, `발주 ${fmtDT(o.purchased_at)}`) : null),
        h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('span', null, '공급처'), supplier), h('div', { class: 'field' }, h('span', null, '공급처 주문번호'), supNo)),
        h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('span', null, '매입가'), cost), h('div', { class: 'field' }, h('span', null, '메모'), memo)),
        marginBox,
        btns
      )
    );
  }

  // 송장 / 발송
  if (open) {
    const sel = h('select', { class: 'input' }, courierOptions(o.store_type, o.courier_key || S.meta.settings.defaultCourier), h('option', { value: '__custom' }, '직접 코드 입력…'));
    sel.addEventListener('change', () => {
      if (sel.value !== '__custom') return;
      const code = prompt('마켓 택배사 코드를 입력하세요 (예: CJGLS)');
      if (code && code.trim()) {
        const v = `CUSTOM:${code.trim()}`;
        sel.insertBefore(h('option', { value: v }, `직접입력(${code.trim()})`), sel.lastChild);
        sel.value = v;
      } else sel.value = o.courier_key || S.meta.settings.defaultCourier;
    });
    const inp = h('input', { class: 'input mono', inputmode: 'numeric', autocomplete: 'off', placeholder: '송장번호 입력', value: o.tracking_no || '' });
    append(body, 
      h(
        'div',
        { class: 'sec' },
        h('div', { class: 'sec-h' }, icon('truck', 'sm'), '송장 입력 · 발송처리'),
        h('div', { class: 'field' }, h('span', null, '택배사'), sel),
        h('div', { class: 'field' }, h('span', null, '송장번호'), inp),
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn', onclick: (e) => withBtn(e.currentTarget, () => doInvoice(o.id, sel.value, inp.value, false)) }, '송장만 저장'),
          h('button', { class: 'btn primary', style: { flex: '1' }, onclick: (e) => withBtn(e.currentTarget, () => doInvoice(o.id, sel.value, inp.value, true)) }, icon('send', 'sm'), '발송처리 (마켓 전송)')
        ),
        h('p', { class: 'muted small', style: { margin: '10px 0 0' } }, '발송처리를 누르면 마켓에 송장이 등록되고 구매자에게 배송 안내가 나갑니다. 발주확인이 안 된 주문은 자동으로 발주확인 후 전송합니다.')
      )
    );
  } else if (o.tracking_no) {
    append(body, 
      h(
        'div',
        { class: 'sec' },
        h('div', { class: 'sec-h' }, icon('truck', 'sm'), '배송 정보'),
        kv('택배사', courierNameOf(o.courier_key), { copy: false }),
        kv('송장번호', o.tracking_no, { strong: true }),
        o.dispatched_at ? kv('발송처리', fmtDT(o.dispatched_at, true), { copy: false }) : null,
        o.trackingUrl ? h('a', { class: 'btn block', href: o.trackingUrl, target: '_blank', rel: 'noopener noreferrer', style: { marginTop: '10px' } }, icon('ext', 'sm'), '배송조회') : null
      )
    );
  }

  // 주문자 / 주문 정보
  append(body, 
    h(
      'div',
      { class: 'sec' },
      h('div', { class: 'sec-h' }, '주문 정보'),
      kv('주문자', o.orderer_name),
      kv('주문자 연락처', o.orderer_phone),
      kv('주문번호', o.order_no),
      kv('결제일시', fmtDT(o.paid_at, true), { copy: false }),
      o.ship_due ? kv('발송기한', fmtDT(o.ship_due, true), { copy: false }) : null,
      kv('마켓 상태', o.market_status, { copy: false }),
      kv('배송비', o.shipping_fee ? won(o.shipping_fee) : '무료', { copy: false }),
      kv('마켓 발주확인', o.market_confirmed ? `완료${o.confirmed_at ? ` (${fmtDT(o.confirmed_at)})` : ''}` : '전', { copy: false })
    )
  );

  // 이력
  if (o.events?.length) {
    append(body, 
      h(
        'div',
        { class: 'sec' },
        h('div', { class: 'sec-h' }, '처리 이력'),
        h('ul', { class: 'timeline' }, o.events.map((e) => h('li', null, h('span', { class: 't' }, fmtDT(e.ts)), h('span', { class: e.level }, e.message))))
      )
    );
  }

  append(body, h('details', { class: 'raw sec' }, h('summary', null, '마켓 원본 데이터 보기'), h('pre', null, JSON.stringify(o.items.map((i) => i.raw), null, 2))));
}

// ===================== 고객 문의 =====================
async function renderInquiries(filter) {
  if (filter) S.inqFilter = filter;
  const f = S.inqFilter || 'open';
  setNav('inquiries');
  const view = $('#view');
  const list = h('div', { class: 'list' }, h('div', { class: 'empty' }, '불러오는 중…'));
  const tabs = h(
    'div',
    { class: 'tabs' },
    [
      ['open', '미답변'],
      ['all', '전체'],
    ].map(([k, label]) => h('button', { class: `tab ${k === f ? 'active' : ''}`, 'data-k': k, onclick: () => renderInquiries(k) }, label, h('span', { class: 'n' })))
  );
  view.replaceChildren(h('div', { class: 'page-title' }, '고객 문의', h('span', { class: 'sub' }, '스마트스토어 · 쿠팡')), tabs, list);
  try {
    const r = await api('GET', `/api/inquiries?filter=${f}`);
    for (const b of tabs.querySelectorAll('.tab')) {
      const n = b.dataset.k === 'open' ? r.counts.open : r.counts.all;
      const el = b.querySelector('.n');
      el.textContent = n ? String(n) : '';
      el.classList.toggle('hot', b.dataset.k === 'open' && n > 0);
    }
    if (S.sync) {
      S.sync.inquiriesOpen = r.counts.open;
      paintSync();
    }
    if (!r.inquiries.length) {
      list.replaceChildren(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('div', { class: 'big' }, '💬'), h('b', null, f === 'open' ? '답변을 기다리는 문의가 없습니다' : '문의가 없습니다'), '새 문의가 들어오면 알림으로 알려드릴게요.'));
      return;
    }
    list.replaceChildren(...r.inquiries.map(inquiryCard));
  } catch (e) {
    list.replaceChildren(h('div', { class: 'empty' }, e.message));
  }
}

function inquiryCard(q) {
  const c = connector(q.store_type);
  const kind = q.kind === 'product' ? '상품문의' : '고객문의';
  const answerBox = h('div');
  if (q.answered) {
    append(answerBox, notice('ok', h('b', null, '답변 완료 '), q.answer ? h('span', { class: 'pre' }, q.answer) : ''));
  } else if (c.answerable) {
    const ta = h('textarea', { class: 'input', placeholder: '답변을 입력하세요', style: { minHeight: '84px', fontFamily: 'inherit', fontSize: '14px' } });
    const send = h('button', {
      class: 'btn sm primary',
      onclick: (e) =>
        withBtn(e.currentTarget, async () => {
          if (!ta.value.trim()) throw new Error('답변 내용을 입력해주세요');
          await api('POST', `/api/inquiries/${q.id}/answer`, { text: ta.value.trim() });
          toast('답변을 등록했습니다', 'ok');
          renderInquiries();
        }),
    }, icon('send', 'sm'), '답변 등록');
    append(answerBox, ta, h('div', { class: 'btn-row end', style: { marginTop: '8px' } }, send));
  } else {
    append(answerBox, h('a', { class: 'btn sm', href: c.sellerCenter || '#', target: '_blank', rel: 'noopener noreferrer' }, icon('ext', 'sm'), `${c.label} 셀러센터에서 답변`));
  }
  const meta = [q.product_name ? `상품: ${q.product_name}` : '', q.writer ? `작성자: ${q.writer}` : ''].filter(Boolean).join(' · ');
  return h(
    'article',
    { class: `card order ${q.answered ? '' : 'urgent'}` },
    h('div', { class: 'order-top' }, storeBadge(q.store_type, q.store_name), h('span', { class: `chip ${q.answered ? '' : 'blue'}` }, kind, q.category && q.category !== '상품' ? ` · ${q.category}` : ''), h('span', { class: 'time' }, `${fmtDT(q.asked_at)} · ${ago(q.asked_at)}`)),
    q.title ? h('b', null, q.title) : null,
    h('div', { class: 'pre' }, q.content),
    h('div', { class: 'muted small' }, meta, q.order_id ? h('a', { href: `#/order/${q.order_id}`, style: { marginLeft: '8px' } }, '주문 보기') : q.order_no ? ` · 주문 ${q.order_no}` : ''),
    answerBox
  );
}

// ===================== 스토어 =====================
async function renderStores() {
  setNav('stores');
  const view = $('#view');
  const ipBox = h('div', { class: 'ip-card' }, h('span', { class: 'ip' }, '확인 중…'));
  const listBox = h('div', null, h('div', { class: 'empty' }, '불러오는 중…'));
  view.replaceChildren(
    h('div', { class: 'page-title' }, '스토어 연동', h('span', { class: 'sub' }, 'API 연동')),
    h(
      'div',
      { class: 'card panel' },
      h('h2', null, icon('key', 'sm'), '마켓 API에 등록할 서버 IP'),
      h('p', { class: 'desc' }, '스마트스토어·쿠팡·11번가·G마켓·옥션·롯데ON 모두 등록된 IP에서만 API 호출을 허용합니다. 각 마켓의 API 설정에 아래 IP를 등록하세요.'),
      ipBox
    ),
    h('div', { class: 'btn-row', style: { margin: '4px 0 12px' } }, h('button', { class: 'btn primary', onclick: () => openAddStore() }, icon('plus', 'sm'), '스토어 연결'), h('button', { class: 'btn', onclick: () => syncNow() }, icon('refresh', 'sm'), '전체 지금 수집')),
    listBox
  );
  api('GET', '/api/server-ip')
    .then((r) => {
      if (r.ip) ipBox.replaceChildren(h('span', { class: 'ip mono' }, r.ip), h('button', { class: 'btn sm', onclick: () => copyText(r.ip) }, icon('copy', 'sm'), '복사'));
      else ipBox.replaceChildren(h('span', { class: 'muted' }, 'IP를 자동으로 확인하지 못했습니다. 서버 업체 관리화면의 공인 IP를 등록하세요.'));
    })
    .catch(() => ipBox.replaceChildren(h('span', { class: 'muted' }, '확인 실패')));
  try {
    const [{ stores }, sync] = await Promise.all([api('GET', '/api/stores'), api('GET', '/api/sync/status')]);
    S.sync = sync;
    paintSync();
    if (!stores.length) {
      listBox.replaceChildren(
        h('div', { class: 'card empty' }, h('div', { class: 'big' }, '🏪'), h('b', null, '연결된 스토어가 없습니다'), '[스토어 연결]을 눌러 마켓 API 키를 등록하세요.', h('br'), h('span', { class: 'small' }, '키 없이 먼저 체험하려면 "데모 스토어"를 연결해보세요.'))
      );
      return;
    }
    listBox.replaceChildren(...stores.map(storeRow));
  } catch (e) {
    listBox.replaceChildren(h('div', { class: 'card empty' }, e.message));
  }
}

function storeRow(s) {
  const c = connector(s.type);
  const status = s.lastError
    ? h('div', { class: 'stat err' }, icon('alert', 'sm'), h('span', null, `수집 실패 (${ago(s.lastSyncAt)}): ${s.lastError}`))
    : s.lastSuccessAt
      ? h('div', { class: 'stat' }, h('span', { class: 'dot' }), `정상 · 마지막 수집 ${ago(s.lastSuccessAt)} · 주문 ${s.orderCount}건`)
      : h('div', { class: 'stat' }, h('span', { class: 'dot run' }), '첫 수집 대기 중');
  const toggle = switchEl(s.enabled, async (v, e) => {
    try {
      await api('PUT', `/api/stores/${s.id}`, { enabled: v });
      toast(v ? '자동 수집을 켰습니다' : '자동 수집을 껐습니다');
    } catch (err) {
      e.target.checked = !v;
      toast(err.message, 'err');
    }
  });
  return h(
    'div',
    { class: 'card store-row' },
    h('div', { class: 'head' }, h('span', { class: 'store-badge' }, h('span', { class: 'mk', style: { '--c': c.color } }, c.short)), h('span', { class: 'name' }, s.name, c.beta ? h('span', { class: 'chip orange', style: { marginLeft: '6px' } }, '베타') : null), toggle),
    status,
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn sm', onclick: (e) => withBtn(e.currentTarget, async () => showTestResult(await api('POST', `/api/stores/${s.id}/test`))) }, icon('zap', 'sm'), '연결 테스트'),
      h('button', { class: 'btn sm', onclick: (e) => withBtn(e.currentTarget, () => syncNow(s.id)) }, icon('refresh', 'sm'), '지금 수집'),
      c.fields.length ? h('button', { class: 'btn sm', onclick: () => openEditStore(s) }, icon('key', 'sm'), '키 변경') : null,
      h(
        'button',
        {
          class: 'btn sm danger',
          onclick: (e) =>
            withBtn(e.currentTarget, async () => {
              if (!confirm(`'${s.name}' 스토어를 삭제할까요?\n이 스토어의 주문 기록도 함께 삭제됩니다.`)) return;
              await api('DELETE', `/api/stores/${s.id}`);
              toast('삭제했습니다');
              renderStores();
            }),
        },
        icon('trash', 'sm'),
        '삭제'
      )
    )
  );
}

// 베타 연동 진단 정보 (응답 구조) - 개발자에게 전달하기 쉽게 복사 버튼 제공
function diagnosticBox(text) {
  return h(
    'details',
    { class: 'raw', style: { marginBottom: '10px' } },
    h('summary', null, '응답 구조 보기 (문제가 있을 때 개발자에게 전달)'),
    h('pre', null, text),
    h('button', { class: 'btn xs', onclick: () => copyText(text) }, icon('copy', 'sm'), '복사')
  );
}

function showTestResult(r) {
  if (!r.diagnostic) return toast(r.message, 'ok');
  openSheet('연결 테스트 결과', (body) => append(body, h('div', { class: 'sec' }, notice('ok', r.message), diagnosticBox(r.diagnostic))));
}

function credFields(c, values = {}, { editing = false } = {}) {
  const inputs = {};
  const els = c.fields.map((f) => {
    const inp = h('input', { class: 'input mono', type: f.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', placeholder: editing ? `변경할 때만 입력 (현재 ${values[f.key] || '없음'})` : f.placeholder || '' });
    inputs[f.key] = inp;
    return h('div', { class: 'field' }, h('span', null, f.label, f.required && !editing ? ' *' : ''), inp);
  });
  return { els, read: () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()])) };
}

function openAddStore() {
  openSheet('스토어 연결', (body, close) => {
    let current = null;
    const formBox = h('div');
    const pick = h(
      'div',
      { class: 'market-pick' },
      S.meta.connectors.map((c) =>
        h(
          'button',
          {
            class: 'market-opt',
            'data-type': c.type,
            onclick: () => {
              current = c;
              $$('.market-opt', pick).forEach((b) => b.classList.toggle('on', b.dataset.type === c.type));
              paintForm();
            },
          },
          h('span', { class: 'mk', style: { '--c': c.color } }, c.short),
          h('span', null, c.label, h('small', null, c.type === 'demo' ? '키 없이 체험' : c.beta ? 'API 연동 (베타)' : 'API 연동'))
        )
      )
    );
    const paintForm = () => {
      const c = current;
      const name = h('input', { class: 'input', value: c.label, placeholder: '스토어 이름 (예: 내 스마트스토어)' });
      const creds = credFields(c);
      const result = h('div');
      const ipLine = h('span', { class: 'mono' }, '확인 중…');
      api('GET', '/api/server-ip').then((r) => ipLine.replaceChildren(r.ip || '자동 확인 실패')).catch(() => {});
      formBox.replaceChildren(
        h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, `${c.label} 연결 방법`), h('ol', { class: 'steps' }, c.guide.map((g) => h('li', null, g))), c.type !== 'demo' ? notice('info', '이 서버 IP: ', h('b', null, ipLine), ' ', h('button', { class: 'btn xs', onclick: () => copyText(ipLine.textContent) }, '복사')) : null),
        h('div', { class: 'sec' }, h('div', { class: 'field' }, h('span', null, '스토어 이름'), name), creds.els, result, h(
          'div',
          { class: 'btn-row' },
          c.fields.length
            ? h('button', {
                class: 'btn',
                onclick: (e) =>
                  withBtn(e.currentTarget, async () => {
                    const r = await api('POST', '/api/stores/test', { type: c.type, credentials: creds.read() });
                    result.replaceChildren(notice('ok', r.message), r.diagnostic ? diagnosticBox(r.diagnostic) : '');
                  }),
              }, icon('zap', 'sm'), '연결 테스트')
            : null,
          h('button', {
            class: 'btn primary',
            style: { flex: '1' },
            onclick: (e) =>
              withBtn(e.currentTarget, async () => {
                await api('POST', '/api/stores', { type: c.type, name: name.value, credentials: creds.read() });
                toast('스토어를 연결했습니다. 주문을 불러오는 중…', 'ok');
                close();
                setTimeout(() => (S.view === 'stores' ? renderStores() : null, refreshSync()), 2500);
                renderStores();
              }),
          }, '저장하고 연결')
        ))
      );
    };
    append(body, h('p', { class: 'muted small', style: { margin: '0 0 10px' } }, '연결할 마켓을 고르세요.'), pick, formBox);
  });
}

function openEditStore(s) {
  const c = connector(s.type);
  openSheet(`${s.name} 설정`, (body, close) => {
    const name = h('input', { class: 'input', value: s.name });
    const creds = credFields(c, s.credentials, { editing: true });
    append(body, 
      h('div', { class: 'sec' }, h('div', { class: 'field' }, h('span', null, '스토어 이름'), name), creds.els, h('p', { class: 'muted small' }, '키를 바꾸지 않을 칸은 비워두세요.'), h('button', {
        class: 'btn primary block',
        onclick: (e) =>
          withBtn(e.currentTarget, async () => {
            await api('PUT', `/api/stores/${s.id}`, { name: name.value, credentials: creds.read() });
            toast('저장했습니다', 'ok');
            close();
            renderStores();
          }),
      }, '저장')),
      h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, '연결 방법'), h('ol', { class: 'steps' }, c.guide.map((g) => h('li', null, g))))
    );
  });
}

// ===================== 알림 설정 =====================
function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b);
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function enablePush() {
  if (!window.isSecureContext) throw new Error('알림은 https:// 주소로 접속했을 때만 사용할 수 있습니다.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    if (isIOS() && !isStandalone()) throw new Error('아이폰은 먼저 Safari 공유 버튼 → "홈 화면에 추가" 후, 홈 화면의 오더허브 앱에서 다시 눌러주세요.');
    throw new Error('이 브라우저는 웹 푸시를 지원하지 않습니다. 크롬/사파리 최신 버전을 사용하거나 텔레그램·ntfy 알림을 이용하세요.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('알림 권한이 거부되었습니다. 브라우저/휴대폰 설정에서 이 사이트의 알림을 허용해주세요.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/api/push/key');
  const key = urlB64ToUint8Array(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const cur = sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (cur && cur.join(',') !== key.join(',')) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  await api('PUT', '/api/settings', { notify: { webpush: { enabled: true } } });
}

async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
}

async function renderNotify() {
  setNav('notify');
  const view = $('#view');
  view.replaceChildren(h('div', { class: 'page-title' }, '휴대폰 알림'), h('div', { class: 'empty' }, '불러오는 중…'));
  let cfg;
  try {
    cfg = (await api('GET', '/api/settings')).notify;
  } catch (e) {
    return view.replaceChildren(h('div', { class: 'empty' }, e.message));
  }
  const save = async (patch) => {
    cfg = (await api('PUT', '/api/settings', { notify: patch })).notify;
    return cfg;
  };

  // --- 웹앱 푸시 ---
  const sub = await currentSubscription().catch(() => null);
  const pushState = h('div');
  const paintPush = (subscribed) => {
    const lines = [];
    if (!window.isSecureContext) lines.push(notice('warn', '지금은 https가 아닌 주소로 접속 중이라 웹 푸시를 쓸 수 없습니다. 도메인+HTTPS로 접속하거나 텔레그램/ntfy를 사용하세요.'));
    else if (isIOS() && !isStandalone()) lines.push(notice('warn', h('b', null, '아이폰 사용법: '), 'Safari 하단 공유 버튼(□↑) → "홈 화면에 추가" → 홈 화면에 생긴 오더허브 앱을 열고 이 화면에서 [이 기기에서 알림 받기]를 누르세요. (iOS 16.4 이상)'));
    lines.push(
      h(
        'div',
        { class: 'setting-row' },
        h('div', { class: 'label' }, h('b', null, subscribed ? '이 기기: 알림 받는 중 ✅' : '이 기기: 알림 꺼짐'), h('small', null, `등록된 기기 ${cfg.webpush.subscriptions}대`)),
        subscribed
          ? h('button', { class: 'btn sm', onclick: (e) => withBtn(e.currentTarget, async () => (await disablePush(), toast('이 기기 알림을 껐습니다'), renderNotify())) }, '끄기')
          : h('button', { class: 'btn sm primary', onclick: (e) => withBtn(e.currentTarget, async () => (await enablePush(), toast('이 기기에서 알림을 받습니다', 'ok'), renderNotify())) }, icon('phoneDev', 'sm'), '이 기기에서 알림 받기')
      )
    );
    pushState.replaceChildren(...lines);
  };
  paintPush(!!sub);

  // --- 텔레그램 ---
  const tgToken = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: cfg.telegram.hasBotToken ? `저장됨 (${cfg.telegram.botTokenMasked}) - 바꿀 때만 입력` : '123456789:ABCdef...' });
  const tgChat = h('input', { class: 'input mono', placeholder: '채팅 ID (숫자)', value: cfg.telegram.chatId || '' });
  const tgFound = h('div');

  // --- ntfy ---
  const randomTopic = () => `orderhub-${crypto.getRandomValues(new Uint32Array(2)).join('').slice(0, 14)}`;
  const nServer = h('input', { class: 'input mono', value: cfg.ntfy.server || 'https://ntfy.sh' });
  const nTopic = h('input', { class: 'input mono', placeholder: '예) orderhub-8271635401', value: cfg.ntfy.topic || '' });
  const nToken = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: cfg.ntfy.hasToken ? `저장됨 (${cfg.ntfy.tokenMasked})` : '비공개 서버를 쓸 때만 (선택)' });

  const testBtn = (channel) => h('button', { class: 'btn sm', onclick: (e) => withBtn(e.currentTarget, async () => (await api('POST', '/api/notify/test', { channel }), toast('테스트 알림을 보냈습니다. 휴대폰을 확인하세요!', 'ok'))) }, icon('zap', 'sm'), '테스트 알림');

  view.replaceChildren(
    h('div', { class: 'page-title' }, '휴대폰 알림'),
    notice('info', h('b', null, '추천: 웹앱 푸시'), ' — 별도 앱 설치 없이 오더허브를 홈 화면에 추가하면 알림이 오고, 누르면 바로 해당 주문이 열립니다. 더 확실하게 받고 싶다면 ', h('b', null, '텔레그램'), ' 또는 ', h('b', null, 'ntfy'), '도 함께 켜두세요. (여러 개 동시 사용 가능)'),
    h(
      'div',
      { class: 'card panel' },
      h('h2', null, icon('phoneDev', 'sm'), '웹앱 푸시 ', h('span', { class: 'chip blue' }, '추천')),
      h('p', { class: 'desc' }, '안드로이드 크롬 / 아이폰(홈 화면 앱) / PC 크롬·엣지에서 동작합니다. 알림을 받을 기기마다 한 번씩 등록하세요.'),
      h('div', { class: 'setting-row' }, h('div', { class: 'label' }, h('b', null, '웹앱 푸시 사용'), h('small', null, '끄면 모든 기기에 웹 푸시를 보내지 않습니다')), switchEl(cfg.webpush.enabled, (v) => save({ webpush: { enabled: v } }).then(() => toast(v ? '켰습니다' : '껐습니다')).catch((e) => toast(e.message, 'err')))),
      pushState,
      h('div', { class: 'btn-row', style: { marginTop: '8px' } }, testBtn('webpush'))
    ),
    h(
      'div',
      { class: 'card panel' },
      h('h2', null, icon('send', 'sm'), '텔레그램'),
      h('p', { class: 'desc' }, '무료이고 매우 안정적입니다. 주문 정보가 메시지로 와서 기록이 남습니다.'),
      h('ol', { class: 'steps' }, h('li', null, '텔레그램에서 ', h('b', null, '@BotFather'), ' 검색 → /newbot 입력 → 봇 이름을 정하면 토큰을 줍니다.'), h('li', null, '만든 봇을 검색해 대화방에서 아무 메시지나 보냅니다 (예: 안녕).'), h('li', null, '아래에 토큰을 넣고 [채팅 ID 자동 찾기] → [저장] → [테스트 알림].')),
      h('div', { class: 'setting-row' }, h('div', { class: 'label' }, h('b', null, '텔레그램 알림 사용')), switchEl(cfg.telegram.enabled, (v) => save({ telegram: { enabled: v } }).then(() => toast(v ? '켰습니다' : '껐습니다')).catch((e) => toast(e.message, 'err')))),
      h('div', { class: 'field' }, h('span', null, '봇 토큰'), tgToken),
      h('div', { class: 'field' }, h('span', null, '채팅 ID'), h('div', { class: 'inline' }, tgChat, h('button', {
        class: 'btn sm',
        onclick: (e) =>
          withBtn(e.currentTarget, async () => {
            const r = await api('POST', '/api/notify/telegram/detect', { botToken: tgToken.value.trim() });
            if (!r.chats.length) throw new Error('찾은 대화가 없습니다. 봇에게 먼저 메시지를 보내고 다시 눌러주세요.');
            tgFound.replaceChildren(...r.chats.map((c) => h('button', { class: 'btn xs', style: { margin: '0 6px 6px 0' }, onclick: () => (tgChat.value = c.id) }, `${c.name || '대화'} (${c.id})`)));
            tgChat.value = r.chats[0].id;
          }),
      }, '자동 찾기'))),
      tgFound,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn sm primary', onclick: (e) => withBtn(e.currentTarget, async () => (await save({ telegram: { botToken: tgToken.value.trim() || undefined, chatId: tgChat.value.trim(), enabled: true } }), toast('저장했습니다', 'ok'), renderNotify())) }, '저장'), testBtn('telegram'))
    ),
    h(
      'div',
      { class: 'card panel' },
      h('h2', null, icon('bell', 'sm'), 'ntfy'),
      h('p', { class: 'desc' }, '가입 없이 쓰는 무료 알림 앱입니다. 토픽 이름이 비밀번호 역할을 하니 남이 추측하기 어려운 이름을 쓰세요.'),
      h('ol', { class: 'steps' }, h('li', null, '휴대폰에 ', h('b', null, 'ntfy'), ' 앱 설치 (플레이스토어/앱스토어).'), h('li', null, '앱에서 [+] → 아래 토픽 이름으로 구독 (서버는 기본값 ntfy.sh).'), h('li', null, '[저장] → [테스트 알림]으로 확인.')),
      h('div', { class: 'setting-row' }, h('div', { class: 'label' }, h('b', null, 'ntfy 알림 사용')), switchEl(cfg.ntfy.enabled, (v) => save({ ntfy: { enabled: v } }).then(() => toast(v ? '켰습니다' : '껐습니다')).catch((e) => toast(e.message, 'err')))),
      h('div', { class: 'field' }, h('span', null, '토픽 이름'), h('div', { class: 'inline' }, nTopic, h('button', { class: 'btn sm', onclick: () => (nTopic.value = randomTopic()) }, '랜덤 생성'))),
      h('div', { class: 'field' }, h('span', null, '서버 주소'), nServer),
      h('div', { class: 'field' }, h('span', null, '액세스 토큰 (선택)'), nToken),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn sm primary', onclick: (e) => withBtn(e.currentTarget, async () => (await save({ ntfy: { server: nServer.value.trim(), topic: nTopic.value.trim(), token: nToken.value.trim() || undefined, enabled: true } }), toast('저장했습니다', 'ok'), renderNotify())) }, '저장'), testBtn('ntfy'))
    ),
    h(
      'div',
      { class: 'card panel' },
      h('h2', null, '알림 받을 내용'),
      [
        ['newOrder', '신규주문', '새 주문이 수집되면 바로 알림'],
        ['claim', '취소·반품·교환 / 배송지 변경', '발주 후 취소되면 공급처 취소가 필요하니 꼭 켜두세요'],
        ['inquiry', '고객 문의', '스마트스토어·쿠팡에 새 문의가 들어오면 알림'],
        ['error', '수집 오류', 'API 키 만료·IP 변경 등으로 수집이 실패할 때'],
      ].map(([key, label, desc]) =>
        h('div', { class: 'setting-row' }, h('div', { class: 'label' }, h('b', null, label), h('small', null, desc)), switchEl(cfg.events[key], (v) => save({ events: { [key]: v } }).catch((e) => toast(e.message, 'err'))))
      )
    )
  );
}

// ===================== 설정 =====================
async function renderSettings() {
  setNav('settings');
  const view = $('#view');
  let app;
  try {
    app = (await api('GET', '/api/settings')).app;
  } catch (e) {
    return view.replaceChildren(h('div', { class: 'empty' }, e.message));
  }
  const saveApp = async (patch) => {
    try {
      app = (await api('PUT', '/api/settings', { app: patch })).app;
      S.meta.settings = app;
      toast('저장했습니다');
      refreshSync();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const interval = h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => saveApp({ pollIntervalMin: Number(e.target.value) }) }, [1, 3, 5, 10, 15, 30, 60].map((n) => h('option', { value: n, selected: n === app.pollIntervalMin ? 'selected' : null }, `${n}분`)));
  const courier = h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => saveApp({ defaultCourier: e.target.value }) }, courierOptions('demo', app.defaultCourier));
  const days = h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => saveApp({ initialDays: Number(e.target.value) }) }, [1, 2, 3, 5, 7].map((n) => h('option', { value: n, selected: n === app.initialDays ? 'selected' : null }, `${n}일`)));
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: '현재 비밀번호' });
  const nxt = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '새 비밀번호 (8자 이상)' });
  const eventsBox = h('ul', { class: 'events' }, h('li', null, '불러오는 중…'));
  view.replaceChildren(
    h('div', { class: 'page-title' }, '설정'),
    h(
      'div',
      { class: 'card panel' },
      h('h2', null, '주문 수집'),
      h('div', { class: 'setting-row' }, h('div', { class: 'label' }, h('b', null, '자동 수집 주기'), h('small', null, '이 간격으로 모든 스토어의 새 주문을 확인합니다')), interval),
      h('div', { class: 'setting-row' }, h('div', { class: 'label' }, h('b', null, '발주완료 시 마켓 발주확인'), h('small', null, '[발주완료]를 누르면 마켓에도 발주확인(상품준비중) 처리')), switchEl(app.confirmOnPurchase, (v) => saveApp({ confirmOnPurchase: v }))),
      h('div', { class: 'setting-row' }, h('div', { class: 'label' }, h('b', null, '신규주문 자동 발주확인'), h('small', null, '수집 즉시 마켓에 발주확인 → 구매자가 바로 취소할 수 없게 됩니다')), switchEl(app.autoConfirm, (v) => saveApp({ autoConfirm: v }))),
      h('div', { class: 'setting-row' }, h('div', { class: 'label' }, h('b', null, '고객 문의 수집'), h('small', null, '스마트스토어 고객·상품 문의, 쿠팡 상품 문의(베타)')), switchEl(app.collectInquiries, (v) => saveApp({ collectInquiries: v }))),
      h('div', { class: 'setting-row' }, h('div', { class: 'label' }, h('b', null, '기본 택배사'), h('small', null, '송장 입력 시 기본으로 선택')), courier),
      h('div', { class: 'setting-row' }, h('div', { class: 'label' }, h('b', null, '스토어 첫 연결 시 불러올 기간'), h('small', null, '처리 대기 중인 과거 주문을 가져옵니다 (알림 없음)')), days)
    ),
    h(
      'div',
      { class: 'card panel' },
      h('h2', null, '비밀번호 변경'),
      h('div', { class: 'grid2' }, cur, nxt),
      h('div', { class: 'btn-row', style: { marginTop: '10px' } }, h('button', {
        class: 'btn sm primary',
        onclick: (e) =>
          withBtn(e.currentTarget, async () => {
            await api('POST', '/api/auth/password', { current: cur.value, next: nxt.value });
            cur.value = nxt.value = '';
            toast('비밀번호를 변경했습니다. 다른 기기는 다시 로그인해야 합니다.', 'ok');
          }),
      }, '변경'))
    ),
    h('div', { class: 'card panel' }, h('h2', null, '최근 활동 기록'), eventsBox),
    h(
      'div',
      { class: 'card panel' },
      h('h2', null, '정보'),
      h('p', { class: 'desc' }, `오더허브 v${S.meta.version} · 데이터는 이 서버에만 저장됩니다.`),
      h('button', { class: 'btn sm danger', onclick: async () => (await api('POST', '/api/auth/logout').catch(() => null), location.reload()) }, icon('logout', 'sm'), '로그아웃')
    )
  );
  try {
    const { events } = await api('GET', '/api/events?limit=80');
    eventsBox.replaceChildren(
      ...(events.length
        ? events.map((e) => h('li', null, h('span', { class: 'muted mono' }, fmtDT(e.ts)), h('span', { class: e.level }, e.store_name ? `[${e.store_name}] ` : '', e.message, e.order_id ? h('a', { href: `#/order/${e.order_id}`, style: { marginLeft: '6px' } }, '주문 보기') : '')))
        : [h('li', null, '기록이 없습니다')])
    );
  } catch {}
}

// ===================== 서비스워커 =====================
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open' && e.data.url) {
      const u = new URL(e.data.url);
      if (u.hash) location.hash = u.hash;
    }
  });
}

boot();
