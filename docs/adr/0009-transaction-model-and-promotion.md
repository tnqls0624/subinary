# ADR-0009: 정규화 거래 모델 · 파싱→거래 승격 · 취소연결 · netAmount · 공개범위

## 제목

파싱된 카드 문자(`card_sms_events`)를 정규화 거래(`card_transactions`)로 (1) **멱등 승격**하고
(2) 카드 자동연결·카테고리 분류·2차 유사중복 탐지를 승격 시점에 수행하며, (3) 승인↔취소를
`parentTransactionId`로 연결해 (4) **`netAmount` 규약**(approval=amount-cancelledAmount,
cancellation=0)으로 순지출 이중계상을 막고, (5) 카드 상속 **공개범위**를 **서비스 계층에서
actor 기준으로 강제**하며, (6) 카테고리를 **사용자규칙→가족규칙→키워드→미분류** 우선순위로
결정하는 설계 채택.

## 상태

승인됨 (Accepted) — 2026-07-15

## 배경

Phase 3(ADR-0008)은 카드 문자 원문을 멱등 수집하고 `card_sms_events`의 구조화 컬럼에 파싱 결과를
남겼다. Phase 4는 이를 **가계부의 1급 도메인**인 정규화 거래(`card_transactions`)로 승격해
카드 등록·자동연결, 승인/취소/부분취소, 카테고리·가맹점 규칙, 공개범위를 제공한다(PRD §31 Phase 4).

요구 불변식:

- **멱등 승격**: 파싱 잡이 재시도되거나 재파싱되어도 한 문자 이벤트는 정확히 한 거래로만 승격된다.
- **순지출 정확**(PRD §17): 취소·부분취소가 반영된 월별 순지출이 정확해야 하고, 취소 레코드가
  통계에 **이중 계상**되면 안 된다.
- **금액은 KRW 정수**, 시각은 `Asia/Seoul` 기준 ISO 문자열(부동소수 금지).
- **공개범위**(PRD §8, §26): 타인의 `private` 거래는 조회에서 제외하고, 타인의 `summary_only`
  거래는 목록에서 가맹점을 마스킹한다. 이 강제는 **서비스 계층에서 actor(userId/memberId)**로
  수행한다(컨트롤러/DB 레벨 신뢰 금지).
- **카테고리 임의 생성 금지**(PRD §15): 결제 대행사만 확인되면 미분류로 두고 가맹점을 지어내지 않는다.
- **로그 비노출**(PRD §11): 금액/가맹점/PII/secret을 운영 로그에 남기지 않는다(id/type/status만).

설계 포인트는 여섯 가지다. (1) 승격을 어디서·어떻게 멱등하게 할 것인가, (2) 카드를 어떻게
연결할 것인가, (3) 취소를 승인에 어떻게 연결하고 상태를 어떻게 전이할 것인가, (4) 순지출을
어떤 규약으로 집계할 것인가, (5) 공개범위를 어디서 강제할 것인가, (6) 카테고리를 어떤 우선순위로
결정할 것인가.

## 결정

### 1. 파싱→거래 승격 파이프라인 (worker, 멱등)

- Phase 3의 `card-sms-parse.processor`가 파싱 업데이트를 마친 뒤, `parseStatus in ('parsed',
  'pending_review')`이면 **같은 잡 안에서** `TransactionPromotionService.promote(cardSmsEventId)`를
  `await`한다. 별도 큐를 두지 않아 수집→파싱→승격이 **10초 이내 반영**된다. `parse_failed`는
  승격하지 않는다(거래로 올릴 구조화 데이터가 없음).
- **멱등 키는 `card_transactions.sourceEventId`의 `UNIQUE` 제약**이다. 승격 insert는
  `onConflictDoNothing({ target: sourceEventId })`로 수행하고, 충돌 시 기존 거래를 반환한다.
  파싱 재시도·재승격이 있어도 한 이벤트는 정확히 한 거래로만 존재한다.
- 승인 거래 승격: 카드 자동연결 → 카테고리 분류 → 2차 유사중복 탐지 → `netAmount=amount`,
  `approvedAt=occurredAt`으로 insert.
- 취소 거래 승격: 취소 레코드를 insert하고(자체 `status='approved'`, `netAmount=0`,
  `cancelledAt=occurredAt`), 대응 승인 거래를 탐색·연결한다(아래 §3).

### 2. 카드 자동연결 — 뒤 4자리 매칭

- 파서의 `maskedCardNumber`(`****NNNN`)의 **뒤 4자리**를, 같은 household `payment_cards`의
  `maskedNumber` 뒤 4자리와 매칭한다. 일치하는 카드가 있으면 `cardId`를 연결하고 거래
  `visibility`를 **카드의 visibility로 상속**한다.
