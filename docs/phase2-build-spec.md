# Phase 2 Build Spec — 스마트폰 장치 & HMAC 인증

> Phase 2 구현의 **단일 진실 소스(SSOT)**. Phase 0/1 규약을 그대로 따른다(패키지 `type:module` 금지, 공용 dev 이미지, 소스 바인드마운트, KRW 정수, Asia/Seoul, 로그 Secret 금지, 새 env는 `.env`도 갱신).

---

## 0. 목표 & 완료 조건 (PRD §31 Phase 2)

구현 범위: 스마트폰 등록 / 장치별 Secret 발급 / HMAC 인증 / Nonce 검증 / Secret 회전 / 장치 비활성화.

완료 조건(실측, `scripts/verify-phase2.mjs`):
1. 정상 서명 요청 성공(200).
2. 잘못된 서명 요청 실패(401).
3. 만료 Timestamp 실패(401).
4. Nonce 재사용 실패(401).
5. 폐기 장치 요청 실패(401).
6. Secret 회전 후 옛 Secret 서명 실패 / 새 Secret 성공.
7. 남의 장치 관리(rotate/delete) 차단(403).

**이번 Phase에서 구현하지 않음**: 카드 문자 원문 저장/파싱/거래 생성(Phase 3). Phase 2는 장치 인증 인프라 + 이를 검증할 `POST /v1/mobile-events/ping`(HMAC 가드 통과 확인)까지만. Phase 3의 `card-sms` 엔드포인트는 이 가드를 재사용한다.

---

## 1. 핵심 설계 결정 (근거)

### 1.1 장치 Secret 저장 = AES-256-GCM 암호화 (해시 아님)
HMAC-SHA256 검증은 서버가 **동일 대칭키 원문**으로 서명을 재계산해야 하므로 sha256 해시 저장은 불가(단방향). PRD §9 "비밀키를 원문 그대로 저장하지 않는다"는 **at-rest 암호화**로 충족한다.
- Secret 32바이트 랜덤 생성 → raw는 등록/회전 시 **1회만** 응답 → DB엔 `AES-256-GCM(secret, encKey)`의 `{ciphertext, iv, authTag}` 저장.
- 암호화 키(`DEVICE_SECRET_ENC_KEY`)는 env로 주입(32바이트 hex=64자). `keyVersion` 컬럼으로 향후 키 회전 대비.
- 로그·에러·응답에 secret 원문/암호문/키 절대 미출력.

### 1.2 Fastify rawBody
서명 대상이 `timestamp + "." + nonce + "." + rawRequestBody`이므로 파싱 전 **원본 바이트**가 필요.
- `NestFactory.create(AppModule, new FastifyAdapter(), { rawBody: true })` → `request.rawBody: Buffer` 사용.
- 본문 크기 제한: `FastifyAdapter({ bodyLimit })`(기본 16KB). 초과 시 Fastify가 413.

### 1.3 가드 조합
mobile-events 라우트는 `@Public()`(전역 AccessTokenGuard 우회) + `@UseGuards(DeviceHmacGuard)`. 전역 가드가 먼저 실행되어 public 통과 → 컨트롤러 가드가 HMAC 검증. 장치 관리 라우트(`/v1/devices/*`)는 일반 사용자 인증(AccessTokenGuard) 사용.

---

## 2. 데이터 모델 — `packages/database` (schema.ts 확장)

### pgEnum
- `devicePlatform` = `['ios','android','other']`
- `deviceStatus` = `['active','revoked']`
- `deviceCredentialStatus` = `['active','revoked']`

