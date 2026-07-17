# ADR-0016: 카드 문자 토큰 수집 경로(단축어/MacroDroid용 Bearer 토큰)

## 제목

단축어(iOS)/MacroDroid(Android) 자동화를 위한 장치별 수집 토큰(Bearer) 기반 카드 문자
수집 경로 추가 — HMAC-SHA256 서명 경로(ADR-0007)와 병행, 토큰은 `sha256` 해시로만 저장,
`eventId` UNIQUE 멱등으로 replay 방어

## 상태

승인됨 (Accepted) — 2026-07-17

## 배경

Phase 3은 등록된 장치가 카드 문자를 서버로 수집하는 경로로 HMAC-SHA256 서명
(`POST /v1/mobile-events/card-sms`, ADR-0007)을 제공한다. 서명은 요청마다
`HMAC-SHA256(secret, ${X-Timestamp}.${X-Nonce}.${rawBody})` 를 계산하고, 서명한 바이트와
전송 본문이 1바이트라도 달라지면 실패한다.

문제는 실사용자 대부분이 전용 앱을 설치하지 않고 **iOS 단축어**나 **MacroDroid** 같은
저마찰 자동화 도구로 "카드 문자 수신 → HTTP POST"를 구성한다는 점이다. 이 도구들은:

- 요청 본문에 대한 **HMAC-SHA256 계산이 사실상 불가능**하거나 매우 번거롭다. 단축어는
  임의 바이트열의 HMAC 을 계산하는 1급 액션이 없고, MacroDroid 역시 본문·타임스탬프·nonce
  를 조합해 서명하는 흐름을 안정적으로 만들기 어렵다.
- 반면 **고정 헤더 + JSON 본문 POST**는 두 도구 모두 GUI 만으로 손쉽게 구성한다.

즉, HMAC 경로는 보안은 강하지만 대중 자동화 도구의 능력을 초과한다. Phase 2/3 확장으로,
서명 없이 **장치별 Bearer 토큰**만으로 카드 문자를 수집하는 **저마찰 경로**가 필요하다
(addendum-card-sms-token-ingest.md §0). 단, PRD §9(자격증명 원문 미저장)·§14(멱등)·§26
(정보 비노출) 불변식은 그대로 지켜야 한다.

핵심 설계 질문은 세 가지다. (1) 서명을 포기하고 Bearer 토큰을 쓸 때 어떤 위협이 남는가,
(2) 토큰을 어떻게 저장할 것인가, (3) 서명/nonce 없이 replay 를 어떻게 막을 것인가.

## 결정

### 1. 장치별 수집 토큰(Bearer) 경로를 HMAC 경로와 **병행** 추가

- 새 엔드포인트 `POST /v1/mobile-events/card-sms-token` 을 추가한다. 인증은
  `Authorization: Bearer <collectToken>` 하나로 끝나고, 본문은 기존
  `cardSmsIngestRequestSchema`(`{ eventId, sender, content, receivedAt }`)를 그대로 쓴다.
  Content-Type 은 `application/json`.
- 기존 HMAC 경로(`POST /v1/mobile-events/card-sms`)는 **그대로 유지**한다. 서명이 가능한
  장치/클라이언트는 강한 경로를 계속 쓰고, 저마찰 자동화 도구만 토큰 경로를 쓴다.
- 수집 이후의 처리(원문 이중보존·비동기 파싱·조회)는 완전히 동일하다 —
  `CardSmsIngestService.ingest(device, body)` 를 **두 경로가 공유**한다.

### 2. 토큰 발급·저장·노출: `randomBytes(32)` → `sha256` 해시만 저장

- 수집 토큰은 등록/회전 시 서버가 `randomBytes(32).toString('hex')`(256비트)로 생성한다.
- **raw 토큰은 등록/회전 응답의 `collectToken` 필드에 1회만** 노출되고, 이후 다시 조회할 수
  없다(HMAC secret 의 1회 노출 규약과 동일).
- DB(`registered_devices.collect_token_hash`)에는 **`sha256(token)` 해시만** 저장한다
  (원문·복호 가능 형태 미저장). 인증 시 서버는 요청 토큰을 `sha256` 해싱해 해시를 매칭한다.
