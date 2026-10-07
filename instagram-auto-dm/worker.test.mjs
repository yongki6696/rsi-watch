// 실행: node --test instagram-auto-dm/worker.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from './worker.js';

// 워커 로그가 node:test 출력과 섞이지 않게 숨김
for (const level of ['log', 'warn', 'error']) console[level] = () => {};

const ACCOUNT_ID = '17841400000000000';
const OWN_USERNAME = 'my_account';
const baseEnv = {
  APP_SECRET: 'app-secret',
  VERIFY_TOKEN: 'verify-me',
  IG_ACCESS_TOKEN: 'original-token-AAAAAAAAAAAAAAAAAAAA',
  DM_MESSAGE: '@{username}님 링크 보내드려요',
};

// 가짜 Graph API
let calls;
let failPaths;
let media;
let comments;
beforeEach(() => {
  calls = [];
  failPaths = [];
  media = [];
  comments = {};
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body && JSON.parse(init.body) });
    if (failPaths.some(p => u.pathname.endsWith(p))) {
      return Response.json({ error: { message: 'failed' } }, { status: 400 });
    }
    const path = u.pathname.replace(/^\/v[\d.]+/, '');
    const fields = u.searchParams.get('fields');
    if (path === '/refresh_access_token') return Response.json({ access_token: 'refreshed-token', expires_in: 5184000 });
    if (path === '/me' && fields === 'instagram_business_account') {
      return Response.json({ instagram_business_account: { id: ACCOUNT_ID } });
    }
    if (path === '/me' && fields === 'user_id') return Response.json({ user_id: ACCOUNT_ID });
    if (path === '/me' || path === `/${ACCOUNT_ID}`) return Response.json({ username: OWN_USERNAME });
    if (path === `/${ACCOUNT_ID}/media`) return Response.json({ data: media });
    const match = path.match(/^\/(\w+)\/comments$/);
    if (match) return Response.json({ data: comments[match[1]] ?? [] });
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

async function cron(env) {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
}

// 인스타그램 API 시간 형식 (2026-10-08T00:24:58+0000)
function igTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

function igComment(id, msFromNow, extra = {}) {
  return { id, text: '링크 주세요', timestamp: igTime(Date.now() + msFromNow), from: { id: `u-${id}`, username: `fan_${id}` }, ...extra };
}

const graphCalls = () => calls.filter(c => c.method === 'POST');
const dmTargets = () => graphCalls().filter(c => c.url.pathname.endsWith('/messages')).map(c => c.body.recipient.comment_id);

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

test('웹후크: 릴스 댓글이면 비공개 답장으로 DM 전송', async () => {
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

test('페이스북 페이지 토큰(EAA…)이면 graph.facebook.com 의 me/messages 로 전송', async () => {
  const env = { ...baseEnv, IG_ACCESS_TOKEN: 'EAAPageToken123' };
  await post(commentPayload(), env);
  const [dm] = graphCalls();
  assert.equal(dm.url.href, 'https://graph.facebook.com/v26.0/me/messages');
  assert.equal(dm.headers.Authorization, 'Bearer EAAPageToken123');
  assert.deepEqual(dm.body.recipient, { comment_id: 'c1' });
});

test('크론: STORE 가 없으면 아무것도 하지 않음', async () => {
  await cron(baseEnv);
  assert.equal(calls.length, 0);
});

test('크론: 인스타 토큰을 갱신해 저장하고 이후 요청에 사용, 일주일 안에는 다시 갱신하지 않음', async () => {
  const env = { ...baseEnv, STORE: kv() };
  await cron(env);
  const refresh = calls.filter(c => c.url.pathname === '/refresh_access_token');
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0].url.searchParams.get('access_token'), baseEnv.IG_ACCESS_TOKEN);

  await post(commentPayload(), env);
  assert.equal(graphCalls()[0].headers.Authorization, 'Bearer refreshed-token');

  calls = [];
  await cron(env);
  assert.equal(calls.filter(c => c.url.pathname === '/refresh_access_token').length, 0);
});

