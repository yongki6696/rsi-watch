'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const NOW = Date.parse('2026-11-09T03:00:00Z'); // 2026-11-09 12:00 KST
const Q = { origin: 'SEL', departDate: '2026-12-18', returnDate: '2026-12-22' };

function flight(over) {
  const f = {
    searchOrigin: 'SEL', origin: 'ICN', destCity: 'TYO', dest: 'NRT', destName: '도쿄', country: 'JP',
    airline: 'KE', airlineName: '대한항공', flightNo: 'KE701', flightNumber: '701',
    out: { dep: '2026-12-18T09:00', arr: '2026-12-18T11:20', durationMin: 140, stops: 0 },
    back: { dep: '2026-12-22T19:00', arr: '2026-12-22T21:30', durationMin: 150, stops: 0 },
    price: 300000, currency: 'KRW', source: 'demo', bookingUrl: 'https://example.com'
  };
  Object.assign(f, over);
  f.id = C.flightId(f);
  return f;
}

test('time helpers handle offsets and DST', () => {
  assert.equal(C.wallInTz(Date.parse('2026-12-18T00:00:00Z'), 'Asia/Seoul'), '2026-12-18T09:00');
  // 파리 여름(UTC+2) / 겨울(UTC+1)
  assert.equal(C.zonedToInstant('2026-07-01T12:00', 'Europe/Paris'), Date.parse('2026-07-01T10:00:00Z'));
  assert.equal(C.zonedToInstant('2026-12-01T12:00', 'Europe/Paris'), Date.parse('2026-12-01T11:00:00Z'));
  assert.equal(C.slotOf('2026-12-18T05:59'), 'dawn');
  assert.equal(C.slotOf('2026-12-18T06:00'), 'morning');
  assert.equal(C.slotOf('2026-12-18T12:00'), 'afternoon');
  assert.equal(C.slotOf('2026-12-18T23:55'), 'evening');
  assert.equal(C.tripLabel('2026-12-18', '2026-12-22'), '4박 5일');
  assert.equal(C.formatKRW(1234500), '₩1,234,500');
  assert.equal(C.formatDuration(145), '2시간 25분');
});

test('demo provider is deterministic within a price period and changes across periods', async () => {
  const a = await C.createDemoProvider({ now: () => NOW }).search(Q);
  const b = await C.createDemoProvider({ now: () => NOW + 60000 }).search(Q);
  assert.ok(a.flights.length > 100, 'expected many flights');
  assert.deepEqual(a.flights.map((f) => f.id + f.price), b.flights.map((f) => f.id + f.price));

  const later = await C.createDemoProvider({ now: () => NOW, epochOffset: 1 }).search(Q);
  const priceById = Object.fromEntries(a.flights.map((f) => [f.id, f.price]));
  const changed = later.flights.filter((f) => priceById[f.id] !== f.price).length;
  assert.equal(later.flights.length, a.flights.length, 'schedule stays the same');
  assert.ok(changed > later.flights.length / 2, 'most prices drift between periods');

  for (const f of a.flights) {
    assert.equal(f.out.dep.slice(0, 10), Q.departDate);
    assert.equal(f.back.dep.slice(0, 10), Q.returnDate);
    assert.ok(f.price >= 59000 && f.price % 100 === 0);
  }
});

test('regional origins only get short/medium-haul destinations', async () => {
  const res = await C.createDemoProvider({ now: () => NOW }).search({ ...Q, origin: 'PUS' });
  assert.ok(res.flights.length > 0);
  assert.ok(!res.flights.some((f) => ['US', 'FR', 'GB', 'AU'].includes(f.country)));
});

test('pickDiverse keeps the cheapest and mixes departure time slots', () => {
  const morning = [0, 1, 2, 3, 4, 5].map((i) =>
    flight({ flightNo: 'KE70' + i, flightNumber: '70' + i, price: 200000 + i * 1000, out: { dep: '2026-12-18T0' + (6 + i % 4) + ':00', arr: null, durationMin: 140, stops: 0 } }));
  const evening = flight({ flightNo: 'LJ201', airline: 'LJ', price: 215000, out: { dep: '2026-12-18T20:00', arr: null, durationMin: 140, stops: 0 } });
  const dawn = flight({ flightNo: '7C1101', airline: '7C', price: 218000, out: { dep: '2026-12-18T01:00', arr: null, durationMin: 140, stops: 0 } });
  const picks = C.pickDiverse(morning.concat([evening, dawn]), 5);
  assert.equal(picks.length, 5);
  assert.equal(picks[0].price, 200000, 'cheapest is always included');
  const ids = picks.map((p) => p.flightNo);
  assert.ok(ids.includes('LJ201') && ids.includes('7C1101'), 'other slots beat 3rd+ same-slot options');
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i - 1].price <= picks[i].price, 'sorted by price');
});

