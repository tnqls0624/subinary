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
