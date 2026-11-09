/*
 * 어디가지 — Cloudflare Worker
 *  GET    /api/health              서버 상태
 *  GET    /api/prices              Travelpayouts 가격 조회 프록시 (토큰 숨김 + CORS + 도시/항공사 이름 보강)
 *  PUT    /api/watch/:id           즐겨찾기 감시 목록 저장 (KV)
 *  GET    /api/watch/:id           감시 목록 + 서버가 확인한 최신 가격
 *  DELETE /api/watch/:id           감시 목록 삭제
 *  POST   /api/watch/:id/test      ntfy 테스트 푸시
 *  cron   3시간마다                감시 목록 가격 확인 → 최저가 갱신 시 ntfy 푸시
 *
 * 환경 변수
 *  TP_TOKEN (secret)  Travelpayouts API 토큰  — 필수
 *  WATCH (KV binding) 백그라운드 알림용      — 선택
 *  ALLOWED_ORIGIN     CORS 허용 출처 (기본 *)
 *  APP_URL            알림을 눌렀을 때 열 앱 주소
 *  TP_MARKER          Travelpayouts 제휴 마커 (예약 링크에 붙음, 선택)
 *  TP_MARKET          데이터 마켓 (예: kr, 선택)
 *  NTFY_SERVER        ntfy 서버 (기본 https://ntfy.sh)
 */

const TP_API = 'https://api.travelpayouts.com';
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IATA_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 30;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) }
  });
}

// ── 참조 데이터 (도시·국가·항공사 이름, 시간대) ─────────────
let metaPromise = null;
async function loadMeta() {
  if (!metaPromise) {
    metaPromise = (async () => {
      const get = (path) => fetch(TP_API + path, { cf: { cacheTtl: 86400, cacheEverything: true } })
        .then((r) => (r.ok ? r.json() : []));
      const [cities, countries, airlines] = await Promise.all([
        get('/data/en/cities.json'), get('/data/en/countries.json'), get('/data/en/airlines.json')
      ]);
      const meta = { cities: {}, countries: {}, airlines: {} };
      for (const c of cities) meta.cities[c.code] = [c.name, c.country_code, c.time_zone];
      for (const c of countries) meta.countries[c.code] = c.name;
      for (const a of airlines) meta.airlines[a.code] = a.name;
      return meta;
    })().catch((err) => {
      metaPromise = null; // 다음 요청에서 다시 시도
      throw err;
    });
  }
  return metaPromise;
}