- 이는 refresh/초대 토큰(ADR-0005/0006)의 해시 저장 방식과 **일관**된다. HMAC secret 이
  재계산 때문에 **복호 가능한 AES-GCM 암호화**를 써야 했던 것(ADR-0007 §3)과 달리, Bearer
  토큰은 서버가 원문을 재계산할 필요가 없어 **단방향 해시가 최선**이다.
- rotate-secret 은 HMAC secret 과 collectToken 을 **둘 다** 새로 발급한다(둘 다 회전).
  revoke 는 장치 status 를 `revoked` 로 내려 토큰을 자동 무효화한다(아래 §4).

### 3. replay 방어: 서명/nonce 대신 `eventId` UNIQUE 멱등

- 토큰 경로에는 서명·nonce·timestamp 가 **없다** → per-request replay 를 nonce 로 막지
  않는다(HMAC 경로 대비 명시적 완화 지점, PRD §26).
- 대신 이미 존재하는 **`UNIQUE(device_id, event_id)`** 제약(ADR-0008 §멱등)에 의존한다.
  동일 문자를 재전송·재생하면 `CardSmsIngestService.ingest` 가 중복 저장·재파싱 없이
  `duplicate:true` 성공 응답만 반환한다. 즉 **유출된 정상 요청을 그대로 다시 보내는 것은
  무해**하다(같은 eventId → 아무 것도 새로 생기지 않음).
- 남는 위협은 **위조 문자 주입**이다(공격자가 토큰을 알면 임의 eventId 로 가짜 카드 문자를
  넣을 수 있음). 이는 전적으로 **토큰 비밀성**에 의존한다 → HTTPS 필수, 유출 시
  `rotate-secret`(즉시 새 토큰)·`revoke`(즉시 무효화)로 대응한다.

### 4. 인증 가드와 상태 검사(DeviceTokenGuard)

- `DeviceTokenGuard implements CanActivate` 는 `Authorization: Bearer <token>` 를 파싱하고
  (없으면 401), `sha256(token)` 으로 `registered_devices` 에서 `collect_token_hash` 매칭 +
  `status='active'` 장치를 조회한다. 없으면 401.
- 성공 시 `request.device = { deviceId, householdId, memberId }` 를 주입해 HMAC 경로와 동일
  형태의 principal 을 만든다 → `@Device()` 데코레이터를 **그대로 재사용**한다.
- 폐기 장치(`status='revoked'`)는 매칭에서 제외되므로 revoke 즉시 토큰이 무효가 된다(별도
  토큰 삭제 없이 상태로 강제). best-effort `touchLastSeen` 은 인증을 실패시키지 않는다.
- 교차모듈 `@UseGuards` 규약(ADR-0007 §4)에 따라 `DevicesModule` 이 `DeviceTokenGuard` 를
  **export** 하고, `CardSmsModule`(이미 `DevicesModule` import)이 소비한다.

### 5. 정보 비노출

- 토큰 인증 실패(Bearer 누락, 해시 미매칭, 폐기 장치)는 **모두 동일한 일반 401**로 응답한다
  — 실패 원인·장치 존재 여부를 노출하지 않는다(HMAC 경로와 동일 정책).
- 로그·에러·응답 어디에도 collect 토큰 원문/해시, HMAC secret, 문자 원문 전체를 출력하지
  않는다(운영 로그는 eventId/contentHash/상태만, PRD §11).

## 검토한 대안

1. **HMAC 경로만 유지(토큰 경로 없음)**: 보안 일관성은 최고지만, 단축어/MacroDroid 로는
   서명을 만들 수 없어 대중 사용자가 카드 문자 자동 수집을 사실상 못 쓴다. Phase 3 의 실사용
   가치(가족 카드 문자 자동 수집)를 크게 훼손해 기각.
2. **토큰 경로가 HMAC 경로를 대체**: 구현·문서가 단순해지나, 서명 가능한 클라이언트의 강한
   보안(요청별 무결성·nonce replay 차단)을 스스로 낮춘다. 두 경로를 **병행**해 각 클라이언트가
   능력에 맞는 경로를 쓰게 한다.
