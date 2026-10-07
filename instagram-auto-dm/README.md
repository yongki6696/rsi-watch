# 인스타그램 릴스 댓글 → 자동 DM

내 릴스에 댓글이 달리면 댓글 작성자에게 자동으로 DM을 보내는 작은 서버입니다.
("댓글에 '링크' 남기면 DM으로 보내드려요" 같은 용도)

- 인스타그램 **공식 API**의 **비공개 답장(Private Reply)** 기능을 씁니다.
  매크로·비공식 툴과 달리 계정 정지 위험이 없습니다.
- [Cloudflare Workers](https://workers.cloudflare.com) 무료 플랜에서 돌아갑니다. 서버 관리 필요 없음.
- 기존 RSIngTime 사이트(GitHub Pages)와는 별개로 동작합니다. 이 폴더만 Cloudflare에 올리면 됩니다.

```
팔로워가 릴스에 댓글 ──▶ 인스타그램 웹후크 ──▶ Cloudflare Worker(worker.js) ──▶ 비공개 답장 API ──▶ 댓글 작성자 DM함
```

## 먼저 알아둘 제한

| 항목 | 내용 |
|---|---|
| 계정 | 인스타그램 **프로페셔널 계정**(비즈니스 또는 크리에이터)이어야 함 |
| 횟수 | 댓글 1개당 DM **1번**만 보낼 수 있음 (인스타그램 정책) |
| 기한 | 댓글이 달린 지 **7일 이내**에만 보낼 수 있음 |
| 대상 | 메타 앱이 **개발 모드**일 때는 앱에 역할(테스터 등)이 있는 계정의 댓글에만 동작. **모든 사람의 댓글**에 동작하려면 메타 **앱 검수(고급 액세스)** 후 라이브 모드로 바꿔야 함 → [6단계](#6-모든-사람의-댓글에-동작하게-하기-앱-검수) |
| 내 댓글 | 내 계정이 단 댓글(답글 포함)에는 보내지 않음 |

## 설정값

| 이름 | 종류 | 설명 |
|---|---|---|
| `IG_ACCESS_TOKEN` | 비밀 | 2단계에서 발급한 토큰. 페이스북 페이지 토큰(`EAA…`)이면 Facebook 로그인 방식, `IG…` 로 시작하면 Instagram 로그인 방식으로 자동 동작 |
| `APP_SECRET` | 비밀 | 앱 시크릿 (2단계). 웹후크 서명 검증용 |
| `VERIFY_TOKEN` | 비밀 | 아무 문자열이나 직접 정함 (예: `my-reels-dm-1234`). 4단계에서 같은 값 입력 |
| `DM_MESSAGE` | 텍스트 | 보낼 DM 내용. `{username}` 은 댓글 작성자 아이디로 바뀜 |
| `KEYWORDS` | 텍스트 | 쉼표로 구분한 키워드 (예: `링크,link,정보`). 하나라도 포함된 댓글에만 DM. 비우면 모든 댓글 |
| `ONLY_REELS` | 텍스트 | 기본 `true`(릴스만). `false` 면 일반 게시물 댓글에도 DM |
| `PUBLIC_REPLY_MESSAGE` | 텍스트 | (선택) DM을 보낸 뒤 댓글에 공개 답글도 달기. 예: `@{username} DM 확인해주세요! 📩` |
| `TOKENS` | KV 바인딩 | Instagram 로그인 방식일 때만 필요. 토큰 자동 갱신용 저장소 (3단계). 없으면 토큰이 60일 뒤 만료됨 |
| `GRAPH_API_VERSION` | 텍스트 | (선택) 기본 `v26.0` |

---

## 1. 인스타그램 계정 준비

1. 프로페셔널 계정이 아니라면: 인스타그램 앱 → 설정 → **계정 유형 및 도구** → 프로페셔널 계정으로 전환
2. DM API 허용: 인스타그램 앱 → 설정 → **메시지 및 스토리 답장** → **메시지 제어** → 연결된 도구 → **메시지 접근 허용** 켜기
   (이걸 안 켜면 DM 전송이 실패합니다)

## 2. 메타 앱 만들기 + 토큰 발급

<https://developers.facebook.com/apps> 에서 **앱 만들기** → 이용 사례 **Instagram API** (Instagram에서 메시지 및 콘텐츠 관리) 선택.
앱 대시보드 → 이용 사례 → 맞춤 설정 왼쪽 메뉴에 무엇이 보이는지에 따라 아래 둘 중 하나로 진행합니다.

### 2-A. "Facebook 로그인이 포함된 API" 만 있을 때 (페이스북 페이지 필요)

1. **페이스북 페이지를 인스타 계정에 연결**: 인스타그램 앱 → 프로필 편집 → **페이지** → 기존 페이지 연결 또는 새로 만들기
2. **권한 추가**: 이용 사례 → 맞춤 설정 → **권한 및 기능** 에서 아래 권한 옆 **추가** 클릭
   - `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`,
     `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `business_management`
3. **앱 시크릿**: 왼쪽 톱니바퀴(앱 설정) → **기본 설정** → **앱 시크릿 코드** → 표시 → 복사 → `APP_SECRET`
4. **만료 없는 페이지 토큰 만들기** — [Graph API 탐색기](https://developers.facebook.com/tools/explorer)에서
   1. 오른쪽 **Meta 앱** 에서 내 앱 선택 → **권한** 에 2번의 권한 7개 추가 → **Generate Access Token** → 로그인 창에서 내 페이지와 인스타 계정을 선택하고 허용
   2. 토큰 칸 왼쪽 **ⓘ** → **액세스 토큰 도구에서 열기** → 맨 아래 **액세스 토큰 연장** → 새로 나온 긴 토큰 복사
   3. 탐색기로 돌아와 토큰 칸에 2.에서 복사한 토큰을 붙여넣고, 주소 칸에 `me/accounts` 입력 → **제출**
   4. 결과에서 내 페이지의 `access_token`(`EAA…`) 복사 → `IG_ACCESS_TOKEN`, 같은 묶음의 `id` 는 **페이지 ID** 로 메모 (4단계에서 사용)

   이렇게 만든 페이지 토큰은 만료되지 않아 KV·크론 설정(3단계 4번)이 필요 없습니다.

### 2-B. "Instagram 로그인이 포함된 API" 가 있을 때 (페이지 불필요)

1. **Instagram 로그인이 포함된 API 설정** 화면 상단의 **Instagram 앱 시크릿** 복사 → `APP_SECRET`
2. **1. 액세스 토큰 생성** → 계정 추가 → 내 인스타 계정으로 로그인 → **토큰 생성** → 복사 → `IG_ACCESS_TOKEN`
3. 권한 목록에 `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages` 가 있는지 확인

> 메타 앱에는 "메타 앱 시크릿"과 "Instagram 앱 시크릿"이 따로 있어 헷갈리기 쉽습니다. 2-A는 메타 앱 시크릿, 2-B는 Instagram 앱 시크릿을 씁니다.

## 3. Cloudflare Worker 배포

### 방법 A — 웹 대시보드 (코딩 도구 없이)

1. <https://dash.cloudflare.com> 가입/로그인 → **Workers & Pages** → **만들기(Create)** → Worker → 이름 `instagram-auto-dm` → **배포**
2. **코드 편집(Edit code)** → 기존 코드를 모두 지우고 이 폴더의 `worker.js` 내용을 붙여넣기 → **배포(Deploy)**
3. Worker **설정(Settings)** → **변수 및 비밀(Variables and Secrets)**
   - **비밀(Secret)** 으로 추가: `IG_ACCESS_TOKEN`, `APP_SECRET`, `VERIFY_TOKEN`
   - **텍스트(Text)** 로 추가: `DM_MESSAGE`, 필요하면 `KEYWORDS`, `ONLY_REELS`, `PUBLIC_REPLY_MESSAGE`
4. 토큰 자동 갱신 설정 (2-B 방식일 때만. 2-A 페이지 토큰은 건너뛰기)
   - **Storage & Databases → KV** → 네임스페이스 만들기 (이름 아무거나, 예: `instagram-auto-dm-tokens`)
   - Worker 설정 → **바인딩(Bindings)** → 추가 → KV 네임스페이스 → 변수 이름 **`TOKENS`** → 방금 만든 네임스페이스 선택
   - Worker 설정 → **트리거 이벤트(Trigger Events)** → 크론 트리거 추가 → `0 3 * * 1` (매주 월요일)
5. Worker 주소 확인: `https://instagram-auto-dm.<내-서브도메인>.workers.dev`
   브라우저로 열었을 때 `instagram-auto-dm 동작 중` 이 보이면 성공

### 방법 B — wrangler CLI

```bash
cd instagram-auto-dm
npx wrangler login
npx wrangler kv namespace create TOKENS   # 나온 id를 wrangler.toml 의 [[kv_namespaces]] 에 넣고 주석 해제
npx wrangler secret put IG_ACCESS_TOKEN
npx wrangler secret put APP_SECRET
npx wrangler secret put VERIFY_TOKEN
# wrangler.toml 의 [vars] 에서 DM_MESSAGE, KEYWORDS 등 수정
npx wrangler deploy
```

## 4. 웹후크 연결

### 2-A 방식 (Facebook 로그인)

1. 이용 사례 → 맞춤 설정 → **이 이용 사례에 더 추가** → **Webhooks로 실시간 알림 받기** → 추가
2. 웹후크 화면에서 개체를 **Instagram** 으로 선택 → **콜백 URL**: 3단계의 Worker 주소, **확인 토큰**: `VERIFY_TOKEN` 값 → **확인 및 저장**
3. 필드 목록에서 **`comments`** 구독
4. 페이지를 앱에 연결: [Graph API 탐색기](https://developers.facebook.com/tools/explorer) 토큰 칸에 페이지 토큰(`IG_ACCESS_TOKEN` 값)을 넣고,
   왼쪽 **GET** 을 **POST** 로 바꾼 뒤 주소 칸에 `페이지ID/subscribed_apps?subscribed_fields=feed` 입력 → **제출** → `"success": true` 가 나오면 완료

### 2-B 방식 (Instagram 로그인)

1. **Instagram 로그인이 포함된 API 설정** → **2. 웹후크 구성**
   - 콜백 URL: 3단계의 Worker 주소 / 인증 토큰: `VERIFY_TOKEN` 값 → **확인 및 저장** → **`comments` 구독**
2. **1. 액세스 토큰 생성** 화면의 내 계정 옆 **웹후크 구독** 스위치 켜기

## 5. 테스트

1. **연결 확인**: 메타 웹후크 화면의 `comments` 옆 **테스트** 버튼 → Cloudflare Worker **로그(Logs)** 탭에 기록이 찍히면 연결 성공
   (테스트 데이터는 가짜라서 `건너뜀` 이나 `요청 실패` 가 찍히는 게 정상)
2. **실제 댓글**: 개발 모드에서는 앱에 역할(관리자·개발자·테스터)이 있는 사람의 댓글만 전달됩니다. 내 계정 댓글은 무시하므로
   **앱 역할 → 역할** 에 테스트용 계정을 추가하고, 그 계정으로 내 릴스에 댓글을 달아 DM이 오는지 확인합니다.
   개발 모드에서 실제 댓글 알림이 아예 오지 않으면 6단계 앱 검수 후에 확인할 수 있습니다.
3. 로그 읽는 법 (Cloudflare Worker → **로그(Logs)** 탭, 또는 `npx wrangler tail`)
   - `DM 전송 완료: @아이디` → 성공
   - `건너뜀 (...)` → 릴스가 아니거나 키워드가 없거나 내 댓글이라 건너뜀
   - `... 요청 실패` → 아래 [문제 해결](#문제-해결) 참고

## 6. 모든 사람의 댓글에 동작하게 하기 (앱 검수)

팔로워 누구의 댓글에나 동작하려면 메타의 앱 검수를 받아 **고급 액세스**를 얻어야 합니다.

1. 앱 대시보드 → **앱 검수 → 권한 및 기능** → 아래 권한 **고급 액세스 요청**
   - 2-A 방식: 2-A의 2번에서 추가한 권한들
   - 2-B 방식: `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`
2. 제출할 때 필요한 것
   - **개인정보처리방침 URL** (기존 `privacy.html` 을 쓰려면 인스타그램 댓글/아이디를 DM 발송에만 쓴다는 내용을 추가해야 함)
   - 앱 아이콘, 각 권한을 어디에 쓰는지 설명 + 동작 화면 녹화 영상 (5단계 테스트 화면을 녹화하면 됨)
   - 경우에 따라 비즈니스 인증을 요구받을 수 있음
3. 승인되면 앱 대시보드 상단에서 앱 모드를 **라이브(Live)** 로 전환

검수는 보통 며칠 걸리고 반려되면 보완해서 다시 제출할 수 있습니다.

## 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| 웹후크 "확인 및 저장" 실패 | 콜백 URL 오타, 또는 `VERIFY_TOKEN` 값 불일치. Worker 주소를 브라우저로 열어 `동작 중` 이 뜨는지 확인 |
| 로그에 `서명 검증 실패` | `APP_SECRET` 이 다름. 메타 앱 시크릿과 Instagram 앱 시크릿이 헷갈리면 `시크릿1,시크릿2` 처럼 쉼표로 둘 다 넣어도 됨 |
| 댓글을 달아도 로그가 전혀 없음 | `comments` 필드 구독, 4단계 마지막 연결(2-A: `subscribed_apps` / 2-B: 웹후크 구독 스위치) 확인. 개발 모드라면 댓글 단 계정에 앱 역할이 있는지 확인 |
| `messages 요청 실패` | 1단계의 **메시지 접근 허용** 확인. 같은 댓글에 이미 DM을 보냈거나 7일이 지난 경우에도 실패함 |
| 갑자기 안 됨 (`Session has expired` 등) | 토큰 만료. 2-B 방식이면 3단계 KV(`TOKENS`)·크론 설정 확인. 페이스북 비밀번호를 바꾸면 2-A 페이지 토큰도 무효가 되니 2단계에서 다시 발급해 `IG_ACCESS_TOKEN` 교체 |

## 개발

```bash
node --test instagram-auto-dm/worker.test.mjs
```
