# 인증 / 가족 / 초대 API 명세

> Phase 1 기준. 계약 스키마의 단일 소스는 `@family/contracts`(zod)이며, 본 문서는 예시다.
> 모든 엔드포인트는 전역 prefix `v1`을 사용한다. 타임스탬프는 ISO 8601 문자열(`toISOString`),
> 금액은 KRW 정수, 시각 기준은 `Asia/Seoul`이다.
>
> 관련 설계: [ADR-0005 인증/토큰 회전](../adr/0005-auth-jwt-refresh-rotation.md) ·
> [ADR-0006 가족 역할/초대](../adr/0006-household-roles-and-invitations.md) ·
> [Phase 1 빌드 스펙](../phase1-build-spec.md)

## 인증 모델 요약

| 토큰 | 형태 | 전송 | 수명(기본) | 저장 |
|---|---|---|---|---|
| Access Token | JWT `{ sub, email }` | `Authorization: Bearer <jwt>` 헤더 | 900초 | 무상태(저장 안 함) |
| Refresh Token | 불투명 랜덤(hex) | HttpOnly 쿠키 `refresh_token` | 30일 | DB엔 `sha256` **해시만** |

- 기본적으로 **모든 라우트가 인증 필요**(전역 `AccessTokenGuard`)다. `@Public()`이 붙은
  `register` / `login` / `refresh`만 토큰 없이 호출한다.
- Refresh 쿠키 옵션: `HttpOnly`, `SameSite=Lax`, `Path=/v1/auth`, `Secure`(production 한정),
  `Max-Age=REFRESH_TTL`. 경로가 `/v1/auth`로 스코프되어 다른 엔드포인트로 전송되지 않는다.
- **응답/로그 어디에도 refresh 토큰 원문, 비밀번호, 해시를 노출하지 않는다.** 초대 raw 토큰만
  생성 응답에 **1회** 노출된다.
- 인증 실패는 자격 존재 여부를 노출하지 않는 일반 메시지의 `401`, 멤버십/권한 실패는 `403`이다.

### 쿠키 흐름 (요약)

```
register/login ──▶ 200/201 + Set-Cookie: refresh_token=<opaque>; HttpOnly; Path=/v1/auth; ...
                   응답 body.tokens.accessToken 을 메모리에 보관해 Bearer 로 사용

(access 만료 시)
POST /v1/auth/refresh (쿠키 자동 전송) ──▶ 200 + 새 accessToken + Set-Cookie: refresh_token=<새 값>
                   기존 refresh 세션은 폐기(회전). 이전 refresh 재사용 시 401 + 전 세션 폐기.

logout / change-password ──▶ 200 + Set-Cookie: refresh_token=; Max-Age=0 (쿠키 제거)
                   해당(또는 전체) refresh 세션 폐기.
```

---

## 1. 인증 — `Controller('auth')` → `/v1/auth`

| 메서드 · 경로 | 인증 | 성공 | 설명 |
|---|---|---|---|
| `POST /v1/auth/register` | Public | `201` | 회원가입 + 세션 발급 |
| `POST /v1/auth/login` | Public | `200` | 로그인 + 세션 발급 |
| `POST /v1/auth/refresh` | Public(쿠키) | `200` | refresh 회전 |
| `POST /v1/auth/logout` | Bearer | `200` | 세션 폐기 + 쿠키 제거 |
| `GET /v1/auth/me` | Bearer | `200` | 내 정보 + 멤버십 |
| `POST /v1/auth/change-password` | Bearer | `200` | 비밀번호 변경(전 세션 무효화) |

### `POST /v1/auth/register`

계정을 만들고 즉시 로그인 세션을 발급한다. 이메일은 소문자로 정규화되어 저장/반환된다.

요청 body (`registerRequestSchema`):

```json
{ "email": "owner@example.com", "password": "Passw0rd!123", "name": "Owner A" }
```

```bash
curl -s -i -X POST http://localhost:3001/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@example.com","password":"Passw0rd!123","name":"Owner A"}'
```

응답 `201 Created` (`authResultSchema`) + refresh 쿠키:

```http
HTTP/1.1 201 Created
Set-Cookie: refresh_token=6f1c…(opaque); Max-Age=2592000; Path=/v1/auth; HttpOnly; SameSite=Lax
```

```json
{
  "user": {
    "id": "0f9a…",
    "email": "owner@example.com",
    "name": "Owner A",
    "createdAt": "2026-07-15T09:12:45.123Z"
  },
  "tokens": { "accessToken": "eyJhbGciOi…", "tokenType": "Bearer", "expiresInSec": 900 }
}
```

- 이메일 중복 시 `409 Conflict`.
- 검증 실패(예: 비밀번호 8자 미만) 시 `400 Bad Request`(zod).

### `POST /v1/auth/login`

요청 body (`loginRequestSchema`):

```json
{ "email": "owner@example.com", "password": "Passw0rd!123" }
```

```bash
curl -s -i -X POST http://localhost:3001/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@example.com","password":"Passw0rd!123"}'
```

응답 `200 OK` — body는 register와 동일한 `authResultSchema`, refresh 쿠키 재설정.

- 잘못된 비밀번호 / 미존재 계정 / 비활성 계정은 모두 동일한 `401 Unauthorized`
  (자격 존재 여부 비노출).

### `POST /v1/auth/refresh`

HttpOnly `refresh_token` 쿠키를 읽어 **회전**한다. 기존 세션을 폐기하고 새 access token +
새 refresh 쿠키를 발급한다. 별도 요청 body는 없다.

```bash
# 쿠키를 파일로 보관하며 자동 전송(-b/-c). 브라우저는 자동 처리된다.
curl -s -i -X POST http://localhost:3001/v1/auth/refresh \
  -b cookies.txt -c cookies.txt
```

응답 `200 OK` — `authResultSchema` + **새** `Set-Cookie: refresh_token=…`(값이 이전과 다름).

- 유효하지 않음 / 만료 / 이미 폐기된 refresh → `401 Unauthorized`.
- **재사용 탐지**: 이미 회전되어 폐기된 refresh를 다시 제시하면 `401`과 함께 해당 사용자의
  **모든 세션이 폐기**된다(도난 방어).

### `POST /v1/auth/logout`

현재 refresh 세션을 폐기하고 쿠키를 제거한다(멱등 — 세션이 이미 없어도 `200`).

```bash
curl -s -i -X POST http://localhost:3001/v1/auth/logout \
  -H 'Authorization: Bearer <accessToken>' \
  -b cookies.txt -c cookies.txt
```

응답 `200 OK` — 쿠키 제거:

```http
Set-Cookie: refresh_token=; Max-Age=0; Path=/v1/auth; HttpOnly; SameSite=Lax
```

이후 동일 refresh로 `POST /v1/auth/refresh` 호출 시 `401`.

### `GET /v1/auth/me`

현재 사용자와 **활성(active) 가족 멤버십** 목록을 반환한다.

```bash
curl -s http://localhost:3001/v1/auth/me \
  -H 'Authorization: Bearer <accessToken>'
```

응답 `200 OK` (`meResponseSchema`):

```json
{
  "user": {
    "id": "0f9a…",
    "email": "owner@example.com",
    "name": "Owner A",
    "createdAt": "2026-07-15T09:12:45.123Z"
  },
  "memberships": [
    { "householdId": "3c2d…", "name": "A네 가족", "role": "owner", "status": "active" }
  ]
}
```

### `POST /v1/auth/change-password`

현재 비밀번호 확인 후 교체하고, **모든 세션을 폐기**(전 기기 재로그인 강제)한다.

요청 body (`changePasswordRequestSchema`):

```json
{ "currentPassword": "Passw0rd!123", "newPassword": "N3w-Passw0rd!" }
```

```bash
curl -s -i -X POST http://localhost:3001/v1/auth/change-password \
  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \
  -b cookies.txt -c cookies.txt \
  -d '{"currentPassword":"Passw0rd!123","newPassword":"N3w-Passw0rd!"}'
```

응답 `200 OK` — refresh 쿠키 제거. 현재 비밀번호 불일치 시 `401 Unauthorized`.

---

## 2. 가족 — `Controller('households')` → `/v1/households`