test('groupByCountry sorts countries by cheapest fare and caps flights per country', async () => {
  const res = await C.createDemoProvider({ now: () => NOW }).search(Q);
  const groups = C.groupByCountry(res.flights);
  assert.ok(groups.length > 20);
  for (let i = 1; i < groups.length; i++) assert.ok(groups[i - 1].minPrice <= groups[i].minPrice);
  for (const g of groups) {
    assert.ok(g.flights.length >= 1 && g.flights.length <= 5);
    assert.equal(g.minPrice, Math.min(...res.flights.filter((f) => f.country === g.code).map((f) => f.price)));
    const slots = new Set(g.flights.map((f) => C.slotOf(f.out.dep)));
    if (g.flights.length === 5) assert.ok(slots.size >= 2, g.name + ' should mix time slots');
  }
  const direct = C.groupByCountry(res.flights, { directOnly: true });
  assert.ok(direct.every((g) => g.flights.every(C.isDirect)));
  const se = C.groupByCountry(res.flights, { region: 'se' });
  assert.ok(se.length > 0 && se.every((g) => g.region === 'se'));
});

test('normalizeTpTicket maps Travelpayouts fields and computes local arrival times', () => {
  const f = C.normalizeTpTicket({
    origin: 'SEL', destination: 'TYO', origin_airport: 'ICN', destination_airport: 'NRT',
    price: 289000, airline: 'KE', flight_number: 703,
    departure_at: '2026-12-18T09:35:00+09:00', return_at: '2026-12-22T19:10:00+09:00',
    transfers: 0, return_transfers: 1, duration_to: 145, duration_back: 300,
    link: '/search/SEL1812TYO22121?t=abc'
  }, { origin: 'SEL' });
  assert.equal(f.destName, '도쿄');
  assert.equal(f.country, 'JP');
  assert.equal(f.flightNo, 'KE703');
  assert.equal(f.out.dep, '2026-12-18T09:35');
  assert.equal(f.out.arr, '2026-12-18T12:00');
  assert.equal(f.back.arr, '2026-12-23T00:10');
  assert.equal(f.back.stops, 1);
  assert.equal(f.bookingUrl, 'https://www.aviasales.com/search/SEL1812TYO22121?t=abc');
  assert.equal(f.source, 'travelpayouts');

  // 앱이 모르는 도시는 서버가 보강한 이름·국가·시간대를 사용
  const g = C.normalizeTpTicket({
    origin: 'SEL', destination: 'VVO', price: 350000, airline: 'ZE', flight_number: '501',
    departure_at: '2026-12-18T10:00:00+09:00', return_at: '2026-12-22T12:00:00+10:00',
    duration_to: 150, duration_back: 150,
    destination_name: 'Vladivostok', country_code: 'RU', destination_tz: 'Asia/Vladivostok'
  });
  assert.equal(g.destName, 'Vladivostok');
  assert.equal(C.countryInfo(g.country).name, '러시아');
  assert.equal(g.out.arr, '2026-12-18T13:30');

  assert.equal(C.normalizeTpTicket({ price: 0, departure_at: 'x', return_at: 'y' }), null);
});

test('live provider calls the proxy and normalizes results', async () => {
  let called = '';
  const provider = C.createLiveProvider({
    baseUrl: 'https://w.example.dev/',
    fetch: async (url) => {
      called = url;
      return {
        ok: true, status: 200,
        json: async () => ({ data: [
          { origin: 'SEL', destination: 'OSA', price: 210000, airline: '7C', flight_number: 1302,
            departure_at: '2026-12-18T07:00:00+09:00', return_at: '2026-12-22T21:00:00+09:00', duration_to: 110, duration_back: 115 },
          { origin: 'SEL', destination: 'FUK', price: 150000, airline: 'TW', flight_number: 291,
            departure_at: '2026-12-18T06:00:00+09:00', return_at: '2026-12-22T20:00:00+09:00', duration_to: 85, duration_back: 85 }
        ] })
      };
    }
  });
  const res = await provider.search(Q);
  assert.match(called, /^https:\/\/w\.example\.dev\/api\/prices\?origin=SEL&departure_at=2026-12-18&return_at=2026-12-22$/);
  assert.deepEqual(res.flights.map((f) => f.destName), ['후쿠오카', '오사카']);

  const failing = C.createLiveProvider({
    baseUrl: 'https://w.example.dev',
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ message: 'no token' }) })
  });
  await assert.rejects(failing.search(Q), /no token/);
  await assert.rejects(C.createLiveProvider({}).search(Q), /서버 주소/);
});

function fakeProvider(priceFor) {
  return {
    source: 'demo',
    calls: 0,
    search(q) {
      this.calls++;
      const f = flight({});
      return Promise.resolve({ flights: [flight({ price: priceFor(f) })] });
    }
  };
}

