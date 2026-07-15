# 장치 등록 / HMAC 인증 API 명세

> Phase 2 기준. 계약 스키마의 단일 소스는 `@family/contracts`(zod)이며, 본 문서는 예시다.
> 모든 엔드포인트는 전역 prefix `v1`을 사용한다. 타임스탬프는 ISO 8601 문자열(`toISOString`),
> 금액은 KRW 정수, 시각 기준은 `Asia/Seoul`이다.
>
> 관련 설계: [ADR-0007 장치 HMAC 인증](../adr/0007-device-hmac-authentication.md) ·
> [Phase 2 빌드 스펙](../phase2-build-spec.md) · [인증/가족 API](./auth-household.md)

## 인증 모델 요약

Phase 2는 **두 종류의 자격증명**을 구분한다.

| 대상 | 방식 | 전송 | 저장 | 쓰임 |
|---|---|---|---|---|
| 사용자(사람) | JWT Access Token | `Authorization: Bearer <jwt>` | 무상태 | 장치 **관리**(`/v1/devices/*`) |
| 장치(스마트폰) | 장치별 32바이트 secret | HMAC-SHA256 서명 헤더 | DB엔 **AES-256-GCM 암호문**만 | 장치 **요청**(`/v1/mobile-events/*`) |

- 장치는 **가족(household)·구성원(member) 소유**다. 등록/회전/폐기 같은 관리는 장치 소유자
  본인 또는 그 가족 **owner**만 할 수 있다(서비스 계층에서 `actorUserId` 기준 강제, PRD §26).
- raw secret은 **등록/회전 응답에서 1회만** 노출된다. 이후 다시 조회할 수 없다. DB에는 원문이
  아니라 `AES-256-GCM(secret, encKey)`의 `{ ciphertext, iv, authTag }`만 저장된다
  (해시 저장은 HMAC 재계산 불가로 사용하지 못한다 — ADR-0007 참고).
- **응답/로그 어디에도 secret 원문/암호문/암호화 키/서명/해시를 노출하지 않는다.**
- HMAC 인증 실패는 원인·장치 존재 여부를 노출하지 않는 **일반 `401`**로 응답한다. 남의 장치
  관리 시도는 `403`이다.

---

## 1. 장치 관리 — `Controller('devices')` → `/v1/devices`

전부 사용자 인증 필요(Bearer). 권한은 **서비스 계층에서 `actorUserId` 기준으로 강제**된다.

| 메서드 · 경로 | 필요 권한 | 성공 | 설명 |
|---|---|---|---|
| `POST /v1/devices/register` | 가족 활성 멤버 | `201` | 장치 등록 + secret 발급(1회 노출) |
| `GET /v1/devices?householdId=…` | 가족 활성 멤버 | `200` | 가족 장치 목록 |
| `POST /v1/devices/:id/rotate-secret` | 장치 소유자 \| 가족 owner | `200` | secret 회전(옛 secret 즉시 무효) |
| `DELETE /v1/devices/:id` | 장치 소유자 \| 가족 owner | `200` | 장치 폐기(모든 credential revoke) |

### `POST /v1/devices/register`

장치를 가족에 등록하고 장치별 secret을 발급한다. 등록자는 해당 가족의 활성 멤버여야 하며,
장치는 등록자의 멤버십(memberId)에 귀속된다.

요청 body (`deviceRegisterRequestSchema`):

```json
{ "householdId": "3c2d…", "name": "A의 아이폰", "platform": "ios" }
```

- `platform`: `ios | android | other`.
- `name`: 1–100자.

```bash
curl -s -X POST http://localhost:3001/v1/devices/register \
  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \
  -d '{"householdId":"3c2d…","name":"A의 아이폰","platform":"ios"}'
```

응답 `201 Created` (`deviceSecretResponseSchema`) — `secret`은 **이 응답에서만** 노출된다:

```json
{
  "device": {
    "id": "d1e2…",
    "householdId": "3c2d…",
    "memberId": "aa11…",
    "name": "A의 아이폰",
    "platform": "ios",
    "status": "active",
    "lastSeenAt": null,
    "createdAt": "2026-07-15T09:30:00.000Z"
  },
  "deviceId": "d1e2…",
  "secret": "f3a9…(64 hex, raw, 1회 노출)",
  "algorithm": "HMAC-SHA256",
  "signingRecipe": "HMAC-SHA256(secret, `${X-Timestamp}.${X-Nonce}.${rawBody}`)"
}
```

