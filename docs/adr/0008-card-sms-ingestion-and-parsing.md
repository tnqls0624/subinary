# ADR-0008: 카드 문자 멱등 수집 · 원문 이중보존 · 비동기 Strategy 파싱

## 제목

장치가 전송하는 카드 결제 문자를 (1) `UNIQUE(deviceId, eventId)` 기반으로 **멱등 수집**하고,
(2) 원문을 **DB + MinIO에 이중 보존**하며, (3) 순수 파서 패키지(`@family/card-parsers`)의
**Strategy 디스패처**로 (4) BullMQ에서 **비동기 파싱**하고, (5) 정규화 거래 모델과 분리해
`card_sms_events`의 구조화 컬럼 + `parseStatus`로 관리하는 설계 채택.

## 상태

승인됨 (Accepted) — 2026-07-15

## 배경

Phase 3은 스마트폰이 수신한 카드사 결제 문자(SMS/RCS)를 서버로 올려 원문을 보존하고, 금액·
가맹점·승인/취소 등을 구조화한다(PRD §31 Phase 3). 장치는 사람이 매번 로그인하지 않고
백그라운드에서 이벤트를 전송하므로 Phase 2의 `DeviceHmacGuard`(ADR-0007)를 그대로 재사용한다.

요구 불변식:

- **원문 우선 보존**(PRD §3.1, §11): 카드 문자 원문은 별도 Source Item으로 유실 없이 보존한다.
  파싱은 원문에서 파생된 뷰이며, 파싱이 틀려도 원문에서 재파싱할 수 있어야 한다.
- **정확 중복 차단**(PRD §14): 장치가 네트워크 재시도로 같은 문자를 여러 번 보내도 중복
  저장/재파싱이 없어야 한다.
- **금액은 KRW 정수**, 시각은 `Asia/Seoul` 기준, `confidence`는 0~100 정수(부동소수 회피).
- **로그 비노출**(PRD §11): 운영 로그에 문자 원문 전체·PII·secret을 남기지 않는다
  (eventId/해시/상태/issuer만).
- **실제 가맹점 임의 생성 금지**(PRD §15): 결제 대행사(네이버페이 등)만 확인되면 실제 가맹점을
  지어내지 않는다.

설계 포인트는 네 가지다. (1) 중복을 어떻게 막을 것인가, (2) 원문을 어디에 보존할 것인가,
(3) 파서를 어떻게 구조화·확장할 것인가, (4) 파싱을 언제(동기/비동기) 수행할 것인가.

## 결정

### 1. 멱등 수집 — `UNIQUE(device_id, event_id)` + `ON CONFLICT DO NOTHING`

- 장치는 각 문자에 고유 `eventId`(UUID 문자열)를 부여해 전송한다. `card_sms_events`에
  **`UNIQUE(deviceId, eventId)`** 제약을 두어 동일 장치의 동일 이벤트 재전송을 DB 레벨에서 차단한다.
- 수집 흐름: 먼저 `(deviceId, eventId)`로 기존 이벤트를 조회한다. 있으면 즉시 멱등 성공
  응답(`{ accepted:true, processingStatus:'duplicate', duplicate:true }`)을 반환하고 **MinIO
  저장·파싱 enqueue를 하지 않는다**. 없으면 `source_items` insert → `card_sms_events` insert를
  수행하되, 경합으로 unique 위반(23505)이 나면 이를 catch해 동일한 멱등 응답으로 수렴시킨다
  (`ON CONFLICT (device_id, event_id) DO NOTHING RETURNING` 결과가 비면 중복).
- 파싱 잡은 **`jobId = card_sms_events.id`**로 등록해 BullMQ 레벨에서도 중복 enqueue를 막는다.
- 결과적으로 재전송 시 (a) 새 레코드가 생기지 않고 (b) 재파싱이 발생하지 않는다.
- `content_hash = sha256(sender \n content \n receivedAtISO)`를 저장(INDEX)해 재전송/디버깅을
  보조한다. 2차 유사중복(`duplicate_suspected`) 판정은 Phase 4로 미룬다(PRD §14).

### 2. 원문 이중 보존 — MinIO(권위 사본) + DB(편의 사본)

- **`source_items`**(범용 원문 레코드)가 원문의 권위 사본을 가리킨다: MinIO `objectKey`
  (`card-sms/{householdId}/{eventId}.txt`) + `contentHash` + 크기·수신 메타. 실제 텍스트는
  MinIO에 저장한다(`ObjectStorageService.putObject`, `text/plain; charset=utf-8`).
