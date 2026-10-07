// 실행: node --test instagram-auto-dm/
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from './worker.js';

const ACCOUNT_ID = '17841400000000000';
const OWN_USERNAME = 'my_account';
const baseEnv = {
  APP_SECRET: 'app-secret',
  VERIFY_TOKEN: 'verify-me',
  IG_ACCESS_TOKEN: 'original-token-AAAAAAAAAAAAAAAAAAAA',
  DM_MESSAGE: '@{username}님 링크 보내드려요',
};

// 워커 로그가 node:test 출력과 섞이지 않게 숨김
for (const level of ['log', 'warn', 'error']) console[level] = () => {};

let calls;
let failPaths;
beforeEach(() => {
  calls = [];
  failPaths = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body && JSON.parse(init.body) });
    if (failPaths.some(p => u.pathname.endsWith(p))) {
      return Response.json({ error: { message: 'failed' } }, { status: 400 });
    }
    if (u.pathname.endsWith('/me')) return Response.json({ username: OWN_USERNAME });
    if (u.pathname === '/refresh_access_token') return Response.json({ access_token: 'refreshed-token', expires_in: 5184000 });
    return Response.json({ id: 'ok' });
  };
});

function kv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
  };
}

function commentPayload(value) {
  return {
    object: 'instagram',
    entry: [{
      id: ACCOUNT_ID,
      time: 1760000000,
      changes: [{
        field: 'comments',
        value: {
          id: 'c1',
          text: '링크 주세요',
          from: { id: '999', username: 'fan' },
          media: { id: 'm1', media_product_type: 'REELS' },
          ...value,
        },
      }],
    }],
  };
}

async function post(payload, env = baseEnv, secret = env.APP_SECRET) {
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const pending = [];
  const res = await worker.fetch(
    new Request('https://w.example/', { method: 'POST', body, headers: { 'x-hub-signature-256': signature } }),
    env,
    { waitUntil: p => pending.push(p) },
  );
  await Promise.all(pending);
  return res;
}

const graphCalls = () => calls.filter(c => c.method === 'POST');

test('웹후크 인증: verify token 이 맞으면 challenge 반환', async () => {
  const ok = await worker.fetch(
    new Request('https://w.example/?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345'), baseEnv, {},
  );
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');

  const bad = await worker.fetch(
    new Request('https://w.example/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345'), baseEnv, {},
  );
  assert.equal(bad.status, 403);
});

test('서명이 틀리면 401, 아무 요청도 보내지 않음', async () => {
  const res = await post(commentPayload(), baseEnv, 'other-secret');
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('APP_SECRET 에 여러 시크릿을 쉼표로 넣으면 그중 하나로 서명돼도 통과', async () => {
  const env = { ...baseEnv, APP_SECRET: 'meta-secret, ig-secret' };
  const res = await post(commentPayload(), env, 'ig-secret');
  assert.equal(res.status, 200);
  assert.equal(graphCalls().length, 1);
});

test('릴스 댓글이면 비공개 답장으로 DM 전송', async () => {
  const res = await post(commentPayload());
  assert.equal(res.status, 200);

  const [dm] = graphCalls();
  assert.equal(dm.url.href, `https://graph.instagram.com/v26.0/${ACCOUNT_ID}/messages`);
  assert.equal(dm.headers.Authorization, `Bearer ${baseEnv.IG_ACCESS_TOKEN}`);
  assert.deepEqual(dm.body, { recipient: { comment_id: 'c1' }, message: { text: '@fan님 링크 보내드려요' } });
  assert.equal(graphCalls().length, 1);
});

test('릴스가 아닌 게시물 댓글은 건너뜀 (ONLY_REELS=false 면 전송)', async () => {
  await post(commentPayload({ media: { id: 'm1', media_product_type: 'FEED' } }));
  assert.equal(graphCalls().length, 0);

  await post(commentPayload({ media: { id: 'm1', media_product_type: 'FEED' } }), { ...baseEnv, ONLY_REELS: 'false' });
  assert.equal(graphCalls().length, 1);
});

test('키워드가 설정되면 키워드가 들어간 댓글에만 전송', async () => {
  const env = { ...baseEnv, KEYWORDS: 'LINK, 링크' };
  await post(commentPayload({ text: '멋져요' }), env);
  assert.equal(graphCalls().length, 0);

  await post(commentPayload({ text: 'link please' }), env);
  assert.equal(graphCalls().length, 1);
});

test('내가 단 댓글에는 DM 을 보내지 않음', async () => {
  await post(commentPayload({ from: { id: ACCOUNT_ID, username: 'whoever' } }));
  await post(commentPayload({ from: { id: '12345', username: 'My_Account' } }));
  assert.equal(graphCalls().length, 0);
});

test('PUBLIC_REPLY_MESSAGE 가 있으면 DM 후 공개 답글, DM 실패 시 답글 안 함', async () => {
  const env = { ...baseEnv, PUBLIC_REPLY_MESSAGE: '@{username} DM 확인해주세요!' };
  await post(commentPayload(), env);
  const [dm, reply] = graphCalls();
  assert.ok(dm.url.pathname.endsWith('/messages'));
  assert.equal(reply.url.href, 'https://graph.instagram.com/v26.0/c1/replies');
  assert.deepEqual(reply.body, { message: '@fan DM 확인해주세요!' });

  calls = [];
  failPaths = ['/messages'];
  const res = await post(commentPayload(), env);
  assert.equal(res.status, 200);
  assert.equal(graphCalls().length, 1);
});

test('크론: 토큰을 갱신해 KV 에 저장하고 이후 요청에 사용', async () => {
  const env = { ...baseEnv, TOKENS: kv() };
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);

  const refresh = calls.find(c => c.url.pathname === '/refresh_access_token');
  assert.equal(refresh.url.searchParams.get('access_token'), baseEnv.IG_ACCESS_TOKEN);

  await post(commentPayload(), env);
  assert.equal(graphCalls()[0].headers.Authorization, 'Bearer refreshed-token');
});

test('IG_ACCESS_TOKEN 을 새로 넣으면 예전에 갱신해 둔 KV 토큰은 무시', async () => {
  const env = { ...baseEnv, TOKENS: kv() };
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  assert.ok(env.TOKENS.store.has('ig_access_token'));

  const updated = { ...env, IG_ACCESS_TOKEN: 'brand-new-token-BBBBBBBBBBBBBBBBBBBB' };
  await post(commentPayload(), updated);
  assert.equal(graphCalls()[0].headers.Authorization, `Bearer ${updated.IG_ACCESS_TOKEN}`);
});