전부 인증 필요(Bearer). 권한은 **서비스 계층에서 `actorUserId` 기준으로 강제**된다. 비멤버는
`403`, 역할 부족도 `403`이다.

| 메서드 · 경로 | 필요 역할 | 성공 | 설명 |
|---|---|---|---|
| `POST /v1/households` | (인증) | `201` | 가족 생성(생성자=owner) |
| `GET /v1/households/:id` | member+ | `200` | 가족 조회 |
| `PATCH /v1/households/:id` | owner \| admin | `200` | 이름 변경 |
| `POST /v1/households/:id/invitations` | owner | `201` | 초대 생성(raw 토큰 1회 노출) |
| `GET /v1/households/:id/invitations` | owner \| admin | `200` | 초대 목록 |
| `GET /v1/households/:id/members` | member+ | `200` | 구성원 목록 |
| `PATCH /v1/households/:id/members/:memberId` | owner | `200` | 역할 변경 |
| `DELETE /v1/households/:id/members/:memberId` | owner(또는 본인 탈퇴) | `200` | 구성원 제거 |
| `DELETE /v1/households/:id/invitations/:invitationId` | owner | `200` | 초대 취소 |

> `member+`는 owner/admin/member/viewer 등 활성 멤버 누구나. POST/PATCH/DELETE의 성공 코드는
> NestJS 기본값(POST `201`, 그 외 `200`)을 따른다.

### `POST /v1/households`

요청 body (`householdCreateRequestSchema`):

```json
{ "name": "A네 가족" }
```

```bash
curl -s -X POST http://localhost:3001/v1/households \
  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \
  -d '{"name":"A네 가족"}'
```

응답 `201 Created` (`householdSummarySchema`) — 생성자는 owner로 등록되고 합류 동의가 기록된다:

```json
{ "id": "3c2d…", "name": "A네 가족", "createdAt": "2026-07-15T09:20:00.000Z", "myRole": "owner" }
```

### `GET /v1/households/:id`

```bash
curl -s http://localhost:3001/v1/households/3c2d… \
  -H 'Authorization: Bearer <accessToken>'
```

응답 `200 OK` (`householdSummarySchema`, `myRole`는 호출자의 역할). **비멤버 → `403 Forbidden`.**

### `PATCH /v1/households/:id`

owner 또는 admin만 이름을 변경한다. 요청 body (`householdUpdateRequestSchema`): `{ "name": "새 이름" }`.
응답 `200 OK` (`householdSummarySchema`). 권한 부족 → `403`.

### `POST /v1/households/:id/invitations`

owner만 초대를 생성한다. raw 토큰은 **이 응답에서 1회만** 노출된다(이후 조회 불가).

요청 body (`invitationCreateRequestSchema`, 모든 필드 선택 — 기본값 존재):

```json
{ "email": "user-b@example.com", "role": "member", "expiresInHours": 168 }
```

- `role`: `admin | member | viewer`(owner 불가), 기본 `member`.
- `expiresInHours`: `1`–`720` 정수, 기본 `168`(7일).
- `email` 지정 시 수락자 이메일이 일치해야 한다.

```bash
curl -s -X POST http://localhost:3001/v1/households/3c2d…/invitations \
  -H 'Authorization: Bearer <ownerAccessToken>' -H 'Content-Type: application/json' \
  -d '{"role":"member"}'
```

응답 `201 Created` (`invitationCreatedSchema`):

```json
{
  "invitationId": "9b7e…",
  "token": "a1b2c3…(raw, 1회 노출)",
  "expiresAt": "2026-07-22T09:20:00.000Z",
  "role": "member",
  "acceptUrlPath": "/v1/household-invitations/a1b2c3…/accept"
}
```

**owner가 아닌 멤버(member/viewer/admin)의 호출 → `403 Forbidden`.**

### `GET /v1/households/:id/invitations`

owner 또는 admin이 초대 목록을 조회한다. raw 토큰은 **절대 포함되지 않는다.**

응답 `200 OK` (`invitationSummarySchema[]`):

```json
[
  {
    "id": "9b7e…",
    "email": "user-b@example.com",
    "role": "member",
    "status": "pending",
    "expiresAt": "2026-07-22T09:20:00.000Z",
    "createdAt": "2026-07-15T09:20:00.000Z"
  }
]
```

