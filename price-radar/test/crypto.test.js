import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signedDate, authorization, buildQuery } from '../src/coupang.js';
import { encryptPayload, vapidHeader, validEndpoint } from '../src/push.js';
import { unb64u } from '../src/util.js';
import { makeSubscriptionKeys, decryptPush, makeVapidKeys } from './helpers.js';

test('쿠팡 서명 시각은 GMT yyMMddTHHmmssZ', () => {
  assert.equal(signedDate(new Date(Date.UTC(2026, 0, 5, 3, 4, 9))), '260105T030409Z');
});

test('쿠팡 HMAC 서명이 독립 계산과 같다', async () => {
  const query = buildQuery({ keyword: '생수 2L', limit: 10, subId: null });
  assert.equal(query, 'keyword=%EC%83%9D%EC%88%98%202L&limit=10');
  const path = '/v2/providers/affiliate_open_api/apis/openapi/v1/products/search';
  const h = await authorization({ accessKey: 'AK', secretKey: 'SK', method: 'GET', path, query, date: '260105T030409Z' });
  const expect = crypto.createHmac('sha256', 'SK').update(`260105T030409ZGET${path}${query}`).digest('hex');
  assert.equal(h, `CEA algorithm=HmacSHA256, access-key=AK, signed-date=260105T030409Z, signature=${expect}`);
});

test('푸시 내용 암호화(aes128gcm)를 받는 쪽에서 풀 수 있다', async () => {
  const keys = await makeSubscriptionKeys();
  const message = JSON.stringify({ title: '▼ 1,200원 내렸어요', body: '테스트 상품\n13,500원 → 12,300원' });
  const body = await encryptPayload(keys.p256dh, keys.auth, message);
  const out = await decryptPush(body, keys);
  assert.equal(out.text, message);
  assert.equal(out.rs, 4096);
  assert.equal(out.idlen, 65);
  // 매번 다른 salt/임시 키를 쓴다
  const again = await encryptPayload(keys.p256dh, keys.auth, message);
  assert.notDeepEqual(Buffer.from(again).subarray(0, 16), Buffer.from(body).subarray(0, 16));
});

test('VAPID 서명(ES256 JWT)이 공개키로 검증된다', async () => {
  const v = await makeVapidKeys();
  const header = await vapidHeader({ publicKey: v.publicKey, privateKey: v.privateKey, subject: 'https://radar.example' }, 'https://fcm.googleapis.com/fcm/send/abc', Date.UTC(2026, 0, 1));
  const m = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, header);
  assert.equal(m[4], v.publicKey);
  const claims = JSON.parse(Buffer.from(unb64u(m[2])).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://radar.example');
  assert.equal(claims.exp, Date.UTC(2026, 0, 1) / 1000 + 12 * 3600);
  const ok = await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, v.verifyKey, unb64u(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
  assert.equal(ok, true);
});

test('사설망/평문 푸시 주소는 거절한다', () => {
  const env = {};
  assert.equal(validEndpoint(env, 'https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(validEndpoint(env, 'https://web.push.apple.com/abc'), true);
  assert.equal(validEndpoint(env, 'http://fcm.googleapis.com/x'), false);
  assert.equal(validEndpoint(env, 'https://127.0.0.1/x'), false);
  assert.equal(validEndpoint(env, 'https://192.168.0.5/x'), false);
  assert.equal(validEndpoint(env, 'https://localhost/x'), false);
});
