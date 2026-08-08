# Addendum — 카드 문자 토큰 수집 (단축어/MacroDroid용)

> Phase 2/3 확장. 단축어(iOS)/MacroDroid(Android)가 HMAC-SHA256을 계산하기 어려우므로, **장치별 수집 토큰(Bearer)** 기반의 간편 수집 경로를 추가한다. 기존 HMAC 경로(`POST /v1/mobile-events/card-sms`)는 그대로 유지한다(병행).

Phase 0~10 규약 준수(패키지 `type:module` 금지, 소스 바인드마운트, Asia/Seoul, 로그 Secret/PII 금지, 새 env는 `.env`도, 새 npm 의존성 시 lockfile 재생성, 교차모듈 `@UseGuards`는 제공모듈이 가드 의존성까지 export, BullMQ jobId ':' 금지).

---

## 0. 목표 & 완료 조건

`POST /v1/mobile-events/card-sms-token` (Authorization: Bearer <수집 토큰>) 로 카드 문자를 수집한다. 단축어/MacroDroid의 "고정 헤더 + JSON POST"만으로 동작.

완료 조건(실측, `scripts/verify-card-sms-token.mjs`):
1. 장치 등록/회전 응답에 `collectToken`(1회 노출) 포함.
2. 유효 토큰 + 카드 문자 → 200 `queued`, 비동기 파싱 후 `parsed`.
3. 동일 eventId 재전송 → `duplicate:true`(멱등, 중복 저장 없음) — HMAC 경로와 동일 `CardSmsIngestService.ingest` 재사용.
4. 잘못된/폐기된 토큰 → 401.
5. 폐기 장치(status revoked) 토큰 → 401.

---

## 1. 보안 모델 (HMAC 경로 대비 트레이드오프 명시)
- 수집 토큰 = `randomBytes(32).toString('hex')`(256비트). DB엔 **sha256 해시만** 저장(원문 미저장). 응답에 raw는 등록/회전 시 1회만.
- 인증: `Authorization: Bearer <token>` → sha256 → `registered_devices.collect_token_hash` 매칭 + `status='active'` → 장치 식별.
- **완화 지점(PRD §26 대비)**: 서명/nonce/timestamp 없음 → per-request replay는 nonce로 막지 않는다. 대신:
  - `eventId` UNIQUE(deviceId,eventId) 멱등 → 동일 문자 재전송/재생은 무해(중복 저장 안 됨).
  - 위조 문자 주입은 **토큰 비밀성**에 의존(HTTPS 필수) → 유출 시 `rotate`/`revoke`로 대응.
- HMAC 경로가 필요한 장치는 기존 `card-sms`(서명)를 계속 쓴다. 토큰 경로는 저마찰 자동화 도구 전용.

---

## 2. 데이터 모델 — `packages/database`
`registered_devices`에 컬럼 추가:
```
collect_token_hash text null           -- sha256(hex) of collect token, 없으면 null
```
- `INDEX(collectTokenHash)` 또는 `UNIQUE(collectTokenHash)`(토큰 유일 → UNIQUE 권장, 단 여러 null 허용되므로 partial unique 불필요, 일반 unique는 null 다수 허용 = OK).
- 추론타입은 기존 RegisteredDevice 자동 반영. 마이그레이션 0010(ALTER TABLE ADD COLUMN + INDEX).

---

## 3. API 계약 — `packages/contracts`
- `deviceSecretResponseSchema`에 `collectToken: z.string()` 추가(등록/회전 응답에 raw 토큰 1회 노출). (기존 secret/deviceId/algorithm/signingRecipe 유지.)
- 수집 요청/응답은 기존 `cardSmsIngestRequestSchema`/`cardSmsIngestResponseSchema` 재사용(동일).
- 응답에 `idempotencySource`가 있다 → **§3-1**. 자동화 설정이 멱등 키를 제대로 보내고 있는지 알려주는 값이다.

---

## 3-1. 멱등 키 (`eventId`) — **자동화 템플릿의 확정 계약** (P0-9)

> ⚠️ **이 절이 수집 자동화 템플릿의 정본이다.** 로드맵 C-2(수집 마법사)가 사용자 화면에 이
> 템플릿을 그대로 인쇄한다. 여기서 계약을 확정해야 사용자가 나중에 자동화를 다시 만들지 않는다.

### 왜 보내야 하는가

`eventId`는 **문자 한 통당 하나의 고유값**이다. 이 값이 있으면 서버는 "같은 문자의 재전송"과
"우연히 같은 문자를 만든 별개 결제"를 확실히 구분한다.

없으면 서버가 추측해야 하고, **추측은 반드시 한쪽으로 틀린다.** 실제로 났던 사고가 이것이다 —
`카드 승인 5,000원 가맹점`처럼 시각이 없는 짧은 문자는 서로 다른 두 결제가 바이트 단위로 같은
문자를 만든다. 예전 규칙(`sha256(발신자+본문)`)에서는 두 번째 결제가 **영구히** 중복으로 버려졌고
원문조차 남지 않았다. 지출이 조용히 적게 잡히고 사용자는 이유를 알 방법이 없었다.