test('checkFavorites alerts only on new lows since favoriting', async () => {
  let price = 300000;
  const p = fakeProvider(() => price);
  let favs = [C.favoriteFromFlight(flight({}), NOW)];

  price = 299500; // ₩500 하락: minDrop(1000) 미만 → 알림 없음
  let r = await C.checkFavorites(favs, p, { now: NOW });
  assert.equal(r.alerts.length, 0);
  favs = r.favorites;

  price = 280000;
  r = await C.checkFavorites(favs, p, { now: NOW });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].type, 'drop');
  assert.equal(r.alerts[0].from, 300000);
  assert.equal(r.alerts[0].to, 280000);
  assert.match(r.alerts[0].body, /₩300,000 → ₩280,000 \(▼₩20,000\)/);
  favs = r.favorites;
  assert.equal(favs[0].baseline, 280000);
  assert.equal(favs[0].lowestPrice, 280000);

  price = 320000; // 상승
  r = await C.checkFavorites(favs, p, { now: NOW });
  assert.equal(r.alerts.length, 0);
  favs = r.favorites;

  price = 290000; // 내려갔지만 이전 최저가(280,000)보다 높음 → 알림 없음
  r = await C.checkFavorites(favs, p, { now: NOW });
  assert.equal(r.alerts.length, 0);
  favs = r.favorites;

  price = 275000; // 새 최저가
  r = await C.checkFavorites(favs, p, { now: NOW });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].from, 280000);
  assert.deepEqual(r.favorites[0].history.map((h) => h.p), [300000, 299500, 280000, 320000, 290000, 275000]);
});

test('checkFavorites target price alerts once per crossing', async () => {
  let price = 300000;
  const p = fakeProvider(() => price);
  let favs = [Object.assign(C.favoriteFromFlight(flight({}), NOW), { targetPrice: 250000 })];

  price = 260000;
  let r = await C.checkFavorites(favs, p, { now: NOW });
  assert.equal(r.alerts[0].type, 'drop');
  favs = r.favorites;

  price = 300000;
  r = await C.checkFavorites(favs, p, { now: NOW });
  favs = r.favorites;
  price = 250000;
  r = await C.checkFavorites(favs, p, { now: NOW });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].type, 'target');
  favs = r.favorites;

  price = 249000; // 이미 목표가 이하 상태 → 목표가 알림은 반복하지 않음 (하락 알림만)
  r = await C.checkFavorites(favs, p, { now: NOW });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].type, 'drop');
});

test('checkFavorites skips expired / other-source favorites and batches identical routes', async () => {
  const p = fakeProvider(() => 290000);
  const a = C.favoriteFromFlight(flight({}), NOW);
  const b = C.favoriteFromFlight(flight({ flightNo: 'KE705', flightNumber: '705' }), NOW);
  const old = C.favoriteFromFlight(flight({ out: { dep: '2026-11-01T09:00', arr: null, durationMin: 140, stops: 0 } }), NOW);
  const live = Object.assign(C.favoriteFromFlight(flight({ flightNo: 'OZ101' }), NOW), { source: 'travelpayouts' });
  const r = await C.checkFavorites([a, b, old, live], p, { now: NOW });
  assert.equal(p.calls, 1, 'same route+dates searched once');
  assert.equal(r.favorites[0].status, 'ok');
  assert.equal(r.favorites[1].status, 'missing');
  assert.equal(r.favorites[2].status, 'expired');
  assert.equal(r.favorites[3].status, 'source-mismatch');

  const broken = { source: 'demo', search: () => Promise.reject(new Error('down')) };
  const r2 = await C.checkFavorites([a], broken, { now: NOW });
  assert.deepEqual(r2.errors, ['down']);
  assert.equal(r2.favorites[0].lastError, 'down');
});

test('matchFlight falls back to airline + times when ids differ', () => {
  const fav = C.favoriteFromFlight(flight({}), NOW);
  const renamed = flight({ dest: 'HND' }); // 다른 공항 코드로 와도 같은 항공편
  assert.equal(C.matchFlight(fav, [renamed]), renamed);
  assert.equal(C.matchFlight(fav, [flight({ flightNumber: '999', flightNo: 'KE999', dest: 'HND' })]), null);
});

test('watch items and server merge round-trip', () => {
  const fav = C.favoriteFromFlight(flight({}), NOW);
  const item = C.toWatchItem(fav);
  assert.deepEqual(item.match, { airline: 'KE', flightNumber: '701', outDep: '2026-12-18T09:00', backDep: '2026-12-22T19:00' });
  assert.equal(item.baseline, 300000);

  const later = new Date(NOW + 3600000).toISOString();
  const merged = C.mergeServerWatch([fav], { items: [{ key: fav.id, lastPrice: 270000, baseline: 270000, lastCheckedAt: later, status: 'ok' }] });
  assert.equal(merged[0].lastPrice, 270000);
  assert.equal(merged[0].baseline, 270000);
  assert.equal(merged[0].history.length, 2);

  const stale = C.mergeServerWatch(merged, { items: [{ key: fav.id, lastPrice: 999999, lastCheckedAt: new Date(NOW).toISOString() }] });
  assert.equal(stale[0].lastPrice, 270000, 'older server data is ignored');
});
