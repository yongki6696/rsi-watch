// 웹 푸시 발송 (외부 라이브러리 없이 WebCrypto 만 사용)
//  - VAPID 서명: RFC 8292 (ES256 JWT)
//  - 내용 암호화: RFC 8291 + RFC 8188 (aes128gcm)
import { enc, concat, b64u, unb64u, randomBytes } from './util.js';

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/**
 * 구독 정보(p256dh, auth)로 내용을 암호화해 푸시 요청 본문을 만든다.
 * @returns {Promise<Uint8Array>}
 */
export async function encryptPayload(p256dhB64, authB64, plaintext, { salt = randomBytes(16), keyPair = null } = {}) {
  const uaPublic = unb64u(p256dhB64);
  const authSecret = unb64u(authB64);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('잘못된 푸시 구독 키');
  const as = keyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const body = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  const record = concat(body, new Uint8Array([2])); // 마지막 레코드 구분자
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, record));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

export async function vapidHeader({ publicKey, privateKey, subject }, endpoint, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const unsigned = `${head}.${claims}`;
  const pub = unb64u(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey}`;
}

export function pushConfigured(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/** 브라우저가 준 푸시 주소가 믿을 만한지 (사설망 주소로 요청을 보내지 않도록) */
export function validEndpoint(env, endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (env.ALLOW_INSECURE_PUSH === '1') return u.protocol === 'https:' || u.protocol === 'http:';
  if (u.protocol !== 'https:') return false;
  return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.)/i.test(u.hostname);
}

/**
 * @returns {Promise<number>} HTTP 상태 (201 성공, 404/410 은 구독 만료)
 */
export async function sendPush(env, sub, payload, subject, vapidCache = null) {
  const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(payload));
  // 같은 푸시 서비스(예: FCM, Apple)로 가는 서명은 한 번 만들어 재사용 (무료 플랜 CPU 시간 절약)
  const aud = new URL(sub.endpoint).origin;
  let auth = vapidCache && vapidCache.get(aud);
  if (!auth) {
    auth = await vapidHeader({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject }, sub.endpoint);
    if (vapidCache) vapidCache.set(aud, auth);
  }
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  return res.status;
}