### 테이블
```
registered_devices
  id uuid pk
  householdId uuid not null -> households.id
  memberId uuid not null -> household_members.id
  name text not null
  platform devicePlatform not null
  status deviceStatus not null default 'active'
  lastSeenAt timestamptz null
  createdBy uuid not null -> users.id
  createdAt / updatedAt
  revokedAt timestamptz null
  INDEX(householdId), INDEX(memberId)

device_credentials
  id uuid pk
  deviceId uuid not null -> registered_devices.id
  secretCiphertext text not null      -- base64
  secretIv text not null              -- base64 (12 bytes GCM nonce)
  secretAuthTag text not null         -- base64 (16 bytes GCM tag)
  keyVersion integer not null default 1
  status deviceCredentialStatus not null default 'active'
  createdAt
  revokedAt timestamptz null
  INDEX(deviceId)
  -- 한 장치당 active credential 1개(앱 로직으로 강제: 회전 시 기존 active→revoked)

device_nonces
  id uuid pk
  deviceId uuid not null -> registered_devices.id
  nonce text not null
  seenAt timestamptz not null default now
  expiresAt timestamptz not null
  UNIQUE(deviceId, nonce)             -- 재사용 시 insert 충돌 → replay 차단
  INDEX(expiresAt)                    -- 만료 정리용
```

추론 타입 export(RegisteredDevice/NewRegisteredDevice, DeviceCredential/..., DeviceNonce/...). 마이그레이션 SQL은 통합 단계에서 `drizzle-kit generate`로 생성(0001_*).

---

## 3. API 계약 — `packages/contracts` (`src/device.ts` + 배럴)

- `devicePlatformSchema` = `z.enum(['ios','android','other'])`
- `deviceRegisterRequestSchema` = `{ householdId: z.string().uuid(), name: z.string().min(1).max(100), platform: devicePlatformSchema }`
- `deviceSummarySchema` = `{ id, householdId, memberId, name, platform, status: z.enum(['active','revoked']), lastSeenAt: string.nullable(), createdAt: string }`
- `deviceSecretResponseSchema` = `{ device: deviceSummary, deviceId: string, secret: string, algorithm: z.literal('HMAC-SHA256'), signingRecipe: string }` — secret은 1회 노출. `signingRecipe` = `"HMAC-SHA256(secret, `${X-Timestamp}.${X-Nonce}.${rawBody}`)"` 안내 문자열.
- `devicePingResponseSchema` = `{ authenticated: z.literal(true), deviceId: string, householdId: string, receivedAt: string }`
- 추론 타입 export(DeviceRegisterRequest, DeviceSummary, DeviceSecretResponse, DevicePingResponse, DevicePlatform).

---

## 4. apps/api 구현 — `apps/api/src/devices/`

### 4.1 config 확장 (packages/config)
`configSchema`에 `device` 그룹 추가:
```
device: {
  secretEncKey: z.string().regex(/^[0-9a-fA-F]{64}$/),   // 32바이트 hex
  hmacTimestampToleranceSec: z.coerce.number().int().positive().default(300),
  nonceTtlSec: z.coerce.number().int().positive().default(600),
  maxBodyBytes: z.coerce.number().int().positive().default(16384),
}
```
`validateEnv` 매핑: `DEVICE_SECRET_ENC_KEY / HMAC_TIMESTAMP_TOLERANCE_SEC / DEVICE_NONCE_TTL_SEC / MOBILE_MAX_BODY_BYTES`.
`.env.example`(+`.env`): `DEVICE_SECRET_ENC_KEY`(64 hex 더미), 나머지 기본값 명시.

### 4.2 device-secret.cipher.ts
`DeviceSecretCipher`(Injectable). 생성자에서 `config.device.secretEncKey`(hex)→Buffer(32) 검증.
- `encrypt(plaintext: Buffer|string): { ciphertext, iv, authTag, keyVersion }` — `createCipheriv('aes-256-gcm', key, randomBytes(12))`, base64 출력.
- `decrypt(input: { ciphertext, iv, authTag }): Buffer` — `createDecipheriv`, authTag 검증. 실패 시 throw(에러 메시지에 키/평문 미포함).
- `KEY_VERSION = 1`.

