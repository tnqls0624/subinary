# 카드 문자 수집 / 조회 API 명세

> Phase 3 기준. 계약 스키마의 단일 소스는 `@family/contracts`(zod)이며, 본 문서는 예시다.
> 모든 엔드포인트는 전역 prefix `v1`을 사용한다. 타임스탬프는 ISO 8601 문자열(`toISOString`),
> **금액은 KRW 정수(원)**, 시각 기준은 `Asia/Seoul`, `confidence`는 0~100 정수다.
>
> 관련 설계: [ADR-0008 카드 문자 수집·파싱](../adr/0008-card-sms-ingestion-and-parsing.md) ·
> [ADR-0007 장치 HMAC 인증](../adr/0007-device-hmac-authentication.md) ·
> [Phase 3 빌드 스펙](../phase3-build-spec.md) · [장치/HMAC API](./devices.md)

## 개요

Phase 3은 두 종류의 진입점을 제공한다.

| 대상 | 방식 | 경로 | 쓰임 |
|---|---|---|---|
| 장치(스마트폰) | HMAC-SHA256 서명 | `POST /v1/mobile-events/card-sms` | 카드 문자 **수집**(원문 업로드) |
| 사용자(사람) | JWT Access Token | `GET /v1/card-sms-events[...]` | 수집·파싱 결과 **조회** |

- 수집은 Phase 2의 `DeviceHmacGuard`(ADR-0007)를 그대로 재사용한다 — 서명 프로토콜은
  [devices.md §2](./devices.md)와 동일하다.
- 수집은 **멱등**이다. 동일 장치의 동일 `eventId` 재전송은 중복 저장·재파싱 없이 성공 응답만
  받는다(`duplicate:true`).
- 파싱은 BullMQ 워커에서 **비동기**로 수행된다. 수집 응답은 즉시 `queued`로 수락하고, 결과는
  조회 API를 폴링해 확인한다(`parseStatus`).
- 원문은 MinIO(권위 사본)와 DB `rawContent`(편의 사본)에 **이중 보존**된다. 상세 조회로 원문을
  돌려받을 수 있다.
- **응답/로그 어디에도** 문자 원문 전체·PII·secret·서명을 남기지 않는다(운영 로그는
  eventId/contentHash/상태/issuer만).

---

## 1. 수집 — `Controller('mobile-events')` → `POST /v1/mobile-events/card-sms`

장치가 수신한 카드 문자 1건을 업로드한다. Phase 2 ping과 동일한 HMAC 서명으로 인증하며,
전역 `AccessTokenGuard`는 `@Public()`로 우회하고 `DeviceHmacGuard`가 서명을 검증한다.

### 서명 헤더 (devices.md §2와 동일)

| 헤더 | 값 |
|---|---|
| `X-Device-Id` | 등록 시 받은 `deviceId` |
| `X-Timestamp` | 정수 epoch seconds **문자열** |
| `X-Nonce` | 요청마다 **고유한** 임의 문자열(예: 16바이트 hex) |
| `X-Signature` | `HMAC-SHA256(secret, ${X-Timestamp}.${X-Nonce}.${rawBody})` 의 hex digest |

- Content-Type은 반드시 `application/json`.
- `rawBody`는 **실제 전송 본문 바이트**와 정확히 일치해야 한다(재직렬화로 1바이트라도 달라지면
  서명 불일치 → 일반 `401`).

### 요청 body (`cardSmsIngestRequestSchema`)

```json
{
  "eventId": "b3f1c2a4-...-uuid",
  "sender": "15447200",
  "content": "신한카드 승인 12,500원 일시불 07/15 19:32 스타벅스",
  "receivedAt": "2026-07-15T10:32:00.000Z"
}
```

| 필드 | 규칙 |
|---|---|
| `eventId` | 장치가 부여한 고유 id(문자열, 1–200자). 멱등 키 — `UNIQUE(deviceId, eventId)`. |
| `sender` | 발신번호/발신자(1–100자). |
| `content` | 문자 원문(1–4000자). |
| `receivedAt` | 장치 수신 시각(ISO 8601 datetime). 파서가 `MM/DD` 연도 보정 기준으로 사용. |

```bash
DEVICE_ID="d1e2…"
SECRET="f3a9…"                         # 등록/회전 시 1회 노출된 raw secret
TS=$(date +%s)
NONCE=$(openssl rand -hex 16)
BODY='{"eventId":"b3f1c2a4-…","sender":"15447200","content":"신한카드 승인 12,500원 일시불 07/15 19:32 스타벅스","receivedAt":"2026-07-15T10:32:00.000Z"}'
SIG=$(printf '%s.%s.%s' "$TS" "$NONCE" "$BODY" \
      | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)

curl -s -i -X POST http://localhost:3001/v1/mobile-events/card-sms \
  -H 'Content-Type: application/json' \
  -H "X-Device-Id: $DEVICE_ID" -H "X-Timestamp: $TS" \
  -H "X-Nonce: $NONCE" -H "X-Signature: $SIG" \
  --data "$BODY"
```