test('IG_ACCESS_TOKEN 을 새로 넣으면 예전에 갱신해 둔 토큰은 무시', async () => {
  const env = { ...baseEnv, STORE: kv() };
  await cron(env);
  assert.ok(env.STORE.store.has('ig_access_token'));

  const updated = { ...env, IG_ACCESS_TOKEN: 'brand-new-token-BBBBBBBBBBBBBBBBBBBB' };
  await post(commentPayload(), updated);
  assert.equal(graphCalls()[0].headers.Authorization, `Bearer ${updated.IG_ACCESS_TOKEN}`);
});

test('크론: 페이지 토큰은 갱신하지 않고, 페이지에 연결된 인스타 계정을 찾아 댓글 확인', async () => {
  const env = { ...baseEnv, IG_ACCESS_TOKEN: 'EAAPageToken123', STORE: kv() };
  await cron(env);
  assert.equal(calls.filter(c => c.url.pathname === '/refresh_access_token').length, 0);
  assert.ok(calls.some(c => c.url.href.startsWith(`https://graph.facebook.com/v26.0/${ACCOUNT_ID}/media`)));
  assert.equal(JSON.parse(env.STORE.store.get('poll_state')).accountId, ACCOUNT_ID);
});

test('크론: 처음 실행 때는 기준만 기록하고 예전 댓글에는 DM 을 보내지 않음', async () => {
  const env = { ...baseEnv, IG_ACCESS_TOKEN: 'EAAPageToken123', STORE: kv() };
  media = [{ id: 'r1', media_product_type: 'REELS', comments_count: 1 }];
  comments.r1 = [igComment('old', -60_000)];
  await cron(env);
  assert.equal(graphCalls().length, 0);
  assert.ok(!calls.some(c => c.url.pathname.endsWith('/comments')));
});

test('크론: 댓글 수가 바뀐 릴스의 새 댓글에만 DM, 같은 댓글은 다시 보내지 않음', async () => {
  const env = { ...baseEnv, IG_ACCESS_TOKEN: 'EAAPageToken123', STORE: kv() };
  media = [
    { id: 'r1', media_product_type: 'REELS', comments_count: 1 },
    { id: 'f1', media_product_type: 'FEED', comments_count: 0 },
  ];
  comments.r1 = [igComment('old', -60 * 60_000)];
  await cron(env);

  media = [
    { id: 'r1', media_product_type: 'REELS', comments_count: 2 },
    { id: 'f1', media_product_type: 'FEED', comments_count: 1 },
  ];
  comments.r1 = [igComment('old', -60 * 60_000), igComment('new1', 1000)];
  comments.f1 = [igComment('feed1', 1000)];
  calls = [];
  await cron(env);
  assert.deepEqual(dmTargets(), ['new1']);
  assert.equal(graphCalls()[0].url.href, 'https://graph.facebook.com/v26.0/me/messages');
  assert.deepEqual(graphCalls()[0].body.message, { text: '@fan_new1님 링크 보내드려요' });
  assert.ok(!calls.some(c => c.url.pathname.endsWith('/f1/comments')));

  // 댓글 수가 그대로면 댓글을 다시 읽지 않음
  calls = [];
  await cron(env);
  assert.ok(!calls.some(c => c.url.pathname.endsWith('/comments')));

  // 새 댓글이 또 달리면 그 댓글에만 DM
  media[0].comments_count = 3;
  comments.r1.push(igComment('new2', 2000));
  calls = [];
  await cron(env);
  assert.deepEqual(dmTargets(), ['new2']);
});

test('크론: 한 번에 너무 많으면 나머지는 다음 실행 때 처리', async () => {
  const env = { ...baseEnv, IG_ACCESS_TOKEN: 'EAAPageToken123', STORE: kv() };
  media = [{ id: 'r1', media_product_type: 'REELS', comments_count: 0 }];
  await cron(env);

  comments.r1 = Array.from({ length: 20 }, (_, i) => igComment(`n${i}`, 1000 + i));
  media[0].comments_count = 20;
  calls = [];
  await cron(env);
  assert.equal(dmTargets().length, 15);

  calls = [];
  await cron(env);
  assert.deepEqual(dmTargets(), ['n15', 'n16', 'n17', 'n18', 'n19']);
});
