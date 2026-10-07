// 인스타그램 릴스 댓글 → 자동 DM (Cloudflare Worker)
// 댓글 웹후크를 받으면 공식 "비공개 답장(Private Reply)" API로 댓글 작성자에게 DM을 보낸다.
// IG_ACCESS_TOKEN 이 페이스북 페이지 토큰(EAA…)이면 "Facebook 로그인" 방식(graph.facebook.com),
// 인스타그램 토큰(IG…)이면 "Instagram 로그인" 방식(graph.instagram.com)으로 동작한다.
// 설정 방법은 README.md 참고

const DEFAULT_API_VERSION = 'v26.0';
const DEFAULT_DM_MESSAGE = '댓글 남겨주셔서 감사합니다! 🙌';
const TOKEN_KV_KEY = 'ig_access_token';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (url.searchParams.has('hub.mode')) return verifySubscription(url, env);
      return new Response('instagram-auto-dm 동작 중');
    }
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const raw = await request.arrayBuffer();
    if (!(await isValidSignature(raw, request.headers.get('x-hub-signature-256'), env.APP_SECRET))) {
      console.warn('서명 검증 실패 — APP_SECRET 값을 확인하세요');
      return new Response('Invalid signature', { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // 메타는 빠른 200 응답을 기대하므로 DM 전송은 응답 후 백그라운드에서 처리
    ctx.waitUntil(handlePayload(payload, env));
    return new Response('EVENT_RECEIVED');
  },

  // 크론 트리거: 60일짜리 액세스 토큰을 만료 전에 갱신
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAccessToken(env));
  },
};

// 메타 대시보드에서 콜백 URL을 등록할 때 호출되는 인증 요청
function verifySubscription(url, env) {
  const p = url.searchParams;
  if (p.get('hub.mode') === 'subscribe' && env.VERIFY_TOKEN && p.get('hub.verify_token') === env.VERIFY_TOKEN) {
    return new Response(p.get('hub.challenge') ?? '');
  }
  return new Response('Forbidden', { status: 403 });
}

// X-Hub-Signature-256 검증. 인스타그램 앱 시크릿/메타 앱 시크릿 중 어느 쪽이든 쓸 수 있게 쉼표로 여러 개 허용
async function isValidSignature(raw, header, appSecrets) {
  if (!appSecrets || !header?.startsWith('sha256=')) return false;
  const signature = hexToBytes(header.slice('sha256='.length));
  if (!signature) return false;

  for (const secret of appSecrets.split(',').map(s => s.trim()).filter(Boolean)) {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    if (await crypto.subtle.verify('HMAC', key, signature, raw)) return true;
  }
  return false;
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return new Uint8Array(hex.match(/../g).map(b => parseInt(b, 16)));
}

async function handlePayload(payload, env) {
  if (payload?.object !== 'instagram') return;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments') continue;
      try {
        await handleComment(entry.id, change.value ?? {}, env);
      } catch (err) {
        console.error(`댓글 ${change.value?.id} 처리 실패: ${err.message}`);
      }
    }
  }
}

async function handleComment(accountId, comment, env) {
  const commentId = comment.id;
  const from = comment.from ?? {};
  if (!commentId) return;

  if (env.ONLY_REELS !== 'false' && comment.media?.media_product_type !== 'REELS') {
    console.log(`건너뜀 (릴스 아님: ${comment.media?.media_product_type}) 댓글 ${commentId}`);
    return;
  }
  if (!matchesKeyword(comment.text, env.KEYWORDS)) {
    console.log(`건너뜀 (키워드 없음) 댓글 ${commentId}`);
    return;
  }

  const token = await getAccessToken(env);
  if (from.id === accountId || (await isOwnUsername(from.username, accountId, token, env))) {
    console.log(`건너뜀 (내 댓글) 댓글 ${commentId}`);
    return;
  }

  const vars = { username: from.username ?? '' };
  await graphPost(env, token, isPageToken(token) ? 'me/messages' : `${accountId}/messages`, {
    recipient: { comment_id: commentId },
    message: { text: fillTemplate(env.DM_MESSAGE || DEFAULT_DM_MESSAGE, vars) },
  });
  console.log(`DM 전송 완료: @${from.username} (댓글 ${commentId})`);

  // DM이 성공했을 때만 공개 답글을 단다. 댓글당 DM은 1번만 허용되므로 웹후크가 중복으로 와도 답글은 한 번만 달린다.
  if (env.PUBLIC_REPLY_MESSAGE) {
    await graphPost(env, token, `${commentId}/replies`, { message: fillTemplate(env.PUBLIC_REPLY_MESSAGE, vars) });
    console.log(`공개 답글 완료 (댓글 ${commentId})`);
  }
}