> `printf`/`--data`는 개행을 붙이지 않아 서명 대상과 전송 본문의 바이트가 일치한다.

### 응답 `200 OK` (`cardSmsIngestResponseSchema`)

신규 수집(파싱 큐 등록됨):

```json
{ "accepted": true, "eventId": "b3f1c2a4-…", "processingStatus": "queued", "duplicate": false }
```

동일 `eventId` 재전송(멱등 — 중복 저장·재파싱 없음):

```json
{ "accepted": true, "eventId": "b3f1c2a4-…", "processingStatus": "duplicate", "duplicate": true }
```

| 필드 | 의미 |
|---|---|
| `accepted` | 항상 `true`(수락). |
| `processingStatus` | `queued`(신규, 파싱 enqueue됨) \| `duplicate`(기존 존재, 무작업). |
| `duplicate` | `processingStatus==='duplicate'` 와 동치. |

오류 규칙(HMAC 실패는 원인 비노출 일반 `401`, devices.md §2와 동일):

| 상황 | 응답 |
|---|---|
| 서명 헤더 누락 / 서명 불일치 / 장치 비활성 / timestamp 만료 / nonce 재사용 | `401` |
| Content-Type이 `application/json` 아님 | `401`(또는 `415`) |
| body 스키마 위반(필드 누락·길이 초과 등) | `400`(zod) |
| 본문 크기 초과(`MOBILE_MAX_BODY_BYTES`) | `413`(Fastify) |

> 파싱은 비동기다 — 수집 응답의 `queued`는 "파싱 완료"가 아니라 "파싱 큐 등록"을 뜻한다.
> 결과는 아래 조회 API를 폴링(권장 상한 10초)해 `parseStatus`로 확인한다.

---

## 2. 조회 — `Controller('card-sms-events')` → `/v1/card-sms-events`

사용자 인증(Bearer) 필요. 권한은 **서비스 계층에서 `actorUserId` 기준으로 강제**된다 — 요청자가
해당 가족의 활성 멤버가 아니면 `403 Forbidden`(PRD §26).

| 메서드 · 경로 | 성공 | 설명 |
|---|---|---|
| `GET /v1/card-sms-events?householdId=…&status=…&limit=…&cursor=…` | `200` | 가족 카드 문자 목록(summary) |
| `GET /v1/card-sms-events/:id` | `200` | 단건 상세(detail, `rawContent` 포함) |

### `GET /v1/card-sms-events?householdId=…`

| 쿼리 | 규칙 |
|---|---|
| `householdId` | 필수. 요청자는 이 가족의 활성 멤버여야 함(아니면 `403`). |
| `status` | 선택. `pending \| parsed \| parse_failed \| pending_review`. `parse_failed` 필터로 검토 대상 조회. |
| `limit` | 선택. 기본 50, 최대 100. |
| `cursor` | 선택. 페이지네이션 커서. |

```bash
curl -s 'http://localhost:3001/v1/card-sms-events?householdId=3c2d…&status=parsed' \
  -H 'Authorization: Bearer <accessToken>'
```

응답 `200 OK` — 항목은 `cardSmsEventSummarySchema`(원문 `rawContent`는 상세에서만 노출):

```json
[
  {
    "id": "e9a0…",
    "eventId": "b3f1c2a4-…",
    "sender": "15447200",
    "receivedAt": "2026-07-15T10:32:00.000Z",
    "parseStatus": "parsed",
    "issuer": "신한카드",
    "transactionType": "approval",
    "amount": 12500,
    "currency": "KRW",
    "merchantRaw": "스타벅스",
    "occurredAt": "2026-07-15T10:32:00.000Z",
    "installmentMonths": 1,
    "confidence": 95,
    "parseError": null,
    "createdAt": "2026-07-15T10:32:01.000Z"
  }
]
```

- 비멤버가 조회 시도 → `403 Forbidden`.
- `amount`는 항상 KRW 정수(파싱 전/실패 시 `null`). `confidence`는 0~100 정수(`null` 가능).

### `GET /v1/card-sms-events/:id`

단건 상세. 원문(`rawContent`)과 마스킹 카드번호를 포함한다(`cardSmsEventDetailSchema` =
summary + `rawContent`, `maskedCardNumber`). 요청자는 해당 이벤트 가족의 활성 멤버여야 한다.

```bash
curl -s 'http://localhost:3001/v1/card-sms-events/e9a0…' \
  -H 'Authorization: Bearer <accessToken>'
```