- 매칭이 없으면 `cardId=null`, `visibility='household'`(안전 기본값 — 미연결 거래는 가족 공개).
- 카드번호는 뒤 4자리만 저장하도록 권장한다(원문 카드번호 보관 금지). 매칭은 카드사(issuer)가
  아니라 **뒤 4자리**만 사용한다.

### 3. 승인↔취소 연결 + 상태 전이

- 취소 승격 시 대응 승인을 탐색한다: **같은 household/card**, `transactionType='approval'`,
  가맹점 유사, **`approvedAt < cancelledAt`**, 잔액(`amount - cancelledAmount`)이 취소액을
  수용 가능(잔액 ≥ 취소액 또는 근접), authorizationCode가 있으면 우선. **유일 매칭**일 때만 연결한다.
- 연결되면: 취소 레코드의 `parentTransactionId`를 승인에 설정하고, 승인의
  `cancelledAmount += 취소액`, `netAmount = amount - cancelledAmount`, `status`를 재계산한다
  (`cancelledAmount >= amount` → `cancelled`, 그 외 → `partially_cancelled`).
- 매칭이 **다중/불명확**하면 취소 레코드를 `pending_review`로 두고 자동 연결을 보류한다. 사람이
  `POST /v1/transactions/:id/link-cancellation`으로 수동 연결한다.
- 상태 갱신은 **트랜잭션** 안에서 취소 레코드와 승인 레코드를 함께 갱신해 원자성을 지킨다.

### 4. `netAmount` 규약 — 순지출 이중계상 방지

- **승인(`approval`) 거래**: `netAmount = amount - cancelledAmount`. 부분/전체 취소가 누적되면
  `netAmount`가 감소하고, 전체 취소 시 0이 된다. 월 순지출 통계는
  **`sum(netAmount) WHERE transactionType='approval'`** 로 계산한다.
- **취소(`cancellation`) 거래**: 이력·감사용 레코드로만 남기고 **`netAmount = 0`** 으로 고정한다.
  취소를 별도 음수 항목으로 더하지 않으므로(승인 쪽 `cancelledAmount`에 이미 반영) 순지출이
  이중으로 상쇄되지 않는다.
- 모든 금액은 KRW 정수다. `packages/shared`의 `assertKrwInteger`/`sumKrw`로 부동소수·오버플로를
  차단한다.

### 5. 공개범위 — 서비스 계층에서 actor 기준 강제 (PRD §8, §26)

- 거래 `visibility`는 연결된 카드의 visibility를 상속한다(카드 없으면 `household`).
- 목록/상세 조회는 요청자의 **actor(userId → 해당 household의 memberId)**를 기준으로 서비스에서
  필터링한다. 반환 집합 = **본인 거래 ∪ `visibility='household'` 거래**.
  - 타인의 `private` 거래: **완전 제외**(목록에 나타나지 않음; 상세는 `403/404`).
  - 타인의 `summary_only` 거래: 목록에 **포함하되 가맹점/메모를 마스킹**한다
    (`merchantRaw=null`, `merchantNormalized=null`, `memo=null`, `masked=true`). 금액은 노출한다
    (통계 포함은 Phase 5).
- 이 강제는 컨트롤러가 아니라 **서비스**에서 수행한다 — 어떤 진입점으로 와도 동일한 규칙이 적용된다.
- 쓰기(수정/연결/카드 등록)는 소유자(`ownerMemberId`=본인) 또는 owner/admin만 허용한다.

### 6. 카테고리 우선순위 (PRD §15, LLM 제외)

승격·재분류 시 다음 우선순위로 `categoryId`를 결정한다.

1. **사용자가 거래에 직접 지정**(`PATCH /v1/transactions/:id { categoryId }`).
2. **`merchant_category_rules`**(household, `merchantNormalized` **정확 매칭**).
3. **키워드 규칙**(`@family/shared`의 순수 함수 `categorizeByKeyword` → 시스템 카테고리 slug).
4. **미분류**(`null`).

- 사용자가 거래 카테고리를 바꾸며 `applyRule=true`를 주면 `(householdId, merchantNormalized)
  → categoryId`를 `merchant_category_rules`에 upsert한다. 이 규칙은 **이후** 승격/재분류에만
  반영되고 **과거 거래를 소급하지 않는다**(예측 가능성·감사 용이성).
- 시스템 카테고리(`expense_categories`, `household_id IS NULL`)는 `OnModuleInit` 시드로 멱등
  주입한다(`DEFAULT_CATEGORIES`, partial unique on slug). Phase 4는 시스템 카테고리만 사용한다.
- LLM 기반 분류(§15 5순위)는 Phase 7+로 미룬다.

## 검토한 대안