### 4.3 device.service.ts (Db 주입, DeviceSecretCipher/TokenService 주입, household requireMembership 재사용)
권한: 장치는 `householdId`+`memberId` 소유. 관리 권한 = **장치 소유자 본인** 또는 **해당 household owner**.
- 헬퍼 `resolveMembership(householdId, userId)`: household_members active 조회(없으면 ForbiddenException). member.id/role 반환.
- `registerDevice(userId, {householdId, name, platform})`: resolveMembership → registered_devices insert(memberId=본인 membership.id, createdBy=userId, status active) + secret 생성/암호화 → device_credentials insert(active). raw secret 반환(1회).
- `listDevices(userId, householdId)`: resolveMembership → 해당 household 장치 목록(소유자는 자기 것, owner/admin는 전체? Phase 2는 단순히 household 전체 조회 허용, requireMembership any). deviceSummary[] 반환.
- `rotateSecret(userId, deviceId)`: 장치 조회 → 권한(소유자 or owner) 검사 → 기존 active credential revoked + 새 credential active. raw secret 반환(1회).
- `revokeDevice(userId, deviceId)`: 권한 검사 → device status='revoked', revokedAt, 모든 credential revoked. `{revoked:true}`.
- 권한 실패는 ForbiddenException, 미존재는 NotFoundException(단, 다른 household 장치는 존재 비노출 위해 requireMembership 먼저).
- `loadActiveCredential(deviceId)` 및 `touchLastSeen(deviceId)`은 HMAC 가드가 사용(서비스 메서드로 노출).

### 4.4 device-hmac.guard.ts (`DeviceHmacGuard implements CanActivate`)
1. 헤더 파싱: `x-device-id, x-timestamp, x-nonce, x-signature`. 하나라도 없으면 `UnauthorizedException`.
2. Content-Type이 `application/json` 아니면 401(또는 415). 
3. 장치 조회(`registered_devices` by id) → 없거나 status!=='active' → 401(존재 비노출, 일반 메시지).
4. active credential 조회 → 없으면 401. `DeviceSecretCipher.decrypt`로 secret 복원.
5. Timestamp(정수 epoch seconds 또는 ISO — **epoch seconds 문자열**로 규정) 파싱. `|now - ts| > config.device.hmacTimestampToleranceSec` → 401.
6. `rawBody = request.rawBody ?? Buffer.alloc(0)`. `expected = HMAC-SHA256(secret, `${timestamp}.${nonce}.${rawBodyUtf8}`)` hex. `crypto.timingSafeEqual`로 서명 비교(길이 다르면 401). 불일치 401.
7. Nonce 저장: `device_nonces` insert(deviceId, nonce, expiresAt = ts+nonceTtlSec). UNIQUE(deviceId,nonce) 충돌(23505) → 401(replay).
8. `touchLastSeen(deviceId)`(await, best-effort).
9. `request.device = { deviceId, householdId, memberId }` 주입. true.
모든 실패 경로는 secret/서명/키 미로그. 일반 401 메시지("device authentication failed").

### 4.5 컨트롤러
- `device.controller.ts` (`@Controller('devices')`, 일반 인증):
  - `POST /v1/devices/register` → registerDevice. 201, deviceSecretResponse.
  - `GET /v1/devices?householdId=...` → listDevices. 200.
  - `POST /v1/devices/:id/rotate-secret` → rotateSecret. 200, deviceSecretResponse.
  - `DELETE /v1/devices/:id` → revokeDevice. 200.
  - DTO createZodDto(deviceRegisterRequestSchema). householdId 쿼리는 zod 파싱.
  - `CurrentUser`로 actorUserId.
- `mobile-events.controller.ts` (`@Controller('mobile-events')`):
  - `@Public() @UseGuards(DeviceHmacGuard) @Post('ping')` → `{ authenticated:true, deviceId, householdId, receivedAt }`. request.device 사용(커스텀 `@Device()` param decorator 또는 @Req).
- `devices.module.ts`: imports AuthModule(TokenService 필요시)+아무것도 아니어도 됨(DB global). providers DeviceSecretCipher, DeviceService, DeviceHmacGuard. controllers DeviceController, MobileEventsController. exports DeviceService, DeviceHmacGuard(Phase 3 재사용).
- `decorators/device.decorator.ts`: `Device()` param decorator → request.device.

