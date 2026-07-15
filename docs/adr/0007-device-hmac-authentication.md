# ADR-0007: 스마트폰 장치 HMAC-SHA256 인증과 Secret at-rest 암호화

## 제목

장치별 대칭키(HMAC-SHA256) 서명 인증 + Timestamp/Nonce replay 방어 + 장치 Secret의
AES-256-GCM at-rest 암호화(해시 저장 불가) 채택

## 상태

승인됨 (Accepted) — 2026-07-15

## 배경

Phase 2는 사용자의 스마트폰을 가족 그룹에 등록하고, 그 장치가 서버에 보내는 요청(Phase 3의
카드 문자 수집 등)을 인증하는 인프라를 도입한다(PRD §31 Phase 2). 장치는 사람이 매번
로그인하지 않고 백그라운드에서 이벤트를 전송하므로, **사용자 세션(JWT/refresh)과 분리된
장치 자격증명**이 필요하다.

요구 불변식:

- 장치는 **가족·구성원 소유**다. 등록/회전/폐기 같은 관리는 장치 소유자 본인 또는 해당
  가족 owner만 할 수 있어야 한다(PRD §7.2, §26).
- 전송 중 위·변조와 **재전송(replay) 공격**을 막아야 한다. 유출된 정상 요청을 그대로 다시
  보내는 것도 차단해야 한다.
- 자격증명(비밀키)은 **원문 그대로 저장하지 않는다**(PRD §9). 유출된 요청·로그·에러·응답
  어디에도 비밀키/서명/키가 노출되면 안 된다.
- 새 npm 의존성을 추가하지 않는다 — Node 내장 `node:crypto`만 사용한다.

설계 포인트는 두 가지다. (1) 어떤 서명 방식을 쓸 것인가, (2) 서버가 검증에 필요한 비밀키를
어떻게 저장할 것인가.

## 결정

### 1. HMAC-SHA256 대칭키 서명

- 장치 등록/회전 시 서버가 **32바이트 랜덤 secret**을 생성한다. raw secret은 **응답에서
  1회만** 노출되고(등록/회전 응답의 `secret` 필드), 이후 다시 조회할 수 없다.
- 클라이언트는 요청마다 다음 payload에 대한 HMAC-SHA256 서명을 계산해 헤더로 보낸다:

  ```
  payload   = `${X-Timestamp}.${X-Nonce}.${rawBody}`     (원본 바이트, 파싱 전)
  signature = HMAC-SHA256(secret, payload) 의 hex digest
  헤더       = X-Device-Id, X-Timestamp, X-Nonce, X-Signature, Content-Type: application/json
  ```

- 서버는 **원본 바이트**(`rawBody`)가 있어야 동일 서명을 재계산할 수 있으므로 Fastify를
  `rawBody: true`로 구성하고, body 파싱 전의 `request.rawBody`를 서명 대상으로 쓴다.
- 서명 비교는 `crypto.timingSafeEqual`로 상수시간 비교한다(길이가 다르면 즉시 실패). 서명
  문자열 비교의 타이밍 사이드채널을 제거한다.

### 2. Timestamp + Nonce 기반 replay 방어

- **Timestamp**: `X-Timestamp`는 정수 epoch seconds 문자열이다. `|now - ts|`가 허용오차
  (`HMAC_TIMESTAMP_TOLERANCE_SEC`, 기본 300초)를 넘으면 거부한다. 오래된(또는 미래의)
  캡처 요청의 재사용 창을 좁힌다.
- **Nonce**: `X-Nonce`는 요청마다 고유해야 한다. 서버는 `device_nonces(deviceId, nonce)`에
  `UNIQUE` 제약으로 저장하며, 재사용 시 insert 충돌(23505)로 거부한다. 만료는
  `expiresAt = ts + DEVICE_NONCE_TTL_SEC`(기본 600초)로 두어 인덱스 기반 정리를 가능케 한다.