```json
{
  "id": "e9a0…",
  "eventId": "b3f1c2a4-…",
  "sender": "15447200",
  "receivedAt": "2026-07-15T10:32:00.000Z",
  "parseStatus": "parsed",
  "issuer": "신한카드",
  "transactionType": "approval",
  "amount": 12500,
  "currency": "KRW",
  "merchantRaw": "스타벅스",
  "occurredAt": "2026-07-15T10:32:00.000Z",
  "installmentMonths": 1,
  "confidence": 95,
  "parseError": null,
  "createdAt": "2026-07-15T10:32:01.000Z",
  "rawContent": "신한카드 승인 12,500원 일시불 07/15 19:32 스타벅스",
  "maskedCardNumber": null
}
```

> `parse_failed` 이벤트도 상세로 조회해 `rawContent`(원문)를 그대로 확인할 수 있다 — 파싱이
> 실패해도 원문은 유실되지 않는다(ADR-0008 원문 이중보존).

---

## 3. `parseStatus` 상태 기계

| 상태 | 의미 |
|---|---|
| `pending` | 수집 직후, 파싱 대기(워커 미처리). |
| `parsed` | 파싱 성공(type≠unknown, amount 확보, `confidence≥70`, warning 없음). |
| `pending_review` | 파싱은 됐으나 warning 있음 또는 `confidence<70` — 사람 검토 권장. |
| `parse_failed` | 매칭 파서 없음 또는 금액 추출 실패(`parseError`에 사유 요약). |

---

## 4. 카드사 문자 포맷 · 파싱 결과 예시

파서는 순수 패키지 `@family/card-parsers`의 카드사별 Strategy로 구현된다(ADR-0008 §3). 금액은
콤마·`원` 제거 후 `Number.isInteger` 검증한 KRW 정수만 채택하고, `MM/DD HH:mm`은 `receivedAt`의
연도 + `Asia/Seoul` 존으로 `occurredAt`을 조합한다(미래로 튀면 전년 롤오버).

### 신한카드 — 승인

```
입력  : 신한카드 승인 12,500원 일시불 07/15 19:32 스타벅스
결과  : { issuer:'신한카드', transactionType:'approval', amount:12500, currency:'KRW',
         merchantRaw:'스타벅스', installmentMonths:1, occurredAt:<Asia/Seoul 07/15 19:32> }
상태  : parsed
```

### 신한카드 — 취소

```
입력  : 신한카드 취소 12,500원 07/15 20:00 스타벅스
결과  : { issuer:'신한카드', transactionType:'cancellation', amount:12500, currency:'KRW',
         merchantRaw:'스타벅스', occurredAt:<Asia/Seoul 07/15 20:00> }
상태  : parsed
```

### KB국민카드 — 승인

```
입력  : KB국민카드 승인 8,900원 07/15 12:10 김밥천국
결과  : { issuer:'KB국민카드', transactionType:'approval', amount:8900, currency:'KRW',
         merchantRaw:'김밥천국', occurredAt:<Asia/Seoul 07/15 12:10> }
상태  : parsed
```

### 결제 대행사만 확인되는 경우 (PRD §15)

```
입력  : 신한카드 승인 30,000원 07/15 21:00 네이버페이
결과  : { issuer:'신한카드', transactionType:'approval', amount:30000, currency:'KRW',
         merchantRaw:'네이버페이',
         warnings:['payment aggregator; merchant unconfirmed'] }
상태  : pending_review  (실제 가맹점을 임의로 생성하지 않고 검토로 넘긴다)
```

### 비카드(파싱 불가) 문자

```
입력  : [Web발신] 인증번호 [572913] 를 입력해 주세요.
결과  : { transactionType:'unknown', confidence:0, warnings:['no matching parser'] }
상태  : parse_failed  (원문은 상세 조회로 확인 가능)
```

---

## 5. 검증 (완료 조건 e2e)

Phase 3 완료 조건은 `scripts/verify-phase3.mjs`가 실 스택(`http://localhost:3001`)을 대상으로
자동 검증한다(스펙 §8.2 시나리오 1~9). Node 내장 `fetch` + `node:crypto`만 사용하고, 장치
서명은 verify-phase2와 동일한 레시피(`HMAC-SHA256(secret, ${ts}.${nonce}.${bodyString})`)로
만들며 body는 서명한 문자열과 **동일 바이트**로 전송한다. 파싱은 비동기이므로 최대 10초 폴링한다.

```bash
# 전체 스택 기동(진행자 수행): docker compose up -d --build
node scripts/verify-phase3.mjs
# 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase3.mjs
```

검증 시나리오: 신한 승인 수집 `200 queued` → 폴링 후 `parsed`(amount=12500 정수/KRW,
type=approval, 가맹점 일치) → 동일 eventId 재전송 `duplicate:true`(중복 저장 없음) → 신한 취소
`cancellation` → KB 승인 `parsed` → 비카드 `parse_failed`(상세로 원문 확인) → 비멤버 조회
`403` → 금액 정수/통화 KRW 재확인. 전부 통과 시 종료 코드 `0`, 하나라도 실패하면 첫 실패
지점에서 명확한 메시지와 함께 `1`로 종료한다. 로그에는 원문 전체·secret·서명을 출력하지 않는다.
