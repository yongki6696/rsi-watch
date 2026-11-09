/* 어디가지 — 화면 로직 */
(function () {
  'use strict';
  var C = window.TravelCore, D = window.TravelData, S = window.TravelStore;

  var DEFAULT_SETTINGS = {
    dataSource: 'demo', serverUrl: '', intervalMin: 30, minDrop: 1000,
    ntfyTopic: '', userId: '', watchEnabled: false, demoEpochOffset: 0,
    lastCheckAt: null, unseenAlerts: 0, askedNotif: false
  };
  var LAST_QUERY_KEY = 'eodigaji:lastQuery';
  var NIGHTS_PRESETS = [2, 3, 4, 6, 9];
  var ALERT_LOG_MAX = 30;

  var state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    favorites: [],
    alerts: [],
    lastSearch: null,
    flightIndex: {},
    region: 'all',
    directOnly: false,
    checking: false,
    searchSeq: 0
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : '#'; }
  function randomId(len) {
    var chars = 'abcdefghijkmnpqrstuvwxyz23456789', out = '', buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    for (var i = 0; i < len; i++) out += chars[buf[i] % chars.length];
    return out;
  }
  function relTime(iso) {
    if (!iso) return '';
    var diff = (Date.now() - Date.parse(iso)) / 60000;
    if (diff < 1) return '방금';
    if (diff < 60) return Math.floor(diff) + '분 전';
    if (diff < 1440) return Math.floor(diff / 60) + '시간 전';
    var w = C.wallInTz(Date.parse(iso), D.HOME_TZ);
    return Number(w.slice(5, 7)) + '/' + Number(w.slice(8, 10)) + ' ' + w.slice(11, 16);
  }
  function serverBase() { return (state.settings.serverUrl || '').trim().replace(/\/+$/, ''); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2800);
  }

  // ── 저장 ────────────────────────────────────────────────
  function saveSettings() { return S.set('settings', state.settings); }
  function saveFavorites() { return S.set('favorites', state.favorites); }
  function saveAlerts() { return S.set('alerts', state.alerts); }

  // ── 라우팅 (하단 탭) ────────────────────────────────────
  function route() {
    var tab = (location.hash || '#search').slice(1);
    if (['search', 'favorites', 'settings'].indexOf(tab) < 0) tab = 'search';
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + tab); });
    document.querySelectorAll('.tab').forEach(function (t) {
      var on = t.dataset.tab === tab;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    if (tab === 'favorites' && state.settings.unseenAlerts) {
      state.settings.unseenAlerts = 0;
      saveSettings();
      updateBadge();
    }
    if (tab === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  // ── 검색 폼 ─────────────────────────────────────────────
  function readQuery() {
    return { origin: $('origin').value, departDate: $('depart').value, returnDate: $('return').value };
  }

  function initForm() {
    $('origin').innerHTML = D.ORIGINS.map(function (o) {
      return '<option value="' + o.code + '">' + esc(o.name) + '</option>';
    }).join('');
    $('nights-chips').innerHTML = NIGHTS_PRESETS.map(function (n) {
      return '<button type="button" class="chip" data-nights="' + n + '" aria-pressed="false">' + n + '박' + (n + 1) + '일</button>';
    }).join('');

    var today = C.todayInSeoul();
    var q = null;
    try { q = JSON.parse(localStorage.getItem(LAST_QUERY_KEY) || 'null'); } catch (e) { q = null; }
    if (!q || !q.departDate || q.departDate < today) {
      var dep = C.addDays(today, 28);
      q = { origin: 'SEL', departDate: dep, returnDate: C.addDays(dep, 4) };
    }
    $('origin').value = D.ORIGINS.some(function (o) { return o.code === q.origin; }) ? q.origin : 'SEL';
    $('depart').value = q.departDate;
    $('return').value = q.returnDate > q.departDate ? q.returnDate : C.addDays(q.departDate, 3);
    syncDateConstraints();
  }

  function syncDateConstraints() {
    var dep = $('depart').value;
    $('depart').min = C.todayInSeoul();
    if (dep) $('return').min = dep;
    var q = readQuery();
    var nights = q.departDate && q.returnDate ? C.daysBetween(q.departDate, q.returnDate) : null;
    document.querySelectorAll('#nights-chips .chip').forEach(function (c) {
      c.setAttribute('aria-pressed', String(Number(c.dataset.nights) === nights));
    });
    $('trip-label').innerHTML = nights != null && nights >= 0
      ? '<b>' + esc(C.tripLabel(q.departDate, q.returnDate)) + '</b> · ' + esc(C.formatShortDate(q.departDate)) + ' 출발'
      : '';
  }

  function validate(q) {
    var today = C.todayInSeoul();
    if (!q.departDate || !q.returnDate) return '가는 날과 오는 날을 모두 골라 주세요.';
    if (q.departDate < today) return '가는 날이 이미 지났어요.';
    if (q.returnDate < q.departDate) return '오는 날은 가는 날보다 뒤여야 해요.';
    if (C.daysBetween(today, q.departDate) > 360) return '1년 이내 날짜만 검색할 수 있어요.';
    return null;
  }

  function runSearch(q) {
    var err = validate(q);
    var errBox = $('form-error');
    if (err) { errBox.textContent = err; errBox.classList.remove('hidden'); return; }
    errBox.classList.add('hidden');
    try { localStorage.setItem(LAST_QUERY_KEY, JSON.stringify(q)); } catch (e) { /* 저장 못 해도 무관 */ }

    var seq = ++state.searchSeq;
    $('search-empty').classList.add('hidden');
    $('results').classList.remove('hidden');
    $('res-title').textContent = '최저가를 찾는 중…';
    $('res-meta').textContent = '';
    $('region-chips').innerHTML = '';
    $('country-list').innerHTML = '<div class="loading"><span class="spinner"></span>나라별 항공권을 모으고 있어요</div>';
    $('search-btn').disabled = true;

    C.createProvider(state.settings).search(q).then(function (res) {
      if (seq !== state.searchSeq) return;
      state.lastSearch = { query: q, flights: res.flights, fetchedAt: res.fetchedAt, source: res.source };
      state.region = 'all';
      renderResults();
    }).catch(function (e) {
      if (seq !== state.searchSeq) return;
      state.lastSearch = null;
      $('res-title').textContent = '검색하지 못했어요';
      $('country-list').innerHTML = '<div class="error-box" role="alert">' + esc(e.message || e) +
        (state.settings.dataSource === 'live' ? '<br>설정 탭에서 서버 주소와 연결 상태를 확인해 주세요.' : '') + '</div>';
    }).then(function () {
      if (seq === state.searchSeq) $('search-btn').disabled = false;
    });
  }

  // ── 검색 결과 ───────────────────────────────────────────
  function isFav(id) { return state.favorites.some(function (f) { return f.id === id; }); }

  function legHtml(label, leg, expectedDate) {
    var slot = C.slotOf(leg.dep);
    var arr = '';
    if (leg.arr) {
      var diff = C.daysBetween(leg.dep.slice(0, 10), leg.arr.slice(0, 10));
      arr = ' → <time>' + leg.arr.slice(11, 16) + '</time>' + (diff ? '<sup>' + (diff > 0 ? '+' : '') + diff + '</sup>' : '');
    }
    var meta = [C.formatDuration(leg.durationMin),
      leg.stops ? '<span class="stops">경유 ' + leg.stops + '회</span>' : '직항'].filter(Boolean).join(' · ');
    var dateNote = expectedDate && leg.dep.slice(0, 10) !== expectedDate
      ? '<span class="date">' + esc(C.formatShortDate(leg.dep)) + '</span>' : '';
    return '<div class="leg"><span class="leg-lbl">' + label + '</span><div class="leg-body">' +
      '<span class="leg-times">' + dateNote + '<time>' + esc(leg.dep.slice(11, 16)) + '</time>' + arr + '</span>' +
      '<span class="slot ' + slot + '">' + C.SLOT_LABEL[slot] + '</span>' +
      '<span class="meta">' + meta + '</span></div></div>';
  }

  function starButton(id) {
    var on = isFav(id);
    return '<button type="button" class="star" data-fav="' + esc(id) + '" aria-pressed="' + on + '" aria-label="' +
      (on ? '즐겨찾기 해제' : '즐겨찾기') + '">' + (on ? '★' : '☆') + '</button>';
  }

  function flightHtml(f, q) {
    return '<li class="flight">' +
      '<div>' +
        '<div class="f-title">' + esc(f.destName) + ' <span class="code">' + esc(f.dest) + '</span>' +
          '<span class="airline">' + esc(f.airlineName) + ' ' + esc(f.flightNo) + '</span></div>' +
        '<div class="legs">' + legHtml('가는편', f.out, q.departDate) + legHtml('오는편', f.back, q.returnDate) + '</div>' +
      '</div>' +
      '<div class="f-side">' +
        '<div class="price num">' + C.formatKRW(f.price) + '</div>' +
        '<div class="f-actions">' + starButton(f.id) +
          '<a class="book" href="' + esc(safeUrl(f.bookingUrl)) + '" target="_blank" rel="noopener">예약</a></div>' +
      '</div>' +
    '</li>';
  }

  function countryHtml(g, idx, q) {
    var cheapestCity = g.flights[0];
    return '<article class="card country">' +
      '<div class="c-head">' +
        '<span class="c-flag" aria-hidden="true">' + g.flag + '</span>' +
        '<div class="c-title"><h3>' + (idx < 3 ? '<span class="c-rank">' + (idx + 1) + '위</span>' : '') + esc(g.name) + '</h3>' +
          '<div class="c-cities">' + g.cities.map(function (c) { return esc(c.name); }).join(' · ') + '</div></div>' +
        '<div class="c-min"><small>최저</small><b class="num">' + C.formatKRW(g.minPrice) + '</b></div>' +
      '</div>' +
      '<ol class="flights">' + g.flights.map(function (f) { return flightHtml(f, q); }).join('') + '</ol>' +
      '<div class="c-foot"><span>항공편 ' + g.total + '개 중 ' + g.flights.length + '개</span>' +
        '<a href="' + esc(C.googleFlightsUrl(cheapestCity.origin, cheapestCity.dest, q.departDate, q.returnDate)) +
        '" target="_blank" rel="noopener">구글 항공권에서 비교 ↗</a></div>' +
    '</article>';
  }

  function renderResults() {
    var ls = state.lastSearch;
    if (!ls) return;
    var q = ls.query;
    state.flightIndex = {};
    ls.flights.forEach(function (f) { state.flightIndex[f.id] = f; });

    var all = C.groupByCountry(ls.flights, { directOnly: state.directOnly });
    var regions = {};
    all.forEach(function (g) { regions[g.region] = true; });
    if (state.region !== 'all' && !regions[state.region]) state.region = 'all';
    var groups = state.region === 'all' ? all : all.filter(function (g) { return g.region === state.region; });

    $('region-chips').innerHTML = ['all'].concat(Object.keys(D.REGIONS).filter(function (r) { return regions[r]; }))
      .map(function (r) {
        return '<button type="button" class="chip" data-region="' + r + '" aria-pressed="' + (state.region === r) + '">' +
          (r === 'all' ? '전체' : D.REGIONS[r]) + '</button>';
      }).join('');

    $('res-title').textContent = groups.length ? groups.length + '개 나라 · 싼 곳부터' : '항공권이 없어요';
    $('res-meta').textContent = C.originInfo(q.origin).name + ' 출발 · ' +
      C.formatShortDate(q.departDate) + '~' + C.formatShortDate(q.returnDate) + ' · ' +
      relTime(ls.fetchedAt) + ' 기준' + (ls.source === 'demo' ? ' · 가상 가격' : '');

    if (!groups.length) {
      $('country-list').innerHTML = '<div class="empty"><div class="big">🛫</div><h3>조건에 맞는 항공권이 없어요</h3><p>' +
        (ls.source === 'travelpayouts'
          ? 'Travelpayouts에 이 날짜 가격 정보가 아직 없을 수 있어요.<br>날짜를 하루 이틀 바꿔 보세요.'
          : (state.directOnly ? '직항만 보기를 꺼 보세요.' : '날짜를 바꿔 보세요.')) + '</p></div>';
      return;
    }
    $('country-list').innerHTML = groups.map(function (g, i) { return countryHtml(g, i, q); }).join('');
  }

  function refreshStars(id) {
    document.querySelectorAll('.star').forEach(function (b) {
      if (b.dataset.fav !== id) return;
      var on = isFav(id);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? '즐겨찾기 해제' : '즐겨찾기');
      b.textContent = on ? '★' : '☆';
    });
  }

  function toggleFavorite(id) {
    var idx = -1;
    state.favorites.forEach(function (f, i) { if (f.id === id) idx = i; });
    if (idx >= 0) {
      state.favorites.splice(idx, 1);
      toast('즐겨찾기에서 뺐어요');
    } else {
      var flight = state.flightIndex[id];
      if (!flight) return;
      state.favorites.unshift(C.favoriteFromFlight(flight));
      toast('즐겨찾기에 담았어요 ⭐\n가격이 내려가면 알려드릴게요');
      maybeAskNotification();
    }
    saveFavorites();
    refreshStars(id);
    renderFavorites();
    scheduleWatchSync();
  }

  // ── 즐겨찾기 화면 ───────────────────────────────────────
  function sparkline(history) {
    if (!history || history.length < 2) return '<span class="fav-stats">가격 기록을 모으는 중</span>';
    var w = 120, h = 40, p = 4;
    var prices = history.map(function (x) { return x.p; });
    var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
    var span = max - min || 1;
    var pts = prices.map(function (v, i) {
      return [p + (i * (w - 2 * p)) / (prices.length - 1), h - p - ((v - min) / span) * (h - 2 * p)];
    });
    var d = pts.map(function (pt, i) { return (i ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1); }).join(' ');
    var last = pts[pts.length - 1];
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="가격 추이 ' +
      C.formatKRW(min) + '~' + C.formatKRW(max) + '"><path d="' + d + '"/><circle cx="' + last[0].toFixed(1) +
      '" cy="' + last[1].toFixed(1) + '" r="3"/></svg>';
  }

  function deltaHtml(fav) {
    var d = fav.lastPrice - fav.savedPrice;
    if (!d) return '<div class="delta same">담은 가격 그대로</div>';
    return '<div class="delta ' + (d < 0 ? 'down' : 'up') + '">' + (d < 0 ? '▼ ' : '▲ ') +
      C.formatKRW(Math.abs(d)) + ' <span style="font-weight:500">담을 때보다</span></div>';
  }

  function statusHtml(fav) {
    if (fav.status === 'expired') return '<span class="status">출발일 지남</span>';
    if (fav.status === 'missing') return '<span class="status warn">최근 검색에 안 보임</span>';
    if (fav.status === 'source-mismatch') return '<span class="status">' + (fav.source === 'demo' ? '데모 데이터 항공편' : '실제 가격 항공편') + '</span>';
    if (fav.lastError) return '<span class="status warn">확인 실패</span>';
    return '';
  }

  function favHtml(fav) {
    var info = C.countryInfo(fav.country, fav.countryName);
    return '<article class="card fav' + (fav.status === 'expired' ? ' expired' : '') + '">' +
      '<div class="fav-top">' +
        '<div><div class="fav-route">' + info.flag + ' ' + esc(fav.destName) + ' <span class="code" style="font-size:12px;color:var(--muted)">' + esc(fav.dest) + '</span></div>' +
          '<div class="fav-dates">' + esc(C.formatShortDate(fav.departDate)) + ' → ' + esc(C.formatShortDate(fav.returnDate)) +
          ' · ' + esc(C.tripLabel(fav.departDate, fav.returnDate)) + '</div></div>' +
        '<div class="fav-price"><div class="now num">' + C.formatKRW(fav.lastPrice) + '</div>' + deltaHtml(fav) + '</div>' +
      '</div>' +
      '<div class="fav-mid">' +
        '<div><div class="f-title"><span class="airline">' + esc(fav.airlineName) + ' ' + esc(fav.flightNo) + '</span></div>' +
          '<div class="legs">' + legHtml('가는편', fav.out) + legHtml('오는편', fav.back) + '</div></div>' +
        sparkline(fav.history) +
      '</div>' +
      '<div class="fav-stats"><span>담은 가격 <b class="num">' + C.formatKRW(fav.savedPrice) + '</b></span>' +
        '<span>최저 <b class="num">' + C.formatKRW(fav.lowestPrice) + '</b></span>' +
        '<span>확인 <b>' + esc(relTime(fav.lastCheckedAt)) + '</b></span>' + statusHtml(fav) + '</div>' +
      '<div class="fav-bottom">' +
        '<label class="target">목표가 <input inputmode="numeric" enterkeyhint="done" data-target="' + esc(fav.id) + '" value="' +
          (fav.targetPrice ? fav.targetPrice.toLocaleString('ko-KR') : '') + '" placeholder="없음" aria-label="목표가(원)"> 이하</label>' +
        '<div class="f-actions"><a class="book" href="' + esc(safeUrl(fav.bookingUrl)) + '" target="_blank" rel="noopener">예약</a>' +
          '<button type="button" class="btn small" data-remove="' + esc(fav.id) + '">삭제</button></div>' +
      '</div>' +
    '</article>';
  }

  function renderFavorites() {
    var list = state.favorites;
    $('fav-count').textContent = '즐겨찾기 ' + list.length + '개';
    $('fav-checked').textContent = state.settings.lastCheckAt ? '마지막 확인 ' + relTime(state.settings.lastCheckAt) : '';
    $('check-now').disabled = !list.length || state.checking;
    if (!list.length) {
      $('fav-list').innerHTML = '<div class="empty"><div class="big">☆</div><h3>아직 담은 항공편이 없어요</h3>' +
        '<p>검색 결과에서 ☆를 누르면 여기서 가격을 지켜봐 드려요.<br>최저가를 새로 찍으면 알림을 보내드려요.</p></div>';
    } else {
      var sorted = list.slice().sort(function (a, b) {
        return (a.status === 'expired') - (b.status === 'expired');
      });
      $('fav-list').innerHTML = sorted.map(favHtml).join('');
    }
    $('alert-log').innerHTML = state.alerts.length
      ? state.alerts.map(function (a) {
          return '<li><time>' + esc(relTime(a.at)) + '</time><b>' + esc(a.title) + '</b><p>' + esc(a.body) + '</p></li>';
        }).join('')
      : '<li style="color:var(--muted)">아직 알림이 없어요.</li>';
    renderNotifBanner();
    updateBadge();
  }

  function updateBadge() {
    var b = $('fav-badge');
    var n = state.settings.unseenAlerts || 0;
    b.textContent = n > 9 ? '9+' : String(n);
    b.classList.toggle('hidden', !n);
  }

  function setTarget(id, raw) {
    var fav = state.favorites.filter(function (f) { return f.id === id; })[0];
    if (!fav) return;
    var v = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
    var target = v > 0 ? v : null;
    if (target === fav.targetPrice) return;
    fav.targetPrice = target;
    fav.targetHit = !!target && fav.lastPrice <= target;
    saveFavorites();
    renderFavorites();
    scheduleWatchSync();
    if (!target) toast('목표가를 지웠어요');
    else if (fav.targetHit) toast('이미 목표가 이하예요! 지금이 기회일지도 🎯');
    else toast(C.formatKRW(target) + ' 이하가 되면 알려드릴게요');
  }

  function removeFavorite(id) {
    state.favorites = state.favorites.filter(function (f) { return f.id !== id; });
    saveFavorites();
    renderFavorites();
    refreshStars(id);
    scheduleWatchSync();
    toast('즐겨찾기에서 뺐어요');
  }

  // ── 가격 확인 + 알림 ────────────────────────────────────
  function mergeChecked(current, checked) {
    var byId = {};
    checked.forEach(function (f) { byId[f.id] = f; });
    return current.map(function (f) {
      var u = byId[f.id];
      if (!u) return f; // 확인 도중 새로 담은 항목
      u.targetPrice = f.targetPrice; // 확인 도중 바꾼 목표가 유지
      return u;
    });
  }

  function runCheck(opts) {
    opts = opts || {};
    if (state.checking || !state.favorites.length) return Promise.resolve();
    state.checking = true;
    var btn = $('check-now');
    btn.disabled = true;
    btn.textContent = '확인 중…';
    var provider = C.createProvider(state.settings);
    return C.checkFavorites(state.favorites, provider, { minDrop: state.settings.minDrop }).then(function (res) {
      state.favorites = mergeChecked(state.favorites, res.favorites);
      state.settings.lastCheckAt = res.checkedAt;
      handleAlerts(res.alerts);
      saveFavorites();
      saveSettings();
      if (opts.manual) {
        var prefix = opts.prefix ? opts.prefix + '\n' : '';
        if (res.alerts.length) toast(prefix + res.alerts.length + '개 항공편 가격이 내려갔어요! ✈️');
        else if (res.errors.length) toast('확인 실패: ' + res.errors[0]);
        else toast(prefix + '새 최저가는 없어요. 계속 지켜볼게요');
      }
    }).catch(function (e) {
      if (opts.manual) toast('확인 실패: ' + (e.message || e));
    }).then(function () {
      state.checking = false;
      btn.textContent = '지금 가격 확인';
      renderFavorites();
      if (state.lastSearch) renderResults();
    });
  }

  function handleAlerts(alerts) {
    if (!alerts.length) return;
    state.alerts = alerts.concat(state.alerts).slice(0, ALERT_LOG_MAX);
    saveAlerts();
    if ((location.hash || '#search') !== '#favorites') {
      state.settings.unseenAlerts = (state.settings.unseenAlerts || 0) + alerts.length;
    }
    alerts.forEach(function (a) { notify(a.title, a.body, a.favId); });
  }

  function notify(title, body, tag) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    var opts = { body: body, tag: tag, icon: 'icon-192.png', data: { url: './#favorites' } };
    var fallback = function () { try { new Notification(title, opts); } catch (e) { /* 모바일은 SW 필요 */ } };
    if (!('serviceWorker' in navigator)) return fallback();
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (reg) return reg.showNotification(title, opts);
      fallback();
    }).catch(fallback);
  }

  function dueForCheck() {
    if (!state.favorites.length || document.visibilityState !== 'visible') return false;
    var last = state.settings.lastCheckAt ? Date.parse(state.settings.lastCheckAt) : 0;
    return Date.now() - last >= state.settings.intervalMin * 60000;
  }
  function startAutoCheck() {
    setInterval(function () { if (dueForCheck()) runCheck(); }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      reloadFromStore().then(function () { if (dueForCheck()) runCheck(); });
    });
    if (dueForCheck()) runCheck();
  }

  // ── 알림 권한 ───────────────────────────────────────────
  function permission() { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; }
  function requestNotification() {
    if (permission() === 'unsupported') {
      toast('이 브라우저는 알림을 지원하지 않아요.\niPhone은 홈 화면에 추가한 뒤 열어 주세요.');
      return Promise.resolve('unsupported');
    }
    return Notification.requestPermission().then(function (p) {
      renderNotifBanner();
      renderSettings();
      if (p === 'granted') { toast('알림을 켰어요 🔔'); registerPeriodicSync(); }
      else if (p === 'denied') toast('알림이 차단됐어요. 브라우저 설정에서 허용해 주세요.');
      return p;
    });
  }
  function maybeAskNotification() {
    if (state.settings.askedNotif || permission() !== 'default') return;
    state.settings.askedNotif = true;
    saveSettings();
    requestNotification();
  }
  function renderNotifBanner() {
    $('notif-banner').classList.toggle('hidden', !(state.favorites.length && permission() === 'default'));
  }

  // ── 설정 화면 ───────────────────────────────────────────
  var PERM_LABEL = { granted: '켜짐', denied: '차단됨', default: '꺼짐', unsupported: '지원 안 됨' };
  function renderSettings() {
    var s = state.settings;
    document.querySelectorAll('input[name="source"]').forEach(function (r) { r.checked = r.value === s.dataSource; });
    $('live-fields').classList.toggle('hidden', s.dataSource !== 'live');
    $('demo-tools').classList.toggle('hidden', s.dataSource !== 'demo');
    if (document.activeElement !== $('server-url')) $('server-url').value = s.serverUrl || '';
    if (document.activeElement !== $('ntfy-topic')) $('ntfy-topic').value = s.ntfyTopic || '';
    $('interval').value = String(s.intervalMin);
    $('min-drop').value = String(s.minDrop);
    var p = permission();
    $('perm-state').textContent = PERM_LABEL[p];
    $('enable-notif').classList.toggle('hidden', p !== 'default');
    $('perm-denied').classList.toggle('hidden', p !== 'denied');
    renderSourcePill();
  }
  function renderSourcePill() {
    var live = state.settings.dataSource === 'live';
    var pill = $('source-pill');
    pill.textContent = live ? '실제 가격' : '데모 데이터';
    pill.classList.toggle('live', live);
  }
  function setStatus(id, ok, msg) {
    var el = $(id);
    el.className = ok ? 'ok-text' : 'err-text';
    el.textContent = msg;
  }

  function changeSource(src) {
    if (state.settings.dataSource === src) return;
    state.settings.dataSource = src;
    saveSettings();
    renderSettings();
    if (state.lastSearch) runSearch(state.lastSearch.query);
  }

  function testServer() {
    var base = serverBase();
    if (!/^https?:\/\//.test(base)) return setStatus('server-status', false, 'https://로 시작하는 주소를 넣어 주세요');
    setStatus('server-status', true, '확인 중…');
    fetch(base + '/api/health').then(function (r) { return r.json(); }).then(function (b) {
      if (!b.ok) throw new Error('응답이 이상해요');
      if (!b.token) return setStatus('server-status', false, '연결됨 · 하지만 TP_TOKEN이 없어요');
      setStatus('server-status', true, '연결됨 ✓' + (b.watch ? ' · 백그라운드 알림 가능' : ' · 백그라운드 알림(KV) 미설정'));
    }).catch(function (e) {
      setStatus('server-status', false, '연결 실패: ' + (e.message || e));
    });
  }

  // ── 서버 감시 (앱이 꺼져 있을 때 ntfy 푸시) ─────────────
  var TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
  function watchUrl() { return serverBase() + '/api/watch/' + state.settings.userId; }
  function jsonOrThrow(r) {
    return r.json().catch(function () { return {}; }).then(function (b) {
      if (!r.ok) throw new Error(b.message || b.error || ('서버 오류 (' + r.status + ')'));
      return b;
    });
  }
  function watchReady(manual) {
    var s = state.settings;
    var problem = s.dataSource !== 'live' || !serverBase() ? '실제 가격 서버를 먼저 설정해 주세요'
      : !TOPIC_RE.test(s.ntfyTopic || '') ? 'ntfy 토픽은 영문·숫자·-·_ 로만 써 주세요' : null;
    if (problem && manual) setStatus('watch-status', false, problem);
    return !problem;
  }
  function syncWatch(manual) {
    if (!watchReady(manual)) return Promise.resolve();
    var items = state.favorites.filter(function (f) {
      return f.source === 'travelpayouts' && f.status !== 'expired';
    }).map(C.toWatchItem);
    if (manual) setStatus('watch-status', true, '등록 중…');
    return fetch(watchUrl(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: state.settings.ntfyTopic, minDrop: state.settings.minDrop, items: items })
    }).then(jsonOrThrow).then(function (b) {
      if (!state.settings.watchEnabled) { state.settings.watchEnabled = true; saveSettings(); }
      if (manual) setStatus('watch-status', true, '등록 완료 · ' + b.items.length + '개 항공편을 서버가 지켜봐요');
    }).catch(function (e) {
      if (manual) setStatus('watch-status', false, '등록 실패: ' + (e.message || e));
    });
  }
  var watchTimer = null;
  function scheduleWatchSync() {
    if (!state.settings.watchEnabled) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(function () { syncWatch(false); }, 1500);
  }
  function pullWatch() {
    if (!state.settings.watchEnabled || !watchReady(false)) return Promise.resolve();
    return fetch(watchUrl()).then(jsonOrThrow).then(function (doc) {
      state.favorites = C.mergeServerWatch(state.favorites, doc);
      saveFavorites();
      renderFavorites();
    }).catch(function () { /* 서버가 꺼져 있어도 앱은 계속 동작 */ });
  }
  function testPush() {
    if (!watchReady(true)) return;
    setStatus('watch-status', true, '보내는 중…');
    syncWatch(false).then(function () {
      return fetch(watchUrl() + '/test', { method: 'POST' });
    }).then(jsonOrThrow).then(function () {
      setStatus('watch-status', true, '보냈어요! ntfy 앱에서 "' + state.settings.ntfyTopic + '" 토픽을 확인하세요');
    }).catch(function (e) {
      setStatus('watch-status', false, '실패: ' + (e.message || e));
    });
  }

  // ── 데모: 가격 하락 시뮬레이션 ──────────────────────────
  function simulateDrop() {
    var demoFavs = state.favorites.filter(function (f) { return f.source === 'demo' && f.status !== 'expired'; });
    if (!demoFavs.length) return toast('먼저 검색 결과에서 ☆를 눌러 항공편을 담아 주세요');
    var base = state.settings.demoEpochOffset || 0;
    var btn = $('simulate-drop');
    btn.disabled = true;
    var k = 1;
    (function tryNext() {
      var provider = C.createDemoProvider({ epochOffset: base + k });
      C.checkFavorites(state.favorites, provider, { minDrop: state.settings.minDrop }).then(function (res) {
        if (!res.alerts.length && k < 64) { k++; return tryNext(); }
        state.settings.demoEpochOffset = base + k;
        saveSettings();
        btn.disabled = false;
        location.hash = '#favorites';
        runCheck({ manual: true, prefix: '⏩ ' + (k * 3) + '시간 뒤로 이동했어요' });
      });
    })();
  }

  // ── 서비스워커 ──────────────────────────────────────────
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(function () {
      registerPeriodicSync();
    }).catch(function () { /* 오프라인 캐시·백그라운드 확인 없이 동작 */ });
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (!e.data) return;
      if (e.data.type === 'favorites-updated') reloadFromStore();
      if (e.data.type === 'open-favorites') location.hash = '#favorites';
    });
  }
  // 크롬(안드로이드/PC)에서 홈 화면에 설치한 경우, 앱이 닫혀 있어도 가끔 확인합니다.
  function registerPeriodicSync() {
    if (!('serviceWorker' in navigator) || permission() !== 'granted') return;
    navigator.serviceWorker.ready.then(function (reg) {
      if (!reg.periodicSync || !navigator.permissions) return;
      return navigator.permissions.query({ name: 'periodic-background-sync' }).then(function (st) {
        if (st.state === 'granted') return reg.periodicSync.register('fav-check', { minInterval: 3 * 3600 * 1000 });
      });
    }).catch(function () { /* 지원하지 않는 브라우저 */ });
  }

  function reloadFromStore() {
    return Promise.all([S.get('favorites'), S.get('alerts'), S.get('settings')]).then(function (r) {
      if (r[0]) state.favorites = r[0];
      if (r[1]) state.alerts = r[1];
      if (r[2]) {
        state.settings.lastCheckAt = r[2].lastCheckAt || state.settings.lastCheckAt;
        state.settings.unseenAlerts = r[2].unseenAlerts || 0;
      }
      renderFavorites();
    });
  }

  // ── 이벤트 연결 ─────────────────────────────────────────
  function bindEvents() {
    window.addEventListener('hashchange', route);

    $('search-form').addEventListener('submit', function (e) { e.preventDefault(); runSearch(readQuery()); });
    $('depart').addEventListener('change', function () {
      var dep = $('depart').value, ret = $('return').value;
      if (dep && (!ret || ret < dep)) $('return').value = C.addDays(dep, 3);
      syncDateConstraints();
    });
    $('return').addEventListener('change', syncDateConstraints);
    $('nights-chips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-nights]');
      if (!b || !$('depart').value) return;
      $('return').value = C.addDays($('depart').value, Number(b.dataset.nights));
      syncDateConstraints();
    });

    $('direct-only').addEventListener('change', function () { state.directOnly = this.checked; renderResults(); });
    $('region-chips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-region]');
      if (!b) return;
      state.region = b.dataset.region;
      renderResults();
    });
    $('country-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-fav]');
      if (b) toggleFavorite(b.dataset.fav);
    });

    $('check-now').addEventListener('click', function () { runCheck({ manual: true }); });
    $('banner-enable').addEventListener('click', requestNotification);
    $('fav-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-remove]');
      if (b) removeFavorite(b.dataset.remove);
    });
    $('fav-list').addEventListener('change', function (e) {
      if (e.target.dataset.target) setTarget(e.target.dataset.target, e.target.value);
    });
    $('fav-list').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.dataset.target) e.target.blur();
    });

    document.querySelectorAll('input[name="source"]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) changeSource(r.value); });
    });
    $('server-url').addEventListener('change', function () {
      state.settings.serverUrl = this.value.trim();
      saveSettings();
      $('server-status').textContent = '';
    });
    $('test-server').addEventListener('click', testServer);
    $('enable-notif').addEventListener('click', requestNotification);
    $('interval').addEventListener('change', function () { state.settings.intervalMin = Number(this.value); saveSettings(); });
    $('min-drop').addEventListener('change', function () {
      state.settings.minDrop = Number(this.value);
      saveSettings();
      scheduleWatchSync();
    });
    $('ntfy-topic').addEventListener('change', function () {
      state.settings.ntfyTopic = this.value.trim();
      saveSettings();
      scheduleWatchSync();
    });
    $('sync-watch').addEventListener('click', function () { syncWatch(true); });
    $('test-push').addEventListener('click', testPush);
    $('simulate-drop').addEventListener('click', simulateDrop);
    $('reset').addEventListener('click', function () {
      if (!confirm('즐겨찾기, 알림 기록, 설정을 모두 지울까요?')) return;
      var done = function () {
        try { localStorage.removeItem(LAST_QUERY_KEY); } catch (e) { /* 무관 */ }
        location.hash = '';
        location.reload();
      };
      if (state.settings.watchEnabled && serverBase()) {
        fetch(watchUrl(), { method: 'DELETE' }).catch(function () {}).then(function () { return S.clear(); }).then(done);
      } else {
        S.clear().then(done);
      }
    });
  }

  // ── 시작 ────────────────────────────────────────────────
  Promise.all([S.get('settings'), S.get('favorites'), S.get('alerts')]).then(function (r) {
    state.settings = Object.assign({}, DEFAULT_SETTINGS, r[0] || {});
    state.favorites = r[1] || [];
    state.alerts = r[2] || [];
    var changed = false;
    if (!state.settings.userId) { state.settings.userId = randomId(24); changed = true; }
    if (!state.settings.ntfyTopic) { state.settings.ntfyTopic = 'eodigaji-' + randomId(10); changed = true; }
    if (changed) saveSettings();

    initForm();
    bindEvents();
    renderSettings();
    renderFavorites();
    route();
    registerSW();
    pullWatch().then(startAutoCheck);
  });
})();