- 두 방어를 합치면, 유출된 정상 요청은 (a) 허용오차 내에서만 유효하고 (b) 그 창 안에서도
  nonce가 이미 소비되어 재사용이 불가능하다.

### 3. Secret at-rest = AES-256-GCM 암호화 (해시 아님)

- HMAC 검증은 서버가 **동일한 대칭키 원문**으로 서명을 재계산해야 하므로, 단방향 해시
  (`sha256(secret)`) 저장은 **원천적으로 불가능**하다(원문을 복원할 수 없어 재계산 불가).
- 따라서 PRD §9의 "비밀키를 원문 그대로 저장하지 않는다"는 **at-rest 암호화**로 충족한다.
  secret은 `AES-256-GCM(secret, encKey)`로 암호화해 `{ ciphertext, iv, authTag }`(모두
  base64)만 DB(`device_credentials`)에 저장한다.
  - 암호화 키 `DEVICE_SECRET_ENC_KEY`는 32바이트(hex 64자)로 env 주입한다(DB와 분리).
  - IV는 매 암호화마다 `randomBytes(12)`로 새로 생성하고, GCM `authTag`(16바이트)로
    무결성을 보증한다(복호화 시 태그 검증 실패는 예외 → 변조 감지).
  - `keyVersion` 컬럼으로 향후 암호화 키 회전에 대비한다(현재 `KEY_VERSION = 1`).
- 이는 이 데이터베이스(refresh 토큰·초대 토큰의 `sha256` **해시** 저장)와 **의도적으로
  다르다**: 토큰은 서버가 원문을 재계산할 필요가 없어 해시가 최선이지만, HMAC secret은
  재계산이 본질이라 **복호 가능한 암호화**가 유일한 선택지다.

### 4. 자격증명 상태 기계와 서비스 계층 인가

- 장치 credential은 `active | revoked`. **한 장치당 active credential 1개**를 앱 로직으로
  보장한다(회전 시 기존 active를 revoked로 내리고 새 active를 발급). 회전 후 옛 secret으로 만든
  서명은 즉시 실패한다.
- 장치 자체도 `active | revoked`. 폐기(`DELETE /v1/devices/:id`)하면 장치 status와 모든
  credential을 revoked로 내려 이후 어떤 서명도 통과하지 못한다.
- 인가는 **서비스 계층에서 `actorUserId` 기준으로 강제**한다(PRD §26, ADR-0006과 동일 원칙).
  rotate/delete는 장치를 조회해 소유 가족을 찾고, 호출자가 장치 소유자 본인 또는 그 가족
  owner인지 검사한다. 아니면 `ForbiddenException(403)`.
- mobile-events 라우트는 `@Public()`(전역 AccessTokenGuard 우회) + `@UseGuards(
  DeviceHmacGuard)` 조합으로 보호한다. 장치 관리 라우트(`/v1/devices/*`)는 일반 사용자
  인증(AccessTokenGuard)을 쓴다.

### 5. 정보 비노출

- HMAC 검증 실패(헤더 누락, 장치 미존재/비활성, credential 없음, timestamp 만료, 서명
  불일치, nonce 재사용)는 **모두 동일한 일반 401**("device authentication failed")로
  응답한다 — 실패 원인·장치 존재 여부를 노출하지 않는다.
- 로그·에러·응답 어디에도 secret 원문/암호문/암호화 키/서명/해시를 출력하지 않는다.

## 검토한 대안

1. **비대칭 서명(Ed25519/ECDSA)**: 서버가 공개키만 보관하면 되어 secret 저장 문제 자체가
   사라지고 유출 위험이 낮다. 그러나 장치가 개인키를 안전 저장·서명해야 해 클라이언트 복잡도가
   커지고, Phase 2의 스마트폰 앱(단순 이벤트 전송) 요구에 비해 과하다. 서버가 대칭키를 쥐는
   위험은 **at-rest 암호화 + 키 분리(env)**로 관리 가능하다고 판단했다. 장치 신뢰모델이
   커지면(3자 검증 등) 재검토한다.
