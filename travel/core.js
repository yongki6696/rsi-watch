/*
 * 어디가지 — 핵심 로직 (DOM 없음)
 *  - 데이터 공급자: 데모(가상 가격) / 실시간(Travelpayouts 프록시)
 *  - 국가별 최저가 묶기 + 시간대 섞어 5개 고르기
 *  - 즐겨찾기 가격 확인 + 알림 판단
 * 페이지 · 서비스워커 · Node 테스트에서 함께 사용합니다.
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var lib = factory(isNode ? require('./data.js') : root.TravelData);
  if (isNode) module.exports = lib;
  else root.TravelCore = lib;
})(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';

  var MINUTE = 60000;
  var DAY = 86400000;
  var PRICE_EPOCH_MS = 3 * 3600000; // 데모 가격이 바뀌는 주기
  var HISTORY_MAX = 60;

  // ── 유틸 ────────────────────────────────────────────────
  function hashStr(s) { // FNV-1a
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function unit(s) { return hashStr(s) / 4294967296; }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function round5(n) { return Math.max(5, Math.round(n / 5) * 5); }
  function byPrice(a, b) { return a.price - b.price; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function toNum(v) { var n = Number(v); return isFinite(n) && n > 0 ? Math.round(n) : null; }

  // ── 시간대 ──────────────────────────────────────────────
  // 'YYYY-MM-DDTHH:MM' 형태의 "현지 벽시계 시각"을 기본 표현으로 씁니다.
  var fmtCache = {};
  function wallInTz(ms, tz) {
    var f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }));
    var p = {};
    f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day + 'T' + (p.hour === '24' ? '00' : p.hour) + ':' + p.minute;
  }
  function wallAsUtc(wall) { return Date.parse(wall.slice(0, 16) + ':00Z'); }
  function zonedToInstant(wall, tz) {
    var guess = wallAsUtc(wall);
    var off = wallAsUtc(wallInTz(guess, tz)) - guess;
    var inst = guess - off;
    var off2 = wallAsUtc(wallInTz(inst, tz)) - inst;
    return off2 === off ? inst : guess - off2;
  }

  // ── 날짜 ────────────────────────────────────────────────
  var WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  function todayInSeoul(now) { return wallInTz(now == null ? Date.now() : now, D.HOME_TZ).slice(0, 10); }
  function addDays(date, n) { return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY); }
  function weekday(date) { return new Date(date.slice(0, 10) + 'T00:00:00Z').getUTCDay(); }

  // ── 표시 형식 ───────────────────────────────────────────
  function formatKRW(n) {
    if (n == null || !isFinite(n)) return '-';
    return '₩' + Math.round(n).toLocaleString('ko-KR');
  }
  function formatDuration(min) {
    if (!min) return '';
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + '시간' : '') + (m ? (h ? ' ' : '') + m + '분' : '');
  }
  function formatDateKo(date) {
    var d = date.slice(0, 10).split('-');
    return Number(d[1]) + '월 ' + Number(d[2]) + '일 (' + WEEKDAYS[weekday(date)] + ')';
  }
  function formatShortDate(date) {
    var d = date.slice(0, 10).split('-');
    return Number(d[1]) + '/' + Number(d[2]) + '(' + WEEKDAYS[weekday(date)] + ')';
  }
  function tripLabel(depart, ret) {
    var n = daysBetween(depart, ret);
    return n <= 0 ? '당일치기' : n + '박 ' + (n + 1) + '일';
  }

  // ── 시간대(새벽/오전/오후/저녁) ─────────────────────────
  var SLOTS = [
    { id: 'dawn', label: '새벽', from: 0, to: 6 },
    { id: 'morning', label: '오전', from: 6, to: 12 },
    { id: 'afternoon', label: '오후', from: 12, to: 18 },
    { id: 'evening', label: '저녁', from: 18, to: 24 }
  ];
  var SLOT_LABEL = {};
  SLOTS.forEach(function (s) { SLOT_LABEL[s.id] = s.label; });
  function slotOf(wall) {
    var h = parseInt(wall.slice(11, 13), 10);
    for (var i = 0; i < SLOTS.length; i++) if (h >= SLOTS[i].from && h < SLOTS[i].to) return SLOTS[i].id;
    return 'evening';
  }

  // ── 참조 데이터 조회 ────────────────────────────────────
  function flagEmoji(cc) {
    if (!/^[A-Z]{2}$/.test(cc || '') || cc === 'ZZ') return '🌐';
    return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
  }
  function countryInfo(cc, fallbackName) {
    var c = D.COUNTRIES[cc];
    return {
      code: cc || 'ZZ',
      name: c ? c[0] : (fallbackName || cc || '기타'),
      region: c ? c[1] : 'etc',
      flag: flagEmoji(cc)
    };
  }
  function airlineName(code, fallback) { var a = D.AIRLINES[code]; return a ? a[0] : (fallback || code || '항공사 미상'); }
  function airlineKind(code) { var a = D.AIRLINES[code]; return a ? a[1] : 'fsc'; }
  function originInfo(code) {
    for (var i = 0; i < D.ORIGINS.length; i++) {
      if (D.ORIGINS[i].code === code || D.ORIGINS[i].airport === code) return D.ORIGINS[i];
    }
    return { code: code, airport: code, name: code, factor: 1, longHaul: true };
  }

  // ── 예약 링크 ───────────────────────────────────────────
  function yymmdd(date) { return date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10); }
  function skyscannerUrl(from, to, depart, ret) {
    return 'https://www.skyscanner.co.kr/transport/flights/' + from.toLowerCase() + '/' + to.toLowerCase() +
      '/' + yymmdd(depart) + '/' + yymmdd(ret) + '/?adultsv2=1&cabinclass=economy&rtn=1';
  }
  function googleFlightsUrl(from, to, depart, ret) {
    return 'https://www.google.com/travel/flights?hl=ko&curr=KRW&q=' +
      encodeURIComponent('Flights to ' + to + ' from ' + from + ' on ' + depart + ' through ' + ret);
  }

  function flightId(f) {
    return [f.searchOrigin, f.dest, f.flightNo, f.out.dep, f.back.dep].join('|');
  }

  // ── 데모 공급자 (가상 가격) ─────────────────────────────
  // 같은 날짜·노선이면 같은 스케줄이 나오고, 가격은 3시간마다 조금씩 변합니다.
  var SLOT_WEIGHTS = [['dawn', 0.12], ['morning', 0.36], ['afternoon', 0.28], ['evening', 0.24]];
  var SLOT_HOURS = {
    dawn: [0, 1, 1, 2, 5, 5],
    morning: [6, 7, 8, 9, 10, 11],
    afternoon: [12, 13, 14, 15, 16, 17],
    evening: [18, 19, 20, 21, 22, 23]
  };
  var MONTH_FACTOR = [1.15, 1.05, 0.9, 0.92, 1.0, 0.95, 1.2, 1.25, 1.0, 1.05, 0.88, 1.12];
  var KIND_FACTOR = { kfsc: 1.28, fsc: 1.12, hsc: 0.95, lcc: 0.8 };
  var OUT_SLOT_FACTOR = { dawn: 0.86, morning: 1.08, afternoon: 1.0, evening: 0.95 };
  var BACK_SLOT_FACTOR = { dawn: 0.92, morning: 0.97, afternoon: 1.03, evening: 1.07 };

  function pickSlot(r) {
    var acc = 0;
    for (var i = 0; i < SLOT_WEIGHTS.length; i++) { acc += SLOT_WEIGHTS[i][1]; if (r < acc) return SLOT_WEIGHTS[i][0]; }
    return 'evening';
  }
  function pickTime(rnd, slot) {
    var hours = SLOT_HOURS[slot];
    return pad(hours[Math.floor(rnd() * hours.length)]) + ':' + pad(Math.floor(rnd() * 12) * 5);
  }
  function dateFactor(departDate, returnDate, now) {
    var f = MONTH_FACTOR[Number(departDate.slice(5, 7)) - 1];
    var md = departDate.slice(5);
    if (md >= '12-20' || md <= '01-02') f *= 1.18; // 연말연시
    var wd = weekday(departDate);
    if (wd === 5 || wd === 6) f *= 1.08; else if (wd === 2 || wd === 3) f *= 0.94;
    if (weekday(returnDate) === 0) f *= 1.06;
    var nights = daysBetween(departDate, returnDate);
    if (nights <= 2) f *= 1.05; else if (nights > 14) f *= 1.08;
    var lead = daysBetween(todayInSeoul(now), departDate);
    if (lead < 7) f *= 1.35; else if (lead < 21) f *= 1.15; else if (lead > 180) f *= 1.05;
    return f;
  }

  function makeDemoFlight(origin, city, q, airline, stops, rnd, df, epoch) {
    var outSlot = pickSlot(rnd()), backSlot = pickSlot(rnd());
    var outTime = pickTime(rnd, outSlot), backTime = pickTime(rnd, backSlot);
    var num = 100 + (hashStr(airline + city.code + outTime) % 1800);
    var baseMin = stops ? Math.round(city.minutes * 1.18) : city.minutes;
    var outDur = round5(baseMin + (stops ? 90 + Math.floor(rnd() * 48) * 5 : 0) + rnd() * 20 - 10);
    var backDur = round5(baseMin + (stops ? 90 + Math.floor(rnd() * 48) * 5 : 0) + rnd() * 40 - 10);
    var outDep = q.departDate + 'T' + outTime;
    var backDep = q.returnDate + 'T' + backTime;
    var staticNoise = 0.9 + rnd() * 0.2;

    var f = {
      searchOrigin: origin.code, origin: origin.airport,
      destCity: city.code, dest: city.airport, destName: city.name, country: city.country,
      airline: airline, airlineName: airlineName(airline),
      flightNo: airline + num, flightNumber: String(num),
      out: {
        dep: outDep,
        arr: wallInTz(zonedToInstant(outDep, D.HOME_TZ) + outDur * MINUTE, city.tz),
        durationMin: outDur, stops: stops
      },
      back: {
        dep: backDep,
        arr: wallInTz(zonedToInstant(backDep, city.tz) + backDur * MINUTE, D.HOME_TZ),
        durationMin: backDur, stops: stops
      },
      currency: 'KRW', source: 'demo'
    };
    f.id = flightId(f);
    var drift = 0.94 + unit(f.id + '#' + epoch) * 0.12;
    var price = city.basePrice * origin.factor * df * KIND_FACTOR[airlineKind(airline)] *
      (stops ? 0.74 : 1) * OUT_SLOT_FACTOR[outSlot] * BACK_SLOT_FACTOR[backSlot] * staticNoise * drift;
    f.price = Math.max(59000, Math.round(price / 100) * 100);
    f.bookingUrl = skyscannerUrl(f.origin, f.dest, q.departDate, q.returnDate);
    return f;
  }

  function demoCityFlights(origin, city, q, df, epoch) {
    var rnd = mulberry32(hashStr([origin.code, city.code, q.departDate, q.returnDate].join('|')));
    var airlines = city.airlines;
    var n = Math.min(10, Math.max(4, airlines.length + 2 + Math.floor(rnd() * 3)));
    if (!origin.longHaul) n = Math.max(3, Math.round(n * 0.6));
    var list = [];
    for (var i = 0; i < n; i++) {
      var airline = airlines[(i + Math.floor(rnd() * airlines.length)) % airlines.length];
      list.push(makeDemoFlight(origin, city, q, airline, 0, rnd, df, epoch));
    }
    if (origin.longHaul && city.minutes >= 450) { // 장거리는 저렴한 경유편도 섞기
      var hubs = D.CONNECTING[countryInfo(city.country).region] || [];
      for (var k = 0; k < Math.min(2, hubs.length); k++) {
        list.push(makeDemoFlight(origin, city, q, hubs[Math.floor(rnd() * hubs.length)], 1, rnd, df, epoch));
      }
    }
    return dedupeFlights(list);
  }

  function createDemoProvider(opts) {
    opts = opts || {};
    return {
      source: 'demo',
      label: '데모 데이터 (가상 가격)',
      search: function (q) {
        var now = opts.now ? opts.now() : Date.now();
        var epoch = Math.floor(now / PRICE_EPOCH_MS) + (opts.epochOffset || 0);
        var origin = originInfo(q.origin);
        var df = dateFactor(q.departDate, q.returnDate, now);
        var flights = [];
        D.CITIES.forEach(function (c) {
          if (q.destination ? (c.code !== q.destination && c.airport !== q.destination)
            : (!origin.longHaul && c.minutes > 420)) return;
          flights.push.apply(flights, demoCityFlights(origin, c, q, df, epoch));
        });
        flights.sort(byPrice);
        return Promise.resolve({ flights: flights, fetchedAt: new Date(now).toISOString(), source: 'demo' });
      }
    };
  }

  // ── 실시간 공급자 (Travelpayouts, 프록시 서버 경유) ─────
  function normalizeTpTicket(t, q) {
    if (!t || !t.departure_at || !t.return_at || !(Number(t.price) > 0)) return null;
    var city = D.CITY_INDEX[t.destination] || D.CITY_INDEX[t.destination_airport] || null;
    var destTz = (city && city.tz) || t.destination_tz || null;
    var outDur = toNum(t.duration_to), backDur = toNum(t.duration_back);
    var fn = t.flight_number != null ? String(t.flight_number) : '';
    var f = {
      searchOrigin: (q && q.origin) || t.origin,
      origin: t.origin_airport || t.origin,
      destCity: t.destination,
      dest: t.destination_airport || t.destination,
      destName: city ? city.name : (t.destination_name || t.destination),
      country: (city && city.country) || t.country_code || 'ZZ',
      countryName: t.country_name || null,
      airline: t.airline,
      airlineName: airlineName(t.airline, t.airline_name),
      flightNo: (t.airline || '') + fn,
      flightNumber: fn,
      out: {
        dep: t.departure_at.slice(0, 16),
        arr: destTz && outDur ? wallInTz(Date.parse(t.departure_at) + outDur * MINUTE, destTz) : null,
        durationMin: outDur, stops: Number(t.transfers) || 0
      },
      back: {
        dep: t.return_at.slice(0, 16),
        arr: backDur ? wallInTz(Date.parse(t.return_at) + backDur * MINUTE, D.HOME_TZ) : null,
        durationMin: backDur, stops: Number(t.return_transfers) || 0
      },
      price: Math.round(Number(t.price)),
      currency: 'KRW',
      source: 'travelpayouts'
    };
    f.bookingUrl = t.booking_url || (t.link ? 'https://www.aviasales.com' + t.link
      : googleFlightsUrl(f.origin, f.dest, f.out.dep.slice(0, 10), f.back.dep.slice(0, 10)));
    f.id = flightId(f);
    return f;
  }

  function createLiveProvider(opts) {
    var base = String((opts && opts.baseUrl) || '').trim().replace(/\/+$/, '');
    var doFetch = (opts && opts.fetch) || function (u, init) { return fetch(u, init); };
    return {
      source: 'travelpayouts',
      label: '실제 가격 (Travelpayouts)',
      search: function (q) {
        if (!base) return Promise.reject(new Error('설정에서 서버 주소를 입력해 주세요.'));
        var p = new URLSearchParams({ origin: q.origin, departure_at: q.departDate, return_at: q.returnDate });
        if (q.destination) p.set('destination', q.destination);
        return doFetch(base + '/api/prices?' + p.toString()).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (!res.ok) throw new Error(body.message || body.error || ('서버 오류 (' + res.status + ')'));
            var flights = (body.data || []).map(function (t) { return normalizeTpTicket(t, q); }).filter(Boolean);
            flights.sort(byPrice);
            return { flights: flights, fetchedAt: new Date().toISOString(), source: 'travelpayouts' };
          });
        });
      }
    };
  }

  function createProvider(settings, extra) {
    settings = settings || {};
    extra = extra || {};
    if (settings.dataSource === 'live') return createLiveProvider({ baseUrl: settings.serverUrl, fetch: extra.fetch });
    return createDemoProvider({ epochOffset: settings.demoEpochOffset || 0, now: extra.now });
  }

  // ── 국가별 묶기 + 시간대 섞기 ───────────────────────────
  function dedupeFlights(list) {
    var seen = {};
    return list.filter(function (f) { if (seen[f.id]) return false; seen[f.id] = true; return true; });
  }

  // 가장 싼 편부터 고르되, 이미 고른 시간대와 겹치면 가격에 벌점을 줘서
  // 새벽·오전·오후·저녁이 고루 섞이도록 n개를 고릅니다.
  var OUT_SLOT_PENALTY = 0.12;
  var BACK_SLOT_PENALTY = 0.06;
  function pickDiverse(flights, n) {
    n = n || 5;
    var pool = dedupeFlights(flights.slice().sort(byPrice));
    var picked = [], outCount = {}, backCount = {};
    while (picked.length < n && pool.length) {
      var bestIdx = 0, bestScore = Infinity;
      for (var i = 0; i < pool.length; i++) {
        var f = pool[i];
        var score = f.price * (1 + OUT_SLOT_PENALTY * (outCount[slotOf(f.out.dep)] || 0) +
          BACK_SLOT_PENALTY * (backCount[slotOf(f.back.dep)] || 0));
        if (score < bestScore) { bestScore = score; bestIdx = i; }
      }
      var best = pool.splice(bestIdx, 1)[0];
      picked.push(best);
      outCount[slotOf(best.out.dep)] = (outCount[slotOf(best.out.dep)] || 0) + 1;
      backCount[slotOf(best.back.dep)] = (backCount[slotOf(best.back.dep)] || 0) + 1;
    }
    return picked.sort(byPrice);
  }

  function isDirect(f) { return !f.out.stops && !f.back.stops; }

  function groupByCountry(flights, opts) {
    opts = opts || {};
    var groups = {};
    flights.forEach(function (f) {
      if (opts.directOnly && !isDirect(f)) return;
      var info = countryInfo(f.country, f.countryName);
      if (opts.region && opts.region !== 'all' && info.region !== opts.region) return;
      var g = groups[info.code] || (groups[info.code] = { info: info, all: [], cities: {} });
      g.all.push(f);
      var c = g.cities[f.destCity] || (g.cities[f.destCity] = { code: f.destCity, name: f.destName, minPrice: Infinity });
      if (f.price < c.minPrice) c.minPrice = f.price;
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      var picks = pickDiverse(g.all, opts.perCountry || 5);
      return {
        code: k, name: g.info.name, flag: g.info.flag, region: g.info.region,
        minPrice: picks[0].price,
        cities: Object.keys(g.cities).map(function (c) { return g.cities[c]; })
          .sort(function (a, b) { return a.minPrice - b.minPrice; }),
        flights: picks,
        total: g.all.length
      };
    }).sort(function (a, b) { return a.minPrice - b.minPrice || a.name.localeCompare(b.name, 'ko'); });
  }

  // ── 즐겨찾기 ────────────────────────────────────────────
  function favoriteFromFlight(f, now) {
    var iso = new Date(now == null ? Date.now() : now).toISOString();
    return {
      id: f.id, createdAt: iso, source: f.source,
      searchOrigin: f.searchOrigin, origin: f.origin,
      destCity: f.destCity, dest: f.dest, destName: f.destName,
      country: f.country, countryName: f.countryName || null,
      airline: f.airline, airlineName: f.airlineName, flightNo: f.flightNo, flightNumber: f.flightNumber,
      out: clone(f.out), back: clone(f.back),
      departDate: f.out.dep.slice(0, 10), returnDate: f.back.dep.slice(0, 10),
      bookingUrl: f.bookingUrl,
      savedPrice: f.price, lastPrice: f.price, lowestPrice: f.price,
      baseline: f.price, // 이 가격보다 내려가면 알림 (알림 후에는 새 최저가로 갱신)
      targetPrice: null, targetHit: false,
      history: [{ t: iso, p: f.price }],
      lastCheckedAt: iso, status: 'ok'
    };
  }

  function matchFlight(fav, flights) {
    var i, f;
    for (i = 0; i < flights.length; i++) if (flights[i].id === fav.id) return flights[i];
    for (i = 0; i < flights.length; i++) {
      f = flights[i];
      if (f.airline === fav.airline && f.out.dep === fav.out.dep && f.back.dep === fav.back.dep &&
        (!fav.flightNumber || !f.flightNumber || f.flightNumber === fav.flightNumber)) return f;
    }
    return null;
  }

  function alertMessage(fav, type, from, to) {
    var trip = fav.destName + ' ' + formatShortDate(fav.departDate) + '~' + formatShortDate(fav.returnDate);
    var flight = fav.airlineName + ' ' + fav.flightNo + ' · ' + fav.out.dep.slice(11, 16) + ' 출발';
    if (type === 'target') {
      return {
        title: '🎯 목표가 도달 · ' + trip,
        body: flight + '\n현재 ' + formatKRW(to) + ' (목표 ' + formatKRW(fav.targetPrice) + ' 이하)'
      };
    }
    return {
      title: '✈️ 가격 하락 · ' + trip,
      body: flight + '\n' + formatKRW(from) + ' → ' + formatKRW(to) + ' (▼' + formatKRW(from - to) + ')'
    };
  }

  function pushHistory(fav, iso, p) {
    var last = fav.history[fav.history.length - 1];
    if (!last || last.p !== p) fav.history.push({ t: iso, p: p });
    if (fav.history.length > HISTORY_MAX) fav.history = fav.history.slice(-HISTORY_MAX);
  }

  // 알림 규칙
  //  1) 즐겨찾기 이후 최저가(baseline)보다 minDrop 이상 내려가면 '가격 하락' 알림 → baseline 갱신
  //  2) 목표가를 정해두면, 목표가 이하로 처음 내려온 순간 '목표가 도달' 알림
  function applyPrice(fav, flight, iso, minDrop, alerts) {
    fav.lastCheckedAt = iso;
    delete fav.lastError;
    if (!flight) { fav.status = 'missing'; return; }
    var p = flight.price;
    var prev = fav.lastPrice;
    fav.status = 'ok';
    fav.lastPrice = p;
    fav.lowestPrice = Math.min(fav.lowestPrice != null ? fav.lowestPrice : p, p);
    if (flight.bookingUrl) fav.bookingUrl = flight.bookingUrl;
    pushHistory(fav, iso, p);

    var baseline = fav.baseline != null ? fav.baseline : fav.savedPrice;
    var dropped = p <= baseline - minDrop;
    var hasTarget = fav.targetPrice > 0;
    var hitTarget = hasTarget && p <= fav.targetPrice && !fav.targetHit;
    if (hasTarget) fav.targetHit = p <= fav.targetPrice;
    if (dropped) fav.baseline = p;
    if (dropped || hitTarget) {
      var type = hitTarget ? 'target' : 'drop';
      var from = dropped ? baseline : prev;
      var msg = alertMessage(fav, type, from, p);
      alerts.push({ id: fav.id + '@' + iso, favId: fav.id, type: type, from: from, to: p, at: iso, title: msg.title, body: msg.body });
    }
  }

  function checkFavorites(favs, provider, opts) {
    opts = opts || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var minDrop = opts.minDrop == null ? 1000 : opts.minDrop;
    var today = todayInSeoul(now);
    var iso = new Date(now).toISOString();
    var updated = favs.map(clone);
    var groups = {};
    updated.forEach(function (fav) {
      if (fav.departDate < today) { fav.status = 'expired'; return; }
      if (fav.source !== provider.source) { fav.status = 'source-mismatch'; return; }
      var key = [fav.searchOrigin, fav.destCity, fav.departDate, fav.returnDate].join('|');
      (groups[key] = groups[key] || []).push(fav);
    });
    var alerts = [], errors = [];
    return Object.keys(groups).reduce(function (chain, key) {
      return chain.then(function () {
        var g = groups[key], f0 = g[0];
        return provider.search({
          origin: f0.searchOrigin, destination: f0.destCity, departDate: f0.departDate, returnDate: f0.returnDate
        }).then(function (res) {
          g.forEach(function (fav) { applyPrice(fav, matchFlight(fav, res.flights), iso, minDrop, alerts); });
        }, function (err) {
          var m = String((err && err.message) || err);
          errors.push(m);
          g.forEach(function (fav) { fav.lastError = m; });
        });
      });
    }, Promise.resolve()).then(function () {
      return { favorites: updated, alerts: alerts, errors: errors, checkedAt: iso };
    });
  }

  // ── 서버 감시(백그라운드 알림) 동기화 ───────────────────
  function toWatchItem(fav) {
    return {
      key: fav.id,
      origin: fav.searchOrigin,
      destination: fav.destCity,
      departDate: fav.departDate,
      returnDate: fav.returnDate,
      match: { airline: fav.airline, flightNumber: fav.flightNumber, outDep: fav.out.dep, backDep: fav.back.dep },
      label: fav.destName + ' · ' + fav.airlineName + ' ' + fav.flightNo + ' · ' +
        formatShortDate(fav.departDate) + ' ' + fav.out.dep.slice(11, 16) + ' 출발',
      baseline: fav.baseline != null ? fav.baseline : fav.savedPrice,
      target: fav.targetPrice || null
    };
  }

  // 서버가 앱보다 나중에 확인한 가격이 있으면 반영합니다.
  function mergeServerWatch(favs, doc) {
    if (!doc || !doc.items) return favs;
    var byKey = {};
    doc.items.forEach(function (it) { byKey[it.key] = it; });
    return favs.map(function (fav) {
      var it = byKey[fav.id];
      if (!it || !it.lastCheckedAt || !(it.lastPrice > 0)) return fav;
      if (fav.lastCheckedAt && it.lastCheckedAt <= fav.lastCheckedAt) return fav;
      var f = clone(fav);
      f.lastCheckedAt = it.lastCheckedAt;
      f.status = it.status || 'ok';
      f.lastPrice = it.lastPrice;
      f.lowestPrice = Math.min(f.lowestPrice != null ? f.lowestPrice : it.lastPrice, it.lastPrice);
      if (it.baseline > 0) f.baseline = Math.min(f.baseline != null ? f.baseline : it.baseline, it.baseline);
      if (typeof it.targetHit === 'boolean') f.targetHit = it.targetHit;
      pushHistory(f, it.lastCheckedAt, it.lastPrice);
      return f;
    });
  }

  return {
    SLOTS: SLOTS, SLOT_LABEL: SLOT_LABEL, PRICE_EPOCH_MS: PRICE_EPOCH_MS,
    slotOf: slotOf, isDirect: isDirect,
    wallInTz: wallInTz, zonedToInstant: zonedToInstant,
    todayInSeoul: todayInSeoul, addDays: addDays, daysBetween: daysBetween, weekday: weekday,
    formatKRW: formatKRW, formatDuration: formatDuration, formatDateKo: formatDateKo,
    formatShortDate: formatShortDate, tripLabel: tripLabel,
    flagEmoji: flagEmoji, countryInfo: countryInfo, airlineName: airlineName, originInfo: originInfo,
    skyscannerUrl: skyscannerUrl, googleFlightsUrl: googleFlightsUrl, flightId: flightId,
    createDemoProvider: createDemoProvider, createLiveProvider: createLiveProvider, createProvider: createProvider,
    normalizeTpTicket: normalizeTpTicket,
    pickDiverse: pickDiverse, groupByCountry: groupByCountry,
    favoriteFromFlight: favoriteFromFlight, matchFlight: matchFlight, checkFavorites: checkFavorites,
    toWatchItem: toWatchItem, mergeServerWatch: mergeServerWatch
  };
});