- **`card_sms_events.rawContent`**(text)에 원문 **편의 사본**을 함께 둔다. 파싱 워커가 매 잡마다
  MinIO를 fetch하지 않아도 되고, 상세 조회 API가 즉시 원문을 돌려줄 수 있다. 향후 보존정책으로
  삭제할 때 `rawContent`와 MinIO 객체를 함께 제거한다.
- MinIO put이 실패해도 **수집 자체는 막지 않는다**(레코드는 남고 warn 로그). 파싱은 DB의
  `rawContent`로 진행 가능하므로 enqueue를 유지한다 — 원문 유실보다 수집 지속성을 우선한다.
- 운영 로그에는 원문 전체를 남기지 않는다 — eventId/contentHash/상태만 기록한다(PRD §11).

### 3. 파서 = 순수 패키지 `@family/card-parsers` + Strategy 디스패처

- 파서는 `문자열 → 결과` **순수 함수**다. 부수효과·DB·네트워크가 없어 단위 테스트가 핵심이다
  (PRD §29, vitest ≥8 케이스). worker만 의존하고, api는 파싱 **결과 타입**만 계약으로 안다.
- 카드사별 `CardSmsParser`(신한/KB국민)를 구현하고, `parseCardSms(input)` 디스패처가 등록된
  파서를 순회해 첫 `supports()===true` 파서로 `parse()`한다(Strategy). 매칭이 없으면
  `{ transactionType:'unknown', confidence:0, warnings:['no matching parser'] }`을 돌려준다.
- 결제 대행사(네이버페이/카카오페이/토스페이/KG이니시스)만 확인되면 `merchantRaw`는 대행사명으로
  두고 `warning('payment aggregator; merchant unconfirmed')`을 남긴다 — 실제 가맹점을 임의로
  생성하지 않는다(PRD §15).
- **circular dependency 회피**: 파서는 `@family/contracts`를 의존하지 않고 자체
  `CardSmsInput`/`CardSmsParseResult` 타입을 export한다. 시각 계산은 `date-fns-tz`를 직접
  의존(shared의 pino 유입 회피)하고, `MM/DD HH:mm`(연도 없음)을 `receivedAt`의 연도 + `Asia/Seoul`
  존으로 조합하되(`fromZonedTime`) 미래로 튀면 전년으로 롤오버 방어한다.
- 금액은 콤마·`원`·공백을 제거 후 `Number.isInteger`로 검증한 KRW 정수만 채택한다(부동소수 금지).
  `confidence`는 필수 필드(type/amount/occurredAt/merchant) 충족도로 0~100 정수를 부여한다.

### 4. BullMQ 비동기 파싱 + 상태 기계

- 수집 응답은 파싱 완료를 기다리지 않는다. 장치 요청은 **빠르게 200(`queued`)**으로 수락하고,
  파싱은 `card-sms-parse` 큐에서 워커가 처리한다(장치 응답 지연·파서 예외로부터 수집 경로 격리).
- 워커는 이벤트를 조회해 `parseCardSms`를 호출하고 `parseStatus`를 확정한다:
  - `transactionType !== 'unknown'` && `amount != null` → `confidence >= 70` 이고 warning이
    없으면 **`parsed`**, warning이 있거나 `confidence < 70`이면 **`pending_review`**.
  - `unknown`이거나 금액을 못 얻으면 **`parse_failed`**(`parseError = warnings.join`).
- 구조화 결과는 `card_sms_events`의 컬럼(issuer/transactionType/amount/currency/merchantRaw/
  occurredAt/maskedCardNumber/installmentMonths/confidence/parsedAt)에 저장한다. 조회 API가
  이 컬럼으로 목록·상세를 제공한다("웹앱 반영"은 파싱된 문자 조회 API로 충족).

### 5. 거래 도메인 분리 — Phase 3은 `card_sms_events`에 머문다

- 정규화 거래 모델(`card_transactions`), 카드 등록, 승인↔취소 연결, 카테고리/가맹점 규칙,
  공개범위는 **Phase 4**로 미룬다. Phase 3의 파싱 결과는 `card_sms_events`의 구조화 컬럼에
  두고 `parseStatus`로만 관리한다. 이는 원문 수집·파싱의 정확성을 먼저 안정화하고, 승격
  로직(멱등 연결·정정)을 별도 단계에서 검증하기 위함이다.