async function fetchTickets(params, env) {
  if (!env.TP_TOKEN) throw new HttpError(500, 'no_token', '서버에 TP_TOKEN이 설정되지 않았어요.');
  const qs = new URLSearchParams({
    origin: params.origin,
    departure_at: params.departDate,
    return_at: params.returnDate,
    one_way: 'false',
    sorting: 'price',
    currency: 'krw',
    limit: '1000'
  });
  if (params.destination) qs.set('destination', params.destination);
  if (env.TP_MARKET) qs.set('market', env.TP_MARKET);
  const res = await fetch(`${TP_API}/aviasales/v3/prices_for_dates?${qs}`, {
    headers: { 'X-Access-Token': env.TP_TOKEN },
    cf: { cacheTtl: 600, cacheEverything: true }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new HttpError(502, 'upstream', `Travelpayouts 오류 (${res.status}) ${body.error || ''}`.trim());
  }
  return Array.isArray(body.data) ? body.data : [];
}

function readQuery(sp) {
  const q = {
    origin: (sp.get('origin') || '').toUpperCase(),
    destination: (sp.get('destination') || '').toUpperCase(),
    departDate: sp.get('departure_at') || '',
    returnDate: sp.get('return_at') || ''
  };
  if (!IATA_RE.test(q.origin)) throw new HttpError(400, 'bad_origin', '출발지 코드가 올바르지 않아요.');
  if (q.destination && !IATA_RE.test(q.destination)) throw new HttpError(400, 'bad_destination', '도착지 코드가 올바르지 않아요.');
  if (!DATE_RE.test(q.departDate) || !DATE_RE.test(q.returnDate)) {
    throw new HttpError(400, 'bad_date', '날짜는 YYYY-MM-DD 형식이어야 해요.');
  }
  return q;
}

async function handlePrices(url, env) {
  const tickets = await fetchTickets(readQuery(url.searchParams), env);
  let meta = null;
  try { meta = await loadMeta(); } catch (e) { meta = null; } // 이름 보강 실패해도 가격은 돌려줌
  const marker = env.TP_MARKER ? `&marker=${encodeURIComponent(env.TP_MARKER)}` : '';
  const data = tickets.map((t) => {
    const city = meta && (meta.cities[t.destination] || meta.cities[t.destination_airport]);
    const cc = city && city[1];
    return {
      ...t,
      destination_name: city ? city[0] : undefined,
      country_code: cc || undefined,
      country_name: cc && meta ? meta.countries[cc] : undefined,
      destination_tz: city ? city[2] : undefined,
      airline_name: meta ? meta.airlines[t.airline] : undefined,
      booking_url: t.link ? `https://www.aviasales.com${t.link}${marker}` : undefined
    };
  });
  return { currency: 'krw', data };
}

// ── 감시 목록 ───────────────────────────────────────────────
function cleanItem(it) {
  if (!it || typeof it.key !== 'string' || it.key.length > 200) return null;
  if (!IATA_RE.test(it.origin || '') || !IATA_RE.test(it.destination || '')) return null;
  if (!DATE_RE.test(it.departDate || '') || !DATE_RE.test(it.returnDate || '')) return null;
  const m = it.match || {};
  if (typeof m.airline !== 'string' || typeof m.outDep !== 'string' || typeof m.backDep !== 'string') return null;
  const baseline = Number(it.baseline);
  if (!(baseline > 0)) return null;
  return {
    key: it.key,
    origin: it.origin,
    destination: it.destination,
    departDate: it.departDate,
    returnDate: it.returnDate,
    match: {
      airline: m.airline.slice(0, 3),
      flightNumber: String(m.flightNumber || '').slice(0, 8),
      outDep: m.outDep.slice(0, 16),
      backDep: m.backDep.slice(0, 16)
    },
    label: String(it.label || '').slice(0, 120),
    baseline: Math.round(baseline),
    target: Number(it.target) > 0 ? Math.round(Number(it.target)) : null
  };
}

async function putWatch(id, request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !TOPIC_RE.test(body.topic || '')) throw new HttpError(400, 'bad_topic', 'ntfy 토픽이 올바르지 않아요.');
  const items = (Array.isArray(body.items) ? body.items : []).map(cleanItem).filter(Boolean);
  if (items.length > MAX_ITEMS) throw new HttpError(400, 'too_many', `최대 ${MAX_ITEMS}개까지 감시할 수 있어요.`);
  const prev = (await env.WATCH.get(`watch:${id}`, 'json')) || { items: [] };
  const prevByKey = Object.fromEntries(prev.items.map((it) => [it.key, it]));
  const doc = {
    topic: body.topic,
    minDrop: Number(body.minDrop) > 0 ? Math.round(Number(body.minDrop)) : 1000,
    updatedAt: new Date().toISOString(),
    items: items.map((it) => {
      const old = prevByKey[it.key];
      if (!old) return it;
      // 서버가 이미 더 낮은 가격으로 알렸다면 그 기준을 유지 (같은 알림 반복 방지)
      return {
        ...it,
        baseline: Math.min(it.baseline, old.baseline),
        targetHit: it.target === old.target ? old.targetHit : undefined,
        lastPrice: old.lastPrice,
        lastCheckedAt: old.lastCheckedAt,
        status: old.status
      };
    })
  };
  await env.WATCH.put(`watch:${id}`, JSON.stringify(doc));
  return doc;
}

async function sendNtfy(env, payload) {
  const res = await fetch(env.NTFY_SERVER || 'https://ntfy.sh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      tags: payload.tags || ['airplane'],
      ...(env.APP_URL ? { click: `${env.APP_URL.replace(/#.*$/, '')}#favorites` } : {})
    })
  });
  if (!res.ok) throw new HttpError(502, 'ntfy', `ntfy 전송 실패 (${res.status})`);
}

function won(n) { return '₩' + Math.round(n).toLocaleString('ko-KR'); }

function findTicket(tickets, m) {
  const same = (t) => t.airline === m.airline &&
    String(t.departure_at || '').slice(0, 16) === m.outDep &&
    String(t.return_at || '').slice(0, 16) === m.backDep;
  return tickets.find((t) => same(t) && (!m.flightNumber || String(t.flight_number) === m.flightNumber)) ||
    tickets.find(same) || null;
}