- 비멤버가 등록 시도 → `403 Forbidden`.
- 검증 실패(예: platform 미지원) → `400 Bad Request`(zod).

### `GET /v1/devices?householdId=…`

가족의 장치 목록을 조회한다. **credential material(secret/암호문)은 절대 포함되지 않는다.**

```bash
curl -s 'http://localhost:3001/v1/devices?householdId=3c2d…' \
  -H 'Authorization: Bearer <accessToken>'
```

응답 `200 OK` (`deviceSummarySchema[]`):

```json
[
  {
    "id": "d1e2…",
    "householdId": "3c2d…",
    "memberId": "aa11…",
    "name": "A의 아이폰",
    "platform": "ios",
    "status": "active",
    "lastSeenAt": "2026-07-15T09:31:12.000Z",
    "createdAt": "2026-07-15T09:30:00.000Z"
  }
]
```

### `POST /v1/devices/:id/rotate-secret`

새 secret을 발급하고 기존 active credential을 revoke한다. **회전 즉시 옛 secret으로 만든
서명은 실패**한다. 별도 요청 body는 없다.

```bash
curl -s -X POST http://localhost:3001/v1/devices/d1e2…/rotate-secret \
  -H 'Authorization: Bearer <accessToken>'
```

응답 `200 OK` (`deviceSecretResponseSchema`) — register와 동일 형태, 새 `secret` 1회 노출.

- 장치 소유자 본인 또는 가족 owner가 아니면 → `403 Forbidden`.

### `DELETE /v1/devices/:id`

장치를 폐기한다. 장치 status를 `revoked`로 내리고 모든 credential을 revoke한다. 이후 어떤
서명도 통과하지 못한다.

```bash
curl -s -i -X DELETE http://localhost:3001/v1/devices/d1e2… \
  -H 'Authorization: Bearer <accessToken>'
```

응답 `200 OK` (`{ "revoked": true }`).

- 장치 소유자 본인 또는 가족 owner가 아니면 → `403 Forbidden`.

---

## 2. 장치 요청(HMAC) — `Controller('mobile-events')` → `/v1/mobile-events`

장치가 보내는 요청은 사용자 Bearer 토큰 대신 **HMAC-SHA256 서명**으로 인증한다. 전역
`AccessTokenGuard`는 `@Public()`로 우회하고, 컨트롤러의 `DeviceHmacGuard`가 서명을 검증한다.
Phase 2는 가드 통과를 확인하는 `POST /v1/mobile-events/ping`만 제공한다(Phase 3의 카드 문자
수집 엔드포인트가 동일 가드를 재사용한다).

### 서명 프로토콜

요청마다 아래 4개 헤더를 보낸다. Content-Type은 반드시 `application/json`이다.

| 헤더 | 값 |
|---|---|
| `X-Device-Id` | 등록 시 받은 `deviceId` |
| `X-Timestamp` | 정수 epoch seconds **문자열** (예: `1752570000`) |
| `X-Nonce` | 요청마다 **고유한** 임의 문자열(예: 16바이트 hex) |
| `X-Signature` | 아래 레시피의 HMAC hex digest |

**서명 레시피** (`deviceSecretResponse.signingRecipe`):

```
payload   = `${X-Timestamp}.${X-Nonce}.${rawBody}`   ← 원본 요청 본문 바이트(파싱 전)
X-Signature = HMAC-SHA256(secret, payload) 의 hex digest
```

- `rawBody`는 **실제로 전송하는 본문 바이트**와 정확히 일치해야 한다. 본문을 재직렬화해
  1바이트라도 달라지면 서명이 불일치한다(전송한 문자열 그대로 서명할 것).
- 서버 검증 순서: 헤더 존재 → Content-Type(`application/json`) → 장치 활성 → active
  credential 존재 → **timestamp 허용오차**(기본 300초) → **서명 일치**(상수시간 비교) →
  **nonce 미사용**(`UNIQUE(deviceId, nonce)`). 하나라도 실패하면 일반 `401`.