3. **토큰을 원문 그대로 저장**: 조회·디버깅이 쉽지만 PRD §9 위반이고 DB 유출 시 즉시
   악용된다. `sha256` 해시 저장으로 유출 표면을 제거한다.
4. **토큰을 AES-GCM 암호화 저장**(HMAC secret 방식 재사용): 가능은 하나 불필요하다 — 토큰은
   재계산이 필요 없어 복호 가능 저장의 이점이 없고, 오히려 복호 가능한 원문을 보관하는 위험만
   커진다. 단방향 해시가 더 안전하다.
5. **토큰 경로에도 nonce/timestamp replay 방어 추가**: 방어는 강해지나 단축어/MacroDroid 가
   nonce 생성·헤더 조합을 안정적으로 못 해 저마찰이라는 존재 이유를 잃는다. `eventId` 멱등이
   재전송을 무해화하므로, per-request replay 방어를 포기하는 트레이드오프를 명시적으로 수용한다.
6. **장치에 장수명 JWT 부여**: 토큰 검증에 서버 상태 조회가 필요 없어 편하나, 즉시 폐기
   (revoke)가 어렵고(블랙리스트 필요) 회전 정책이 복잡하다. DB 해시 매칭 + 장치 status 검사는
   rotate/revoke 를 즉시 반영한다.

## 장점

- 단축어/MacroDroid 의 "고정 헤더 + JSON POST"만으로 카드 문자 자동 수집이 가능해진다
  (대중 사용자 접근성 대폭 향상).
- 토큰은 1회 노출·`sha256` 해시 저장으로 유출 표면이 작고, DB 가 유출돼도 원문이 복원되지
  않는다(HMAC secret 의 복호 가능 저장보다 이 점은 오히려 강하다).
- HMAC 경로와 처리 파이프라인(`CardSmsIngestService.ingest`, 원문 이중보존, 비동기 파싱,
  조회)을 **완전히 공유**해 코드 중복이 없다.
- `eventId` UNIQUE 멱등으로 재전송/재생이 무해하고, rotate/revoke 로 유출 대응이 즉시 반영된다.
- 새 npm 의존성 없이 Node 내장 `node:crypto`(`randomBytes`/`createHash`)만 사용한다.
- 실패는 일반 401·비민감 로그로 정보 노출을 최소화한다.

## 단점

- 서명·nonce·timestamp 가 없어 **per-request replay 를 nonce 로 막지 않는다** — 유출된 요청의
  재사용은 `eventId` 멱등으로만 무해화되고, **위조 문자 주입은 토큰 비밀성(HTTPS)에 전적으로
  의존**한다(HMAC 경로 대비 명확한 보안 완화).
- 토큰이 유출되면 폐기 전까지 임의 eventId 로 가짜 카드 문자를 주입할 수 있다 → 유출 탐지·
  회전/폐기 운영이 중요해진다.
- 인증 경로가 둘로 늘어 문서·검증(§verify) 부담이 증가한다.
- `collect_token_hash` 는 여러 null 을 허용하는 일반 UNIQUE 이므로, 토큰 미발급 장치가 다수여도
  충돌하지 않지만, 인덱스 설계를 잘못하면(부분 유니크 오해) 혼선이 생길 수 있다.

## 변경조건

- 위조 문자 주입 위험이 실제 문제로 드러나면(토큰 유출 사례), 토큰 경로에도 경량 서명(예:
  본문 hash 서명) 또는 timestamp+nonce 방어를 선택적으로 추가하는 것을 재검토한다.
- 단축어/MacroDroid 가 향후 HMAC 계산을 1급으로 지원하면, 토큰 경로 사용을 줄이고 서명 경로로
  유도하는 것을 검토한다.
- 토큰 유출·정기 교체 요구가 커지면 collectToken 만료(TTL)·강제 회전 주기를 도입한다.
- 수집량이 커지면 토큰 경로에 rate limit 을 추가해 위조 주입 폭을 제한한다.
- 관련: [ADR-0007 장치 HMAC 인증](./0007-device-hmac-authentication.md) ·
  [ADR-0008 카드 문자 수집·파싱](./0008-card-sms-ingestion-and-parsing.md) ·
  [카드 문자 API 명세](../api/card-sms.md) · [addendum: 토큰 수집](../addendum-card-sms-token-ingest.md)
