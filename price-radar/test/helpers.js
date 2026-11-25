// 테스트 도우미: Node 내장 SQLite 로 만든 D1 흉내, 푸시 복호화(받는 쪽), 가짜 쿠팡 API 서버
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import crypto from 'node:crypto';
import { concat, unb64u, b64u, enc } from '../src/util.js';
import { API_PATH } from '../src/coupang.js';

function norm(v) {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: undefined 는 바인딩할 수 없어요');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** Cloudflare D1 과 같은 모양(prepare/bind/first/all/run/batch)의 메모리 DB */
export function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  const counter = { n: 0 }; // 실행된 문장 수 (무료 플랜 쿼리 한도 검사용)
  const make = (sql, params = []) => ({
    bind: (...p) => make(sql, p.map(norm)),
    first: async (col) => {
      counter.n++;
      const r = sqlite.prepare(sql).get(...params);
      if (r === undefined) return null;
      const obj = { ...r };
      return col ? obj[col] : obj;
    },
    all: async () => { counter.n++; return { results: sqlite.prepare(sql).all(...params).map((r) => ({ ...r })), success: true }; },
    run: async () => {
      counter.n++;
      const r = sqlite.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => make(sql),
    batch: async (stmts) => {
      const out = [];
      sqlite.exec('BEGIN');
      try { for (const s of stmts) out.push(await s.run()); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
      return out;
    },
    _sqlite: sqlite,
    get count() { return counter.n; },
  };
}

/** 브라우저 쪽 푸시 구독 키 만들기 */
export async function makeSubscriptionKeys() {
  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.randomBytes(16);
  return { privateKey: pair.privateKey, p256dh: b64u(pub), auth: b64u(auth), pub, authBytes: new Uint8Array(auth) };
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.webcrypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

/** RFC 8291 받는 쪽 복호화 — 우리가 보낸 푸시가 표준대로 암호화됐는지 확인용 */
export async function decryptPush(body, keys) {
  const b = new Uint8Array(body);
  const salt = b.slice(0, 16);
  const rs = new DataView(b.buffer, b.byteOffset).getUint32(16);
  const idlen = b[20];
  const asPublic = b.slice(21, 21 + idlen);
  const cipher = b.slice(21 + idlen);
  const asKey = await crypto.webcrypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.webcrypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, keys.privateKey, 256));
  const ikm = await hkdf(keys.authBytes, shared, concat(enc.encode('WebPush: info\0'), keys.pub, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.webcrypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, cipher));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('마지막 레코드 구분자가 없어요');
  return { text: new TextDecoder().decode(plain.slice(0, end)), rs, idlen };
}

export async function makeVapidKeys() {
  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.webcrypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64u(pub), privateKey: jwk.d, verifyKey: pair.publicKey };
}

export function verifyCoupangSignature(req, accessKey, secretKey) {
  const h = req.headers.authorization || '';
  const m = h.match(/^CEA algorithm=HmacSHA256, access-key=([^,]+), signed-date=(\d{6}T\d{6}Z), signature=([0-9a-f]{64})$/);
  if (!m) return 'bad header';
  if (m[1] !== accessKey) return 'bad access key';
  const u = new URL(req.url, 'http://x');
  const query = u.search.replace(/^\?/, '');
  const expect = crypto.createHmac('sha256', secretKey).update(`${m[2]}${req.method}${u.pathname}${query}`).digest('hex');
  return expect === m[3] ? null : 'bad signature';
}

/**
 * 가짜 쿠팡 파트너스 API. 서명을 실제처럼 검증한다.
 * catalog: { [productId]: { name, price, keywords: [...] } }
 */
export function startFakePartners({ accessKey = 'test-access', secretKey = 'test-secret', catalog = {}, failWith = null } = {}) {
  const calls = [];
  const state = { catalog, failWith };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams) });
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const bad = verifyCoupangSignature(req, accessKey, secretKey);
    if (bad) return send(401, { rCode: '401', rMessage: `Unauthorized: ${bad}` });
    if (state.failWith) return send(state.failWith.status, state.failWith.body);
    const item = ([id, p]) => ({ productId: Number(id), productName: p.name, productPrice: p.price, productImage: `https://img.test/${id}.jpg`, productUrl: `https://link.coupang.com/re/AFFSDP?pid=${id}`, isRocket: true, isFreeShipping: true, categoryName: '테스트' });
    if (req.method === 'GET' && u.pathname === `${API_PATH}/products/search`) {
      const kw = (u.searchParams.get('keyword') || '').toLowerCase();
      const limit = Number(u.searchParams.get('limit') || 10);
      const hits = Object.entries(state.catalog).filter(([, p]) => p.keywords.some((k) => kw.includes(k.toLowerCase()) || k.toLowerCase().includes(kw)));
      return send(200, { rCode: '0', rMessage: '', data: { landingUrl: 'https://link.coupang.com/a/test', productData: hits.slice(0, limit).map((e, i) => ({ ...item(e), rank: i + 1, keyword: kw })) } });
    }
    if (req.method === 'GET' && u.pathname === `${API_PATH}/products/goldbox`) {
      return send(200, { rCode: '0', rMessage: '', data: Object.entries(state.catalog).slice(0, 5).map(item) });
    }
    if (req.method === 'GET' && u.pathname.startsWith(`${API_PATH}/products/bestcategories/`)) {
      return send(200, { rCode: '0', rMessage: '', data: Object.entries(state.catalog).slice(0, 3).map(item) });
    }
    if (req.method === 'POST' && u.pathname === `${API_PATH}/deeplink`) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        send(200, { rCode: '0', rMessage: '', data: (body.coupangUrls || []).map((x) => ({ originalUrl: x, shortenUrl: `https://link.coupang.com/a/dl${calls.length}`, landingUrl: x })) });
      });
      return undefined;
    }
    return send(404, { rCode: '404', rMessage: 'not found' });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, calls, state, base: `http://127.0.0.1:${srv.address().port}`, accessKey, secretKey })));
}