2. **secret을 sha256 해시로 저장**: 토큰과 대칭성이 있어 매력적이나, HMAC 재계산에 원문이
   필요해 **기술적으로 불가능**하다. 채택 불가.
3. **mTLS(클라이언트 인증서)**: 전송계층에서 강력한 상호 인증을 제공하나, 모바일 인증서
   발급·갱신·핀닝 운영 비용이 크고 리버스 프록시/로드밸런서 종단 구성과 얽혀 Phase 2 범위에
   과하다.
4. **장치에 장수명 JWT/API 키 부여(서명 없음, Bearer만)**: 구현이 가장 단순하나, 토큰이
   유출되면 그대로 재사용 가능하고 body 무결성·replay 방어가 없다. HMAC 서명은 요청마다
   무결성과 (nonce로) 재사용 차단을 함께 제공한다.
5. **replay 방어를 timestamp만으로**: 구현이 간단하나 허용오차 창 안의 재전송을 막지 못한다.
   nonce UNIQUE를 더해 창 안에서도 1회성을 강제한다.
6. **nonce를 Redis/인메모리에 보관**: TTL 만료가 편하나 별도 저장소 일관성·유실 시 replay
   구멍이 생긴다. Phase 2는 트랜잭션 원자성이 있는 Postgres `UNIQUE` 제약을 1차로 택하고,
   규모가 커지면 캐시 계층을 재검토한다.

## 장점

- 요청마다 body·헤더 무결성을 검증하고, timestamp+nonce로 replay를 구조적으로 차단한다.
- secret은 1회 노출·at-rest 암호화·키 분리로 저장·유출 위험을 낮추고, GCM authTag로 변조를
  탐지한다. `keyVersion`으로 키 회전 여지를 남긴다.
- 상태 기계(장치/credential active↔revoked)로 회전·폐기가 즉시 반영된다(옛 secret 무효화).
- 서비스 계층 인가로 어떤 진입점에서도 장치 소유 경계가 강제된다(ADR-0006과 일관).
- 새 의존성 없이 Node 내장 `node:crypto`만 사용한다.
- 일반 401·secret 미로그로 정보 노출을 최소화한다.

## 단점

- 서버가 대칭 secret을 복호 가능한 형태로 보관한다 — `DEVICE_SECRET_ENC_KEY`가 DB와 함께
  유출되면 secret이 복원된다(비대칭 서명 대비 취약점). 키 분리·회전으로 완화한다.
- 클라이언트가 timestamp·nonce·정확한 rawBody 바이트로 서명해야 해 구현 규약이 엄격하다
  (body 직렬화가 1바이트라도 달라지면 서명 불일치).
- nonce를 DB에 영속하므로 트래픽 증가 시 `device_nonces`가 커진다 — `expiresAt` 인덱스
  기반 정리가 필요하다.
- timestamp 허용오차는 장치·서버 시계 동기화에 의존한다(오차가 크면 정상 요청도 거부).

## 변경조건

- 장치 신뢰모델이 강화(3자 검증, 하드웨어 키스토어 활용)되면 **비대칭 서명(Ed25519)**으로
  전환해 서버의 secret 보관 자체를 제거하는 것을 재검토한다.
- nonce 저장이 병목이 되면 만료 정리 배치 또는 Redis 등 TTL 저장소로 이관을 검토한다.
- 암호화 키 유출/정기 교체 요구가 생기면 `keyVersion` 기반 키 회전 절차(재암호화 마이그레이션)를
  도입한다.
- 장치 수·요청 빈도가 커지면 timestamp 허용오차·nonce TTL을 재튜닝하고 rate limit을 추가한다.
- Phase 3(카드 문자 수집)에서 동일 `DeviceHmacGuard`를 재사용하며, 페이로드 스키마·크기 제한
  요구가 바뀌면 `MOBILE_MAX_BODY_BYTES`와 body 파싱 정책을 재점검한다.
