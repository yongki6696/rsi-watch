# 인스타그램 릴스 댓글 → 자동 DM

내 릴스에 댓글이 달리면 댓글 작성자에게 자동으로 DM을 보내는 작은 서버입니다.
("댓글에 '링크' 남기면 DM으로 보내드려요" 같은 용도)

- 인스타그램 **공식 API**(Instagram API with Instagram Login)의 **비공개 답장(Private Reply)** 기능을 씁니다.
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
| `IG_ACCESS_TOKEN` | 비밀 | 인스타그램 액세스 토큰 (2단계에서 발급) |
| `APP_SECRET` | 비밀 | 인스타그램 앱 시크릿 (2단계). 웹후크 서명 검증용 |
| `VERIFY_TOKEN` | 비밀 | 아무 문자열이나 직접 정함 (예: `my-reels-dm-1234`). 4단계에서 같은 값 입력 |
| `DM_MESSAGE` | 텍스트 | 보낼 DM 내용. `{username}` 은 댓글 작성자 아이디로 바뀜 |
| `KEYWORDS` | 텍스트 | 쉼표로 구분한 키워드 (예: `링크,link,정보`). 하나라도 포함된 댓글에만 DM. 비우면 모든 댓글 |
| `ONLY_REELS` | 텍스트 | 기본 `true`(릴스만). `false` 면 일반 게시물 댓글에도 DM |
| `PUBLIC_REPLY_MESSAGE` | 텍스트 | (선택) DM을 보낸 뒤 댓글에 공개 답글도 달기. 예: `@{username} DM 확인해주세요! 📩` |
| `TOKENS` | KV 바인딩 | 토큰 자동 갱신용 저장소 (3단계). 없으면 토큰이 60일 뒤 만료됨 |
| `GRAPH_API_VERSION` | 텍스트 | (선택) 기본 `v26.0` |

---

## 1. 인스타그램 계정 준비

1. 프로페셔널 계정이 아니라면: 인스타그램 앱 → 설정 → **계정 유형 및 도구** → 프로페셔널 계정으로 전환
2. DM API 허용: 인스타그램 앱 → 설정 → **메시지 및 스토리 답장** → **메시지 제어** → 연결된 도구 → **메시지 접근 허용** 켜기
   (이걸 안 켜면 DM 전송이 실패합니다)

## 2. 메타 앱 만들기 + 토큰 발급

1. <https://developers.facebook.com/apps> 에서 **앱 만들기**
   - 사용 사례: **Instagram에서 메시지 및 콘텐츠 관리** (Manage messaging & content on Instagram)
2. 앱 대시보드 → 사용 사례 → 맞춤 설정 → **Instagram 비즈니스 로그인을 통한 API 설정** (API setup with Instagram business login)
   - 권한 목록에 `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages` 가 있는지 확인 (없으면 추가)
3. 같은 화면 상단의 **Instagram 앱 시크릿** 복사 → `APP_SECRET`
4. **1. 액세스 토큰 생성** → 계정 추가 → 내 인스타 계정으로 로그인 → **토큰 생성** → 복사 → `IG_ACCESS_TOKEN`

> 메타 앱에는 "메타 앱 ID/시크릿"과 "Instagram 앱 ID/시크릿"이 따로 있어 헷갈리기 쉽습니다. 여기서는 **Instagram** 쪽 값을 씁니다.

## 3. Cloudflare Worker 배포

### 방법 A — 웹 대시보드 (코딩 도구 없이)

1. <https://dash.cloudflare.com> 가입/로그인 → **Workers & Pages** → **만들기(Create)** → Worker → 이름 `instagram-auto-dm` → **배포**
2. **코드 편집(Edit code)** → 기존 코드를 모두 지우고 이 폴더의 `worker.js` 내용을 붙여넣기 → **배포(Deploy)**
3. Worker **설정(Settings)** → **변수 및 비밀(Variables and Secrets)**
   - **비밀(Secret)** 으로 추가: `IG_ACCESS_TOKEN`, `APP_SECRET`, `VERIFY_TOKEN`
   - **텍스트(Text)** 로 추가: `DM_MESSAGE`, 필요하면 `KEYWORDS`, `ONLY_REELS`, `PUBLIC_REPLY_MESSAGE`
4. 토큰 자동 갱신 설정 (권장)
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

1. 메타 앱 대시보드 → **Instagram 비즈니스 로그인을 통한 API 설정** → **2. 웹후크 구성**
   - 콜백 URL: 3단계의 Worker 주소
   - 인증 토큰(Verify token): `VERIFY_TOKEN` 에 넣은 값
   - **확인 및 저장** → 웹후크 필드 목록에서 **`comments` 구독**
2. **1. 액세스 토큰 생성** 화면으로 돌아가 내 계정 옆의 **웹후크 구독** 스위치 켜기

   스위치가 안 보이면 터미널에서 직접 구독해도 됩니다:
   ```bash
   curl -X POST "https://graph.instagram.com/v26.0/me/subscribed_apps?subscribed_fields=comments&access_token=여기에_IG_ACCESS_TOKEN"
   ```

## 5. 테스트

개발 모드에서는 **앱에 역할이 있는 계정**의 댓글에만 웹후크가 옵니다. 내 계정 댓글은 무시하므로 테스트용 **다른 인스타 계정**이 필요합니다.

1. 메타 앱 대시보드 → **앱 역할 → 역할** → **Instagram 테스터 추가** → 테스트용 계정 아이디 입력
2. 테스트 계정으로 instagram.com 로그인 → 설정 → **앱 및 웹사이트** → **테스터 초대** 수락
3. 테스트 계정으로 내 릴스에 댓글 (키워드를 정했다면 키워드 포함) → 테스트 계정 DM함 확인
4. 로그 확인: Cloudflare Worker → **로그(Logs)** 탭 (또는 `npx wrangler tail`)
   - `DM 전송 완료: @아이디` → 성공
   - `건너뜀 (...)` → 릴스가 아니거나 키워드가 없거나 내 댓글이라 건너뜀
   - `... 요청 실패` → 아래 [문제 해결](#문제-해결) 참고

## 6. 모든 사람의 댓글에 동작하게 하기 (앱 검수)

팔로워 누구의 댓글에나 동작하려면 메타의 앱 검수를 받아 **고급 액세스**를 얻어야 합니다.

1. 앱 대시보드 → **앱 검수 → 권한 및 기능** → 아래 3개 **고급 액세스 요청**
   - `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`
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
| 로그에 `서명 검증 실패` | `APP_SECRET` 이 다름. Instagram 앱 시크릿 대신 메타 앱 시크릿(앱 설정 → 기본 설정)일 수 있으니 `인스타시크릿,메타시크릿` 처럼 쉼표로 둘 다 넣어도 됨 |
| 댓글을 달아도 로그가 전혀 없음 | `comments` 필드 구독 / 계정의 웹후크 구독 스위치 확인. 개발 모드라면 댓글 단 계정이 테스터인지 확인 |
| `messages 요청 실패` | 1단계의 **메시지 접근 허용** 확인. 같은 댓글에 이미 DM을 보냈거나 7일이 지난 경우에도 실패함 |
| 두 달쯤 뒤 갑자기 안 됨 (`Session has expired` 등) | 토큰 만료. 3단계의 KV(`TOKENS`) + 크론 설정 확인 후, 2단계에서 토큰을 새로 발급해 `IG_ACCESS_TOKEN` 교체 |

## 개발

```bash
node --test instagram-auto-dm/worker.test.mjs
```