## 검토한 대안

1. **동기 파싱(수집 요청 안에서 파싱 후 응답)**: 흐름이 단순하나 파서 예외·지연이 장치 수집
   경로를 직접 흔들고, 재파싱·재시도 정책을 큐 없이 다뤄야 한다. 비동기 큐로 수집과 파싱의
   실패 도메인을 분리했다.
2. **원문을 DB에만 저장**: 구현이 단순하나 대용량 원문·첨부 확장 시 DB 부담이 크고, PRD §11의
   "별도 Source Item 보존" 원칙과 어긋난다. MinIO를 권위 사본으로, DB를 편의 사본으로 이중화했다.
3. **원문을 MinIO에만 저장**: 저장은 깔끔하나 워커가 매 잡마다 fetch해야 하고 조회 API 지연이
   커진다. `rawContent` 편의 사본으로 상쇄했다.
4. **`content_hash`만으로 중복 차단**: 유사·해시충돌 경계가 모호하고 정정 재전송을 다루기 어렵다.
   장치가 부여한 `eventId` 기반 `UNIQUE(deviceId, eventId)`가 1차 정확 중복에 명확하다
   (해시는 보조 인덱스로만 사용).
5. **정규식 하나로 전 카드사 파싱**: 초기엔 짧지만 카드사별 포맷 편차·예외가 누적되며 유지보수가
   급격히 나빠진다. 카드사별 Strategy로 분리해 파서 추가가 격리되도록 했다.
6. **파서를 api/worker에 인라인**: 순환 의존·중복 구현·테스트 난이도가 커진다. 순수 패키지로
   추출해 contracts 비의존·단위 테스트 용이성을 확보했다.
7. **Phase 3에서 `card_transactions`까지 승격**: 범위가 커지고 승인↔취소 연결·정정의 멱등성까지
   한 번에 검증해야 해 위험하다. 원문·파싱을 먼저 안정화하고 거래 도메인은 Phase 4로 분리했다.

## 장점

- 재전송이 잦은 모바일 환경에서 중복 저장/재파싱이 구조적으로 없다(멱등 + jobId dedupe).
- 원문이 유실 없이 보존되고(MinIO 권위 사본), 파싱이 틀려도 원문에서 재파싱할 수 있다.
- 파서가 순수 함수라 카드사 추가가 격리되고 단위 테스트로 회귀를 잡는다(Strategy).
- 수집과 파싱의 실패 도메인이 분리되어 파서 예외가 수집 지속성을 해치지 않는다.
- 금액 KRW 정수·`Asia/Seoul` 시각·0~100 정수 confidence로 표현 오차와 부동소수 문제를 배제한다.
- 로그 비노출·비멤버 403(서비스 계층 강제)로 프라이버시·권한 경계를 지킨다.

## 단점

- 원문을 두 곳(DB+MinIO)에 두어 저장 중복과 삭제 시 **동기화 책임**(둘 다 지워야 함)이 생긴다.
- 비동기 파싱으로 수집 직후엔 결과가 없어 클라이언트가 **폴링/대기**해야 한다(완료 조건도 10초 폴링).
- 카드사별 파서는 문자 포맷 변경에 취약하다 — 포맷이 바뀌면 파서·테스트를 갱신해야 한다
  (`parse_failed`/`pending_review`로 안전하게 흡수하되 검토 필요).
- 파싱 결과를 `card_sms_events` 컬럼에 임시 보관하므로, Phase 4에서 `card_transactions`로
  승격하는 **마이그레이션·연결 로직**이 추가로 필요하다.

## 변경조건

- 카드사가 늘거나 문자 포맷이 잦게 바뀌면 파서 등록 방식을 데이터/규칙 기반으로 재검토한다.
- 원문 보존정책(자동 삭제)이 필요해지면 `source_items`에 보존 컬럼/스케줄러를 도입하고 DB·MinIO
  동시 삭제를 보장한다(Phase 3에선 생략).
- 정규화 거래·승인↔취소 연결·카테고리 규칙·공개범위가 필요해지면 `card_transactions`(Phase 4)로
  승격하고, `card_sms_events`는 원문·파싱 원장 역할로 정리한다.
- 파싱 지연·처리량이 병목이 되면 큐 동시성·재시도 정책과 `pending_review` 검토 워크플로를 확장한다.
