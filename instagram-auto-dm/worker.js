// 인스타그램 릴스 댓글 → 자동 DM (Cloudflare Worker)
// 새 댓글을 찾으면 공식 "비공개 답장(Private Reply)" API로 댓글 작성자에게 DM을 보낸다.
// 새 댓글은 두 가지 경로로 찾는다.
//   1) 크론 트리거(2분마다)로 내 릴스 댓글을 직접 확인 — STORE KV 필요, 웹후크 설정 불필요
//   2) 메타 웹후크(comments)가 보내 주는 알림 — 웹후크 연결이 끝난 경우
// IG_ACCESS_TOKEN 이 페이스북 페이지 토큰(EAA…)이면 "Facebook 로그인" 방식(graph.facebook.com),
// 인스타그램 토큰(IG…)이면 "Instagram 로그인" 방식(graph.instagram.com)으로 동작한다.
// 설정 방법은 README.md 참고

const DEFAULT_API_VERSION = 'v26.0';
const DEFAULT_DM_MESSAGE = '댓글 남겨주셔서 감사합니다! 🙌';
const TOKEN_KEY = 'ig_access_token';
const POLL_KEY = 'poll_state';
const MEDIA_LIMIT = 25; // 최근 게시물 몇 개의 댓글을 확인할지
const COMMENT_PAGES = 4; // 게시물당 댓글 몇 페이지(50개씩)까지 읽을지
const COMMENTS_PER_RUN = 15; // 한 번 실행에 처리할 최대 댓글 수 (워커 요청 수 제한 대비)
const POLL_WINDOW_MS = 30 * 60 * 1000; // 이보다 오래된 댓글은 새 댓글로 보지 않음
const SEEN_TTL_MS = 2 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

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

  // 크론 트리거: 새 댓글 확인 + (Instagram 로그인 방식이면) 60일짜리 토큰을 일주일마다 갱신
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};

async function runScheduled(env) {
  if (!env.STORE) {
    console.warn('STORE KV가 연결되지 않아 댓글 확인을 건너뜁니다 — README 3단계 참고');
    return;
  }
  try {
    await refreshAccessToken(env);
  } catch (err) {
    console.error(`토큰 갱신 실패: ${err.message}`);
  }
  try {
    await pollComments(env);
  } catch (err) {
    console.error(`댓글 확인 실패: ${err.message}`);
  }
}

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

// 댓글 수가 바뀐 릴스만 댓글을 읽어서, 아직 처리하지 않은 최근 댓글에 DM을 보낸다
async function pollComments(env) {
  const token = await getAccessToken(env);
  const state = (await env.STORE.get(POLL_KEY, 'json')) ?? {};
  const now = Date.now();
  let changed = false;

  if (!state.accountId) {
    state.accountId = await findAccountId(env, token);
    changed = true;
  }
  // 처음 실행할 때는 기준 시각만 기록 — 예전 댓글에 DM이 한꺼번에 가지 않도록
  const firstRun = !state.since;
  if (firstRun) {
    state.since = now;
    changed = true;
    console.log(`첫 확인: 인스타 계정 ${state.accountId} — 지금부터 달리는 새 댓글에 DM을 보냅니다`);
  }
  state.counts ??= {};
  state.seen ??= {};

  const { data: media = [] } = await graphGet(env, token, `${state.accountId}/media`, {
    fields: 'id,media_product_type,comments_count',
    limit: MEDIA_LIMIT,
  });
  const cutoff = Math.max(state.since, now - POLL_WINDOW_MS);
  let budget = COMMENTS_PER_RUN;
  let reels = 0;
  let found = 0;

  for (const m of media) {
    if (env.ONLY_REELS !== 'false' && m.media_product_type !== 'REELS') continue;
    reels++;
    if (state.counts[m.id] === m.comments_count) continue;
    state.counts[m.id] = m.comments_count;
    changed = true;
    if (firstRun) continue;

    for (const c of await fetchComments(env, token, m.id)) {
      const ts = parseTime(c.timestamp);
      if (!(ts >= cutoff) || state.seen[c.id]) continue;
      // 이번에 다 못 하면 댓글 수를 지워서 다음 실행 때 이 릴스를 다시 읽게 한다
      if (budget-- <= 0) {
        delete state.counts[m.id];
        break;
      }
      state.seen[c.id] = ts;
      found++;
      try {
        await handleComment(state.accountId, {
          id: c.id,
          text: c.text,
          from: c.from ?? { username: c.username },
          media: { id: m.id, media_product_type: m.media_product_type },
        }, env);
      } catch (err) {
        console.error(`댓글 ${c.id} 처리 실패: ${err.message}`);
      }
    }
  }

  for (const [id, ts] of Object.entries(state.seen)) {
    if (ts < now - SEEN_TTL_MS) {
      delete state.seen[id];
      changed = true;
    }
  }
  const current = new Set(media.map(m => m.id));
  for (const id of Object.keys(state.counts)) {
    if (!current.has(id)) {
      delete state.counts[id];
      changed = true;
    }
  }
  if (changed) await env.STORE.put(POLL_KEY, JSON.stringify(state));
  console.log(`댓글 확인 완료: 릴스 ${reels}개, 새 댓글 ${found}개`);
}