### 서버가 키를 정하는 세 갈래 (위가 정확하다)

| `idempotencySource` | 조건 | 동작 |
|---|---|---|
| `client` | `eventId`를 보냄 | 그 값이 정본. 서버가 추측하지 않는다. **목표 상태.** |
| `derived_received_at` | `eventId` 없고 `receivedAt`(또는 `X-Received-At`) 있음 | 시각을 해시에 섞는다. 그 시각의 해상도만큼 정확하다(분 단위면 같은 분은 뭉친다). |
| `derived_window` | 둘 다 없음 | 서버 수신 시각을 **3분 창**으로 묶어 추측한다. 같은 창 안의 별개 결제는 하나로 뭉친다. |

`derived_window`에서 뭉쳐 버려진 문자는 **원문이 `card_sms_ingest_suppressions`에 보관된다** —
오판으로 밝혀지면 되살릴 수 있다. 그래도 그건 사후 복구이지 정상 동작이 아니다. 키를 보내라.

`eventId`가 **선택값으로 남아 있는 이유**: 이미 배포된 자동화 설정이 이 값을 보내지 않는다.
필수로 바꾸면 그 사용자들의 수집이 즉시 끊긴다 — 카드 문자는 이 서비스의 유일한 데이터 유입
경로라 그건 위 버그보다 나쁘다. 필수화는 `scripts/report-card-sms-idempotency.mjs`로
"키 없는 수집이 0인가"를 확인한 뒤에만 한다.

### 좋은 `eventId`의 조건

1. **문자마다 다르다** — 같으면 서로 다른 결제가 하나로 합쳐진다.
2. **같은 문자를 다시 보낼 때는 같다** — 다르면 재시도가 거래를 두 배로 만든다.
3. 200자 이하 문자열.

### 요청 예시 — JSON 경로 (`POST /v1/mobile-events/card-sms-token`)

```bash
curl -s -X POST https://<host>/v1/mobile-events/card-sms-token \
  -H "Authorization: Bearer $COLLECT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "eventId": "sms-1786108440-15447200",
    "sender": "15447200",
    "content": "신한카드 승인 12,500원 일시불 07/15 19:32 스타벅스",
    "receivedAt": "2026-07-15T10:32:00.000Z"
  }'
```

```json
{
  "accepted": true,
  "eventId": "sms-1786108440-15447200",
  "processingStatus": "queued",
  "duplicate": false,
  "idempotencySource": "client"
}
```

재전송하면 `processingStatus: "duplicate"`, `duplicate: true`, `idempotencySource`는 그대로
`client`다. 응답의 `eventId`는 **흡수된 실제 이벤트의 키**라 그 값으로 상태를 조회할 수 있다.

### 요청 예시 — text 경로 (`POST /v1/mobile-events/card-sms-text`)

JSON 이스케이프가 필요 없는 경로. 메타데이터는 헤더로 보낸다.

```bash
curl -s -X POST https://<host>/v1/mobile-events/card-sms-text \
  -H "Authorization: Bearer $COLLECT_TOKEN" \
  -H 'Content-Type: text/plain; charset=utf-8' \
  -H 'X-Event-Id: sms-1786108440-15447200' \
  -H 'X-Sender: 15447200' \
  -H 'X-Received-At: 2026-07-15 19:32:00' \
  --data-binary $'신한카드 승인\n12,500원 일시불\n07/15 19:32 스타벅스'
```

`X-Received-At`은 **형식이 자유롭다**(현지 시각도 됨). 같은 문자의 재전송에 같은 문자열이
오기만 하면 시간 축으로 유효하다. `X-Event-Id`가 있으면 이 헤더는 키에 영향을 주지 않는다.

### 자동화 도구별 `eventId` 만들기

- **MacroDroid**: 매직 텍스트를 조합한다. 예 `sms-[sms_number]-<트리거 시각(초)>`.
  매직 텍스트 이름은 버전마다 다르므로 **액션 편집기의 매직 텍스트 선택기에서 고르십시오** —
  중요한 것은 이름이 아니라 위 세 조건이다. 메시지 고유 id를 제공하는 버전이면 그것이 최선이다.
  트리거 시각을 쓸 때는 **초 단위 이상**을 포함해야 한다(분 단위면 같은 분의 두 결제가 합쳐진다).
- **iOS 단축어**: "URL 콘텐츠 가져오기" 본문에 `현재 날짜`(형식: `yyyyMMdd-HHmmss`)와 발신자를
  이어 붙인 텍스트를 `eventId`로 넣는다. 단축어는 자동 재시도를 하지 않으므로 사용자가 다시
  실행하면 새 값이 되는데, 그건 "다시 보낸 것"이 아니라 "다시 만든 것"이라 의도한 동작이다.
- 어느 쪽도 어려우면 **`receivedAt`(또는 `X-Received-At`)만이라도 초 단위로 보내라.**
  `derived_received_at`으로 떨어져 3분 창 추측을 피한다.

### 설정이 맞는지 확인하는 법

응답의 `idempotencySource`가 `client`인지 본다. `derived_window`면 그 설정은 서버 추측에
의존하고 있고, 같은 문자를 만드는 별개 결제를 잃을 수 있다.