function todayKST(now) {
  return new Date(now + 9 * 3600000).toISOString().slice(0, 10);
}

export async function runWatchers(env, now = Date.now()) {
  if (!env.WATCH || !env.TP_TOKEN) return { users: 0, sent: 0 };
  const today = todayKST(now);
  const iso = new Date(now).toISOString();
  const cache = new Map();
  let users = 0, sent = 0, cursor;
  do {
    const page = await env.WATCH.list({ prefix: 'watch:', cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const k of page.keys) {
      const doc = await env.WATCH.get(k.name, 'json');
      if (!doc || !doc.items || !doc.items.length) continue;
      users++;
      let changed = false;
      for (const it of doc.items) {
        if (it.departDate < today) continue;
        const ck = [it.origin, it.destination, it.departDate, it.returnDate].join('|');
        if (!cache.has(ck)) {
          cache.set(ck, await fetchTickets(it, env).catch(() => null));
        }
        const tickets = cache.get(ck);
        if (!tickets) continue;
        const t = findTicket(tickets, it.match);
        changed = true;
        it.lastCheckedAt = iso;
        if (!t) { it.status = 'missing'; continue; }
        const price = Math.round(Number(t.price));
        it.status = 'ok';
        it.lastPrice = price;
        const dropped = price <= it.baseline - (doc.minDrop || 1000);
        const hitTarget = it.target > 0 && price <= it.target && !it.targetHit;
        if (it.target > 0) it.targetHit = price <= it.target;
        if (dropped || hitTarget) {
          const title = hitTarget ? '🎯 목표가 도달' : '✈️ 가격 하락';
          const message = `${it.label}\n` + (dropped
            ? `${won(it.baseline)} → ${won(price)} (▼${won(it.baseline - price)})`
            : `현재 ${won(price)} (목표 ${won(it.target)} 이하)`);
          try {
            await sendNtfy(env, { topic: doc.topic, title, message, priority: 4 });
            sent++;
          } catch (e) { /* 다음 주기에 다시 시도 */ }
        }
        if (dropped) it.baseline = price;
      }
      if (changed) await env.WATCH.put(k.name, JSON.stringify(doc));
    }
  } while (cursor);
  return { users, sent };
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

  if (url.pathname === '/api/health') {
    return json({ ok: true, token: Boolean(env.TP_TOKEN), watch: Boolean(env.WATCH) }, 200, env);
  }
  if (url.pathname === '/api/prices' && request.method === 'GET') {
    return json(await handlePrices(url, env), 200, env);
  }

  const m = url.pathname.match(/^\/api\/watch\/([^/]+)(\/test)?$/);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad_id', '잘못된 사용자 ID예요.');
    if (!env.WATCH) throw new HttpError(501, 'watch_disabled', '서버에 KV(WATCH)가 연결되지 않았어요.');
    const key = `watch:${id}`;
    if (m[2]) {
      if (request.method !== 'POST') throw new HttpError(405, 'method');
      const doc = await env.WATCH.get(key, 'json');
      if (!doc) throw new HttpError(404, 'not_found', '먼저 즐겨찾기를 서버에 등록해 주세요.');
      await sendNtfy(env, {
        topic: doc.topic,
        title: '어디가지 테스트 알림 🔔',
        message: `연결됐어요! 즐겨찾기 ${doc.items.length}개를 3시간마다 확인해서 가격이 내려가면 알려드릴게요.`
      });
      return json({ ok: true }, 200, env);
    }
    if (request.method === 'PUT') return json(await putWatch(id, request, env), 200, env);
    if (request.method === 'GET') {
      const doc = await env.WATCH.get(key, 'json');
      if (!doc) throw new HttpError(404, 'not_found', '등록된 감시 목록이 없어요.');
      return json(doc, 200, env);
    }
    if (request.method === 'DELETE') {
      await env.WATCH.delete(key);
      return json({ ok: true }, 200, env);
    }
    throw new HttpError(405, 'method');
  }
  throw new HttpError(404, 'not_found');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.code || 'internal', message: err.message || String(err) }, status, env);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWatchers(env));
  }
};