1. **승격을 별도 큐/워커로 분리**: 재시도·백프레셔에 유리하나 "10초 내 반영" 완료 조건을 맞추기
   어렵고 파이프라인이 복잡해진다. 같은 잡 안에서 파싱 직후 `await promote`로 단순화했다
   (멱등 키가 있어 재시도 안전).
2. **멱등 키를 (household, amount, merchant, time) 조합 해시로**: 경계가 모호하고 정정
   재전송·유사 거래를 잘못 합칠 위험이 있다. 이벤트당 1거래가 명확한 `sourceEventId UNIQUE`를 택했다.
3. **취소를 승인에 병합(별도 레코드 없음)해 amount만 감액**: 원장이 단순해지나 취소 이력·감사
   추적이 사라지고 부분취소 여러 건을 되돌리기 어렵다. 취소를 **별도 레코드(netAmount=0)**로
   남기고 승인의 `cancelledAmount`에 누적해 이력과 순지출을 모두 만족시켰다.
4. **취소를 음수 금액으로 통계에 합산**: 직관적이나 승인/취소 양쪽을 더하면 이중 상쇄·부호 실수가
   잦다. 순지출을 **승인 `netAmount` 합**으로 단일화하고 취소는 0으로 고정했다.
5. **공개범위를 DB 뷰/RLS로 강제**: 강력하나 Phase 4 범위에선 운영 복잡도가 크고 `summary_only`
   부분 마스킹 같은 뷰-특화 규칙을 표현하기 번거롭다. 서비스 계층 강제로 규칙을 한 곳에 모았다
   (테스트로 회귀 방지).
6. **카테고리를 승격 시 확정하고 규칙 변경을 소급 적용**: 과거 통계가 흔들리고 감사가 어렵다.
   규칙은 **이후 거래에만** 적용하고 과거는 명시적 재분류로만 바꾸도록 했다.
7. **카드 자동연결을 카드사+뒤4자리로**: 파서 issuer 표기 편차(예: `신한`/`신한카드`)로 매칭이
   깨지기 쉽다. household 범위에서 **뒤 4자리**만으로 매칭하고 미매칭은 안전하게 `household`로 둔다.

## 장점

- 파싱 재시도·재승격에도 한 이벤트가 한 거래로만 존재한다(`sourceEventId UNIQUE` + onConflictDoNothing).
- 취소 이력을 보존하면서(별도 레코드) 순지출은 승인 `netAmount` 합으로 이중계상 없이 정확하다.
- 공개범위 규칙이 서비스 계층 한 곳에 모여 진입점과 무관하게 일관되며 e2e로 검증된다.
- 카테고리 규칙이 예측 가능하다 — 과거를 소급하지 않아 통계·감사가 안정적이다.
- 금액 KRW 정수·`Asia/Seoul` ISO·로그 비노출로 표현 오차와 프라이버시 경계를 지킨다.
- 카드 자동연결이 issuer 표기에 취약하지 않고, 미매칭도 안전 기본값으로 흡수한다.

## 단점

- 승격을 파싱 잡에 인라인해 파싱 잡의 실행 시간이 늘고, 승격 실패가 파싱 잡 재시도를 유발할 수 있다
  (멱등이라 안전하지만 관측·알람이 필요).
- 취소 자동연결이 휴리스틱(금액/가맹점/시각 근접)이라 애매하면 `pending_review`로 남아 **수동
  연결**이 필요하다.
- 2차 유사중복 탐지가 시각 근접·가맹점 유사에 의존해 오탐/미탐 가능성이 있다
  (`duplicate_suspected`로 표시 후 사람이 확정).
- 공개범위를 서비스에서 강제하므로 새 조회 경로를 추가할 때마다 규칙 적용을 잊지 않도록 주의해야
  한다(테스트로 강제).
- 카테고리 규칙을 소급하지 않으므로, 규칙 변경을 과거에 반영하려면 별도 재분류 도구가 필요하다.

## 변경조건

- LLM 카테고리 분류(PRD §15 5순위)가 필요해지면 우선순위에 5단계를 추가하되 규칙/키워드 결과를
  우선하는 순서를 유지한다(Phase 7+).
- 통계·대시보드·예산(Phase 5)에서 `summary_only` 금액 포함·타인 거래 집계가 필요해지면 조회
  전용 집계 경로를 추가하되 공개범위 강제는 서비스 계층에 유지한다.
- merchants/merchant_aliases 마스터가 도입되면 `merchantNormalized` 경량 정규화를 마스터 매칭으로
  승격하고 규칙 매칭도 별칭 기반으로 확장한다.
- 취소 자동연결 오탐/미탐이 잦아지면 authorizationCode·승인번호를 파서에서 추출해 연결 신뢰도를
  높이고, `pending_review` 검토 워크플로를 강화한다.
- 승격 처리량이 병목이 되면 승격을 별도 큐로 분리하되 `sourceEventId UNIQUE` 멱등을 그대로 유지한다.