- **Replay 방어**: `|now - X-Timestamp|`가 허용오차를 넘거나(만료), 동일 `(deviceId, nonce)`가
  이미 사용됐으면 거부한다. nonce는 `X-Timestamp + DEVICE_NONCE_TTL_SEC`(기본 600초)까지 보관된다.

관련 env(P4 배선): `DEVICE_SECRET_ENC_KEY`(32바이트 hex),
`HMAC_TIMESTAMP_TOLERANCE_SEC`(기본 300), `DEVICE_NONCE_TTL_SEC`(기본 600),
`MOBILE_MAX_BODY_BYTES`(기본 16384 — 초과 시 Fastify가 `413`).

### `POST /v1/mobile-events/ping`

서명이 유효하면 인증 성공을 확인해 준다(장치 상태 갱신 `lastSeenAt` 포함).

셸에서 서명을 계산하는 예시(openssl HMAC). `SECRET`은 등록/회전 시 1회 노출된 raw secret이다:

```bash
DEVICE_ID="d1e2…"
SECRET="f3a9…"                       # 등록/회전 응답의 raw secret(1회 노출)
TS=$(date +%s)                       # 정수 epoch seconds
NONCE=$(openssl rand -hex 16)        # 요청마다 고유
BODY='{"source":"manual-test"}'      # 전송할 본문(서명 대상과 동일 바이트)

# payload = "${TS}.${NONCE}.${BODY}" 를 HMAC-SHA256 hex 로 서명
SIG=$(printf '%s.%s.%s' "$TS" "$NONCE" "$BODY" \
      | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)

curl -s -i -X POST http://localhost:3001/v1/mobile-events/ping \
  -H 'Content-Type: application/json' \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "X-Timestamp: $TS" \
  -H "X-Nonce: $NONCE" \
  -H "X-Signature: $SIG" \
  --data "$BODY"
```

> `openssl dgst -r`는 `<hex> *stdin` 형식으로 출력하므로 `cut -d' ' -f1`로 hex만 취한다.
> `printf`/`--data`는 개행을 붙이지 않아 서명 대상과 전송 본문의 바이트가 일치한다.

응답 `200 OK` (`devicePingResponseSchema`):

```json
{
  "authenticated": true,
  "deviceId": "d1e2…",
  "householdId": "3c2d…",
  "receivedAt": "2026-07-15T09:31:12.000Z"
}
```

오류 규칙(모두 동일한 일반 메시지의 `401`, 원인 비노출):

| 상황 | 응답 |
|---|---|
| 서명 헤더 누락(넷 중 하나라도) | `401 Unauthorized` |
| Content-Type이 `application/json` 아님 | `401`(또는 `415`) |
| 장치 미존재 / 비활성(폐기) | `401 Unauthorized` |
| active credential 없음 | `401 Unauthorized` |
| timestamp 허용오차 초과(만료) | `401 Unauthorized` |
| 서명 불일치(옛 secret 포함) | `401 Unauthorized` |
| nonce 재사용(replay) | `401 Unauthorized` |
| 본문 크기 초과(`MOBILE_MAX_BODY_BYTES`) | `413 Payload Too Large`(Fastify) |

---

## 3. 검증 (완료 조건 e2e)

Phase 2 완료 조건은 `scripts/verify-phase2.mjs`가 실 스택(`http://localhost:3001`)을 대상으로
자동 검증한다(스펙 §6 시나리오 1~9, 선택 10). Node 내장 `fetch` + `node:crypto`만 사용하며,
클라이언트 서명은 `createHmac('sha256', secret)`로 `` `${ts}.${nonce}.${bodyString}` ``의 hex
digest를 만들고, 요청 body는 서명한 문자열과 **동일 바이트**로 전송한다.

```bash
# 전체 스택 기동(진행자 수행): docker compose up -d --build
node scripts/verify-phase2.mjs
# 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase2.mjs
```

검증 시나리오: 장치 등록(secret 1회 노출) → 정상 서명 `200` → 잘못된 서명 `401` → 만료
timestamp `401` → nonce 재사용 `401` → secret 회전(옛 `401`/새 `200`) → 남의 장치
관리 `403` → 폐기 후 정상 서명도 `401`. 전부 통과 시 종료 코드 `0`, 하나라도 실패하면 첫
실패 지점에서 명확한 메시지와 함께 `1`로 종료한다. 로그에는 secret/서명/토큰 원문을 출력하지
않는다.