async function findAccountId(env, token) {
  if (isPageToken(token)) {
    const page = await graphGet(env, token, 'me', { fields: 'instagram_business_account' });
    if (!page.instagram_business_account?.id) throw new Error('페이스북 페이지에 연결된 인스타그램 계정이 없습니다');
    return page.instagram_business_account.id;
  }
  return (await graphGet(env, token, 'me', { fields: 'user_id' })).user_id;
}

async function fetchComments(env, token, mediaId) {
  const comments = [];
  let url = `${apiBase(env, token)}/${mediaId}/comments?${new URLSearchParams({
    fields: 'id,text,timestamp,username,from',
    limit: 50,
  })}`;
  for (let page = 0; url && page < COMMENT_PAGES; page++) {
    const data = await graphFetch(url, token, `${mediaId}/comments`);
    comments.push(...(data.data ?? []));
    url = data.paging?.next;
  }
  return comments;
}

// 인스타그램 시간 형식(2026-10-08T00:24:58+0000)을 밀리초로
function parseTime(timestamp) {
  return Date.parse(String(timestamp).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
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

  // DM이 성공했을 때만 공개 답글을 단다. 댓글당 DM은 1번만 허용되므로 같은 댓글이 두 번 처리돼도 답글은 한 번만 달린다.
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

// IG_ACCESS_TOKEN을 새로 넣었다면 예전 토큰에서 갱신해 둔 값은 무시
async function readStoredToken(env) {
  const stored = env.STORE ? await env.STORE.get(TOKEN_KEY, 'json') : null;
  return stored?.base === tokenFingerprint(env.IG_ACCESS_TOKEN) ? stored : null;
}

async function getAccessToken(env) {
  return (await readStoredToken(env))?.token ?? env.IG_ACCESS_TOKEN;
}

// 페이스북 페이지 토큰은 만료되지 않으므로 Instagram 로그인 토큰만 갱신
async function refreshAccessToken(env) {
  const stored = await readStoredToken(env);
  const token = stored?.token ?? env.IG_ACCESS_TOKEN;
  if (isPageToken(token) || Date.now() - stored?.refreshedAt < REFRESH_INTERVAL_MS) return;

  const res = await fetch(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
  );
  const data = await readGraphResponse(res, 'refresh_access_token');
  await env.STORE.put(TOKEN_KEY, JSON.stringify({
    base: tokenFingerprint(env.IG_ACCESS_TOKEN),
    token: data.access_token,
    refreshedAt: Date.now(),
  }));
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
  return graphFetch(`${apiBase(env, token)}/${path}?${new URLSearchParams(params)}`, token, path);
}

async function graphFetch(url, token, label) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return readGraphResponse(res, label);
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