운영 쪽 확인은 `DATABASE_URL=... node scripts/report-card-sms-idempotency.mjs --days 30`.
장치별로 "아직 키를 안 보내는" 목록이 나오므로, 그 목록이 빌 때까지는 `eventId`를 필수화하면
안 된다.

---

## 4. apps/api 구현
### 4.1 device.service (Phase 2)
- `registerDevice`/`rotateSecret`: 기존 HMAC secret 발급에 더해 **collectToken 생성**(`randomBytes(32).hex`) → `sha256` 해시를 `registered_devices.collect_token_hash`에 저장(register insert 시, rotate 시 update) → 응답에 `collectToken`(raw) 포함.
  - rotate는 secret과 collectToken 둘 다 새로 발급(둘 다 회전).
- `revokeDevice`: 기존대로 status='revoked' → 토큰도 자동 무효(guard가 status 검사). (collect_token_hash null 처리는 선택.)

### 4.2 device-token.guard.ts (`DeviceTokenGuard implements CanActivate`)
- `Authorization: Bearer <token>` 파싱(없으면 401).
- `hash = sha256(token)` → `registered_devices` where `collectTokenHash=hash` AND `status='active'` 조회. 없으면 401(일반 메시지 'device authentication failed', 존재 비노출).
- `request.device = { deviceId, householdId, memberId }` 주입(HMAC guard와 동일 형태 → `@Device()` 재사용).
- best-effort `touchLastSeen`.
- 의존성: DB(@Inject DB, global). 토큰/해시 로그 금지.
- `DevicesModule`이 provider+**export**(교차모듈 `@UseGuards` 규약).

### 4.3 card-sms 컨트롤러 (Phase 3)
- 기존 `CardSmsController`(@Controller('mobile-events'))에 라우트 추가:
  - `@Public() @UseGuards(DeviceTokenGuard) @Post('card-sms-token') @HttpCode(200)` → `CardSmsIngestService.ingest(device, body)` 재사용. `@Device()` principal, DTO `createZodDto(cardSmsIngestRequestSchema)`.
- `CardSmsModule`은 이미 `DevicesModule` import 중 → `DeviceTokenGuard` 사용 가능(DevicesModule export 필요).

### 4.4 배선
- app.module 변경 없음(기존 모듈). DevicesModule exports에 DeviceTokenGuard + (guard가 DeviceService 쓰면) 이미 export됨. guard는 DB만 쓰므로 DeviceTokenGuard export만 추가.

---

## 5. Docker / 마이그레이션
- 새 npm 의존성 없음(node:crypto). schema 변경 → generate 0010(ALTER). 통합: build → generate 0010 → up --force-recreate → verify.

## 6. 검증 — `scripts/verify-card-sms-token.mjs`
1. userA 회원가입 + 가족 + 장치 등록 → 응답에 `collectToken` 존재.
2. POST /v1/mobile-events/card-sms-token (Bearer collectToken) 신한 승인 문자 → 200 `queued`.
3. 폴링(≤10s): GET /v1/card-sms-events → parsed, amount 정수.
4. 동일 eventId 재전송 → `duplicate:true`, 목록 중복 없음.
5. 잘못된 토큰 → 401. (Bearer 없음도 401.)
6. rotate-secret → 새 collectToken, 옛 토큰 401 / 새 토큰 200.
7. revoke device → 토큰 401.
통과/실패 카운트, 실패 시 exit 1. (문자 포맷은 packages/card-parsers 실제 구현에 맞춤.)

## 7. 문서 / 커밋
- ADR: `docs/adr/0016-device-token-ingest.md`(토큰 vs HMAC 트레이드오프, 단축어/MacroDroid 제약, eventId 멱등 근거).
- `docs/api/card-sms.md`: 토큰 수집 섹션 추가(단축어/MacroDroid 설정 예 포함).
- 커밋: `feat(db)` collect token 컬럼 → `feat(contracts)` → `feat(device)` 토큰 발급+guard → `feat(card-sms)` 토큰 수집 라우트 → `test`/`docs`.

## 8. 파티션 맵
- **P1 db+contracts**: `packages/database/src/schema.ts`(collect_token_hash + INDEX/UNIQUE), `packages/contracts/src/device.ts`(deviceSecretResponse에 collectToken).
- **P2 api**: `apps/api/src/devices/device.service.ts`(register/rotate collectToken 발급), `apps/api/src/devices/device-token.guard.ts`(신규), `apps/api/src/devices/devices.module.ts`(DeviceTokenGuard export), `apps/api/src/card-sms/card-sms.controller.ts`(card-sms-token 라우트).
- **P3 verify+docs**: `scripts/verify-card-sms-token.mjs`, ADR 0016, `docs/api/card-sms.md` 갱신.

주의: 각 에이전트는 본 문서 + phase2/3 스펙 + 기존 소스(device.service/device-hmac.guard/decorators, card-sms-ingest.service/card-sms.controller, devices.module, schema registered_devices/device_credentials, contracts device.ts)를 Read. DeviceHmacGuard 패턴을 그대로 따라 DeviceTokenGuard 작성.