// KEYWORDS가 비어 있으면 모든 댓글에 반응
function matchesKeyword(text, keywords) {
  const list = (keywords ?? '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;
  const lower = (text ?? '').toLowerCase();
  return list.some(k => lower.includes(k));
}

function fillTemplate(template, vars) {
  return template.replace(/\{username\}/g, vars.username);
}

// 워커 인스턴스마다 한 번만 조회
let ownUsername;
async function isOwnUsername(username, accountId, token, env) {
  if (!username) return false;
  if (ownUsername === undefined) {
    try {
      // 페이지 토큰의 me 는 페이스북 페이지라서 인스타 계정 ID로 조회
      const path = isPageToken(token) ? accountId : 'me';
      ownUsername = (await graphGet(env, token, path, { fields: 'username' })).username ?? null;
    } catch (err) {
      console.warn(`내 계정 username 조회 실패: ${err.message}`);
      return false;
    }
  }
  return ownUsername !== null && ownUsername.toLowerCase() === username.toLowerCase();
}

async function getAccessToken(env) {
  const stored = env.TOKENS ? await env.TOKENS.get(TOKEN_KV_KEY, 'json') : null;
  // IG_ACCESS_TOKEN을 새로 넣었다면 예전 토큰에서 갱신해 둔 값은 무시
  if (stored?.base === tokenFingerprint(env.IG_ACCESS_TOKEN)) return stored.token;
  return env.IG_ACCESS_TOKEN;
}

async function refreshAccessToken(env) {
  const token = await getAccessToken(env);
  if (isPageToken(token)) {
    console.log('페이스북 페이지 토큰은 만료되지 않아 갱신하지 않습니다');
    return;
  }
  if (!env.TOKENS) {
    console.warn('TOKENS KV가 연결되지 않아 토큰 자동 갱신을 건너뜁니다 (토큰은 발급 60일 후 만료)');
    return;
  }
  const res = await fetch(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
  );
  const data = await readGraphResponse(res, 'refresh_access_token');
  await env.TOKENS.put(
    TOKEN_KV_KEY,
    JSON.stringify({ base: tokenFingerprint(env.IG_ACCESS_TOKEN), token: data.access_token }),
  );
  console.log(`액세스 토큰 갱신 완료 (만료까지 약 ${Math.round(data.expires_in / 86400)}일)`);
}

function tokenFingerprint(token) {
  return (token ?? '').slice(-16);
}

function isPageToken(token) {
  return (token ?? '').startsWith('EAA');
}

function apiBase(env, token) {
  const host = isPageToken(token) ? 'graph.facebook.com' : 'graph.instagram.com';
  return `https://${host}/${env.GRAPH_API_VERSION || DEFAULT_API_VERSION}`;
}

async function graphGet(env, token, path, params) {
  const res = await fetch(`${apiBase(env, token)}/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return readGraphResponse(res, path);
}

async function graphPost(env, token, path, body) {
  const res = await fetch(`${apiBase(env, token)}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readGraphResponse(res, path);
}

async function readGraphResponse(res, path) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`${path} 요청 실패 (${res.status}): ${data.error?.message ?? JSON.stringify(data)}`);
  }
  return data;
}