### 4.6 배선 (app.module/main)
- `main.ts`: `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: <maxBodyBytes> }), { rawBody: true })`. bodyLimit은 config 로딩 전이므로 상수 16384 사용(또는 env 직접 읽기). rawBody:true 필수.
- `app.module.ts`: `DevicesModule` import 추가.

---

## 5. Docker / 마이그레이션
- 새 테이블 → 통합 단계에서 `drizzle-kit generate`로 `0001_*.sql` 생성(바인드마운트된 drizzle 폴더). `migrate` 서비스가 자동 적용. compose 변경 없음(Phase 1에서 배선 완료).
- 새 env(`DEVICE_SECRET_ENC_KEY` 등)를 `.env`에 반드시 추가.

통합 절차:
1. lockfile 변화 없음(새 npm 의존성 없음 — 모두 Node 내장 crypto). 단 schema 변경으로 재빌드 필요.
2. `docker compose build` → `drizzle-kit generate`(0001) → `.env` 갱신 → `docker compose up -d --force-recreate`.
3. `node scripts/verify-phase2.mjs`.

---

## 6. 검증 — `scripts/verify-phase2.mjs`
Node 내장 `crypto`로 클라이언트 HMAC 서명 생성. 시나리오:
1. userA 회원가입 + 가족 생성(access token).
2. 장치 등록 → raw secret 수신, deviceId 확보.
3. **정상 서명 ping → 200** authenticated, deviceId 일치.
4. **잘못된 서명 → 401**.
5. **만료 timestamp(now-600s) → 401**.
6. **nonce 재사용(동일 nonce 2회) → 2번째 401**.
7. **secret 회전** → 옛 secret 서명 401, 새 secret 서명 200.
8. **폐기 장치**: DELETE device → 이후 정상 서명도 401.
9. **권한**: userB 회원가입 → userB가 userA 장치 rotate/delete → 403.
10. (선택) 잘못된 Content-Type / body 초과.
서명 헬퍼: `sign(secret, tsSec, nonce, bodyString) = hmacSHA256Hex(secret, `${tsSec}.${nonce}.${bodyString}`)`. 헤더 `X-Device-Id/X-Timestamp/X-Nonce/X-Signature`, body는 정확히 서명한 문자열과 동일 바이트로 전송(JSON.stringify 후 그 문자열을 fetch body로). 통과/실패 카운트 요약, 실패 시 exit 1.

---

## 7. 문서 / 커밋
- ADR: `docs/adr/0007-device-hmac-authentication.md`(HMAC 서명 방식 + secret at-rest 암호화 근거, PRD §37 형식).
- `docs/api/devices.md`: 장치 등록/회전/폐기 + mobile-events 서명 프로토콜 예시(헤더/서명레시피/샘플).
- 커밋(PRD §38): `feat(db)` device 스키마/마이그레이션 → `feat(contracts)` → `chore(config)` device 그룹+.env → `feat(device)` cipher/service/guard/controllers → `chore(api)` main rawBody+app.module → `test`/`docs`.

## 8. 파티션 맵
- **P1 database**: `packages/database/src/schema.ts`(device 3테이블/enum/추론타입 추가), index 재export 확인. (마이그레이션 SQL은 통합에서 생성)
- **P2 contracts**: `packages/contracts/src/device.ts` + index 배럴.
- **P3 api-devices**: `apps/api/src/devices/**`(device-secret.cipher, device.service, device-hmac.guard, device.controller, mobile-events.controller, decorators/device.decorator, devices.module).
- **P4 wiring**: `packages/config/src/config.ts`(device 그룹), `.env.example`(device env), `apps/api/src/main.ts`(rawBody+bodyLimit), `apps/api/src/app.module.ts`(DevicesModule import).
- **P5 verify+docs**: `scripts/verify-phase2.mjs`, `docs/adr/0007-*.md`, `docs/api/devices.md`.

각 에이전트는 본 스펙 + phase1/phase0 스펙을 Read하고 자기 파티션만 담당. P4만 config/main/app.module/.env.example 수정.