### `GET /v1/households/:id/members`

활성 멤버 누구나 구성원 목록을 조회한다.

응답 `200 OK` (`memberSummarySchema[]`):

```json
[
  {
    "memberId": "aa11…",
    "userId": "0f9a…",
    "name": "Owner A",
    "email": "owner@example.com",
    "role": "owner",
    "status": "active",
    "joinedAt": "2026-07-15T09:20:00.000Z"
  }
]
```

### `PATCH /v1/households/:id/members/:memberId`

owner만 대상 멤버의 역할을 변경한다. 요청 body (`memberRoleUpdateRequestSchema`):

```json
{ "role": "admin" }
```

- `role`: `admin | member | viewer`(owner 불가 — 소유권 이전 미지원).
- 대상이 owner이면 `403 Forbidden`(강등 불가).

응답 `200 OK` (`memberSummarySchema`, 변경된 역할 반영).

### `DELETE /v1/households/:id/members/:memberId`

owner가 구성원을 제거하거나, 본인이 스스로 탈퇴한다. `status`가 `removed`로 전환된다.

- **마지막 owner 제거는 금지** → `400 Bad Request`.

```bash
curl -s -i -X DELETE http://localhost:3001/v1/households/3c2d…/members/bb22… \
  -H 'Authorization: Bearer <ownerAccessToken>'
```

응답 `200 OK`.

### `DELETE /v1/households/:id/invitations/:invitationId`

owner가 대기 중 초대를 취소한다. `status`가 `revoked`로 전환되어 해당 토큰은 더 이상 수락되지
않는다(수락 시도 시 4xx).

응답 `200 OK`.

---

## 3. 초대 수락 — `Controller('household-invitations')` → `/v1/household-invitations`

### `POST /v1/household-invitations/:token/accept`

**인증 필요.** URL 경로의 `:token`은 초대 생성 시 받은 **raw 토큰**이다. 서버는 이를 해시해
매칭한다. 합류 동의(`consent: true`)가 필수다.

요청 body (`acceptInvitationRequestSchema`):

```json
{ "consent": true }
```

```bash
curl -s -X POST http://localhost:3001/v1/household-invitations/a1b2c3…/accept \
  -H 'Authorization: Bearer <userBAccessToken>' -H 'Content-Type: application/json' \
  -d '{"consent":true}'
```

응답 `2xx` (`householdSummarySchema`) — 초대 역할로 합류하고 합류 동의가 기록된다:

```json
{ "id": "3c2d…", "name": "A네 가족", "createdAt": "2026-07-15T09:20:00.000Z", "myRole": "member" }
```

오류 규칙:

| 상황 | 응답 |
|---|---|
| `consent`가 `true`가 아님 | `400 Bad Request` |
| 토큰 미존재(해시 불일치) | `404 Not Found` |
| 이미 수락/취소/만료된 초대(재사용) | `4xx`(`410 Gone` / `409 Conflict`) |
| 만료 시각 초과 | `410 Gone`(초대가 `expired`로 마킹됨) |
| 지정 이메일과 수락자 이메일 불일치 | `403 Forbidden` |
| 이미 멤버가 재수락 | `2xx`(초대만 `accepted` 처리, 기존 멤버십 반환 — 멱등) |

---

## 4. 검증 (완료 조건 e2e)

Phase 1 완료 조건은 `scripts/verify-phase1.mjs`가 실 스택(`http://localhost:3001`)을 대상으로
자동 검증한다(스펙 §6의 시나리오 1~14). Node 내장 fetch만 사용하며 `set-cookie`를 수동
보관해 refresh 회전을 확인한다. 초대 만료는 서버 시간 조작이 불가하므로 **revoke 후 수락이
4xx로 차단되는지**로 대체 검증한다.

```bash
# 전체 스택 기동(진행자 수행): docker compose up -d --build
node scripts/verify-phase1.mjs
# 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase1.mjs
```

전부 통과 시 종료 코드 `0`, 하나라도 실패하면 첫 실패 지점에서 명확한 메시지와 함께 `1`로
종료하고 통과/실패 카운트를 요약 출력한다.
