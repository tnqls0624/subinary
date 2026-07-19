# 카드 / 거래 / 카테고리 API 명세

> Phase 4 기준. 계약 스키마의 단일 소스는 `@family/contracts`(zod)이며, 본 문서는 예시다.
> 모든 엔드포인트는 전역 prefix `v1`을 사용한다. 타임스탬프는 ISO 8601 문자열(`toISOString`),
> **금액은 KRW 정수(원)**, 시각 기준은 `Asia/Seoul`다.
>
> 관련 설계: [ADR-0009 거래 모델·승격](../adr/0009-transaction-model-and-promotion.md) ·
> [ADR-0008 카드 문자 수집·파싱](../adr/0008-card-sms-ingestion-and-parsing.md) ·
> [Phase 4 빌드 스펙](../phase4-build-spec.md) · [카드 문자 수집/조회 API](./card-sms.md)

## 개요

Phase 4는 파싱된 카드 문자(`card_sms_events`)를 정규화 거래(`card_transactions`)로 **승격**하고,
카드 등록·자동연결, 승인/취소/부분취소, 카테고리·가맹점 규칙, 공개범위를 제공한다.

| 도메인 | 컨트롤러 | 인증 | 쓰임 |
|---|---|---|---|
| 카드 | `Controller('cards')` | JWT Access Token | 카드 등록·조회·수정 |
| 카테고리 | `Controller('categories')` | JWT Access Token | 시스템/가족 카테고리 조회 |
| 거래 | `Controller('transactions')` | JWT Access Token | 거래 목록·상세·요약·가맹점 라벨 검토·수정·취소연결·중복표시 |

핵심 규약(자세한 근거는 ADR-0009):

- **승격은 멱등**이다 — `card_transactions.sourceEventId`가 `UNIQUE`이고 승격 insert는
  `onConflictDoNothing`으로 한 문자 이벤트를 정확히 한 거래로만 만든다.
- **`netAmount` 규약**: 승인 거래는 `netAmount = amount - cancelledAmount`, 취소 거래는
  이력용으로 `netAmount = 0`(순지출 이중계상 방지).
- **공개범위는 서비스 계층에서 actor 기준으로 강제**된다 — 타인 `private`는 제외, 타인
  `summary_only`는 가맹점 마스킹(`masked=true`).
- 수집→파싱→승격이 모두 **비동기**(같은 잡 내 승격)이므로 거래 조회는 폴링한다(권장 상한 10초).
- **응답/로그 어디에도** 카드번호 원문·PII·secret을 남기지 않는다(로그는 id/type/status만).

---

## 1. 카드 — `Controller('cards')`

| 메서드 · 경로 | 성공 | 설명 |
|---|---|---|
| `POST /v1/cards` | `201` | 카드 등록 |
| `GET /v1/cards?householdId=…` | `200` | 가족 카드 목록 |
| `GET /v1/cards/:id` | `200` | 카드 단건 |
| `PATCH /v1/cards/:id` | `200` | alias/visibility/status 수정 |

### `POST /v1/cards` (`cardCreateRequestSchema`)

```json
{
  "householdId": "3c2d…",
  "issuer": "신한카드",
  "alias": "우리집 신한카드",
  "maskedNumber": "1234",
  "visibility": "household"
}
```

| 필드 | 규칙 |
|---|---|
| `householdId` | 필수(uuid). 요청자는 이 가족의 활성 멤버여야 함(아니면 `403`). |
| `issuer` | 카드사 표기(1–50자). **자동연결과 무관** — 매칭은 뒤 4자리만 사용. |
| `alias` | 카드 별칭(1–100자). |
| `maskedNumber` | 선택(최대 40자). **뒤 4자리만 저장 권장**(자동연결이 뒤 4자리를 매칭). |
| `visibility` | `private \| household \| summary_only`(기본 `household`). 이 카드로 승격된 거래가 상속. |

응답 `201 Created` (`cardSummarySchema`) — 카드 fingerprint는 절대 노출하지 않는다:

```json
{
  "id": "card-1…",
  "householdId": "3c2d…",
  "ownerMemberId": "mem-a…",
  "issuer": "신한카드",
  "alias": "우리집 신한카드",
  "maskedNumber": "1234",
  "visibility": "household",
  "status": "active",
  "createdAt": "2026-07-15T10:00:00.000Z"
}
```

- 등록/수정은 **소유자(`ownerMemberId`=본인)** 또는 owner/admin만 허용한다.
- `PATCH /v1/cards/:id`는 `cardUpdateRequestSchema`(`alias?`, `visibility?`,
  `status?: active|inactive`). `inactive` 카드는 이후 자동연결 대상에서 제외한다.

---

## 2. 카테고리 — `Controller('categories')`

| 메서드 · 경로 | 성공 | 설명 |
|---|---|---|
| `GET /v1/categories?householdId=…` | `200` | 시스템 + 가족 커스텀 카테고리(Phase 4는 시스템만) |

시스템 카테고리는 서버 기동 시(`OnModuleInit`) 멱등 시드된다(`@family/shared`의
`DEFAULT_CATEGORIES`). 응답 항목은 `categorySummarySchema`:

```json
[
  { "id": "cat-food",  "slug": "food",     "name": "식비",  "isSystem": true },
  { "id": "cat-cafe",  "slug": "cafe",     "name": "카페",  "isSystem": true },
  { "id": "cat-deliv", "slug": "delivery", "name": "배달",  "isSystem": true }
]
```

기본 slug: `food cafe delivery transport fuel shopping grocery medical telecom subscription etc`.

---

## 3. 거래 — `Controller('transactions')`

| 메서드 · 경로 | 성공 | 설명 |
|---|---|---|
| `GET /v1/transactions?householdId=…&…` | `200` | 거래 목록(공개범위 필터 적용) |
| `GET /v1/transactions/summary?householdId=…&from=…&to=…` | `200` | 기간 순지출 요약(검증용) |
| `GET /v1/transactions/merchant-label-candidates?householdId=…&limit=…` | `200` | 사람 확정이 필요한 가맹점 검토 batch |
| `GET /v1/transactions/:id` | `200` | 거래 단건(공개범위 적용) |
| `PATCH /v1/transactions/:id` | `200` | 카테고리/가맹점/카드/멤버/공개범위/메모 수정 |
| `POST /v1/transactions/:id/link-cancellation` | `200/201` | 취소↔승인 수동 연결 |
| `POST /v1/transactions/:id/mark-duplicate` | `200/201` | `duplicate_suspected` 표시 |
| `POST /v1/transactions/:id/mark-valid` | `200/201` | `pending_review`/`duplicate_suspected` → `approved`(net 재계산) |

> 라우트 순서상 `/summary`, `/merchant-label-candidates` 같은 정적 경로는 `/:id`보다 먼저
> 선언되어야 한다(그렇지 않으면 정적 경로가 id로 잡힘).

### `GET /v1/transactions` — 목록

| 쿼리 | 규칙 |
|---|---|
| `householdId` | 필수. 요청자는 활성 멤버여야 함(아니면 `403`). |
| `memberId` `cardId` `type` `status` `categoryId` | 선택 필터. |
| `from` `to` | 선택. 기간(`approvedAt`) 필터(ISO). |
| `minAmount` `maxAmount` | 선택. 금액 범위(KRW 정수). |
| `limit` `cursor` | 선택. 페이지네이션(기본 50, 최대 100). |

응답 `200 OK` (`transactionListResponseSchema`) — 항목은 `transactionSummarySchema`:

```json
{
  "items": [
    {
      "id": "txn-1…",
      "householdId": "3c2d…",
      "memberId": "mem-a…",
      "cardId": "card-1…",
      "transactionType": "approval",
      "status": "partially_cancelled",
      "amount": 12500,
      "cancelledAmount": 5000,
      "netAmount": 7500,
      "currency": "KRW",
      "merchantRaw": "스타벅스",
      "merchantNormalized": "스타벅스",
      "categoryId": "cat-cafe",
      "categorySlug": "cafe",
      "approvedAt": "2026-07-15T00:30:00.000Z",
      "cancelledAt": null,
      "installmentMonths": 1,
      "parentTransactionId": null,
      "visibility": "household",
      "memo": null,
      "masked": false,
      "createdAt": "2026-07-15T00:30:01.000Z"
    }
  ],
  "nextCursor": null
}
```

**공개범위 필터**(actor=요청자의 memberId, 서비스 계층 강제):

- 본인 거래 ∪ `visibility='household'` 거래를 반환한다.
- 타인 `private` 거래는 **완전 제외**(목록에 없음).
- 타인 `summary_only` 거래는 **포함하되 마스킹**: `masked=true`, `merchantRaw=null`,
  `merchantNormalized=null`, `memo=null`. **금액은 노출**한다.

```json
{
  "id": "txn-9…", "cardId": "card-9…", "transactionType": "approval", "status": "approved",
  "amount": 15000, "cancelledAmount": 0, "netAmount": 15000, "currency": "KRW",
  "merchantRaw": null, "merchantNormalized": null, "categorySlug": null,
  "visibility": "summary_only", "memo": null, "masked": true, "…": "…"
}
```

### `GET /v1/transactions/summary` — 기간 순지출 요약

```bash
curl -s 'http://localhost:3001/v1/transactions/summary?householdId=3c2d…&from=2026-07-01T00:00:00%2B09:00&to=2026-08-01T00:00:00%2B09:00' \
  -H 'Authorization: Bearer <accessToken>'
```

응답 `200 OK` (`transactionSummaryResponseSchema`):

```json
{
  "period": { "from": "2026-07-01T00:00:00+09:00", "to": "2026-08-01T00:00:00+09:00", "timezone": "Asia/Seoul" },
  "totalNet": 24300,
  "totalApproved": 51800,
  "totalCancelled": 27500,
  "includedMembers": ["mem-a…"],
  "count": 5
}
```

- `totalNet` = **`sum(netAmount) WHERE transactionType='approval'`** 이고 기간은 `approvedAt`
  기준이다. 취소가 반영된 순지출이며 취소 레코드(`netAmount=0`)는 더하지 않는다(이중계상 방지).
- 공개범위 규칙이 반영된다(본인 + 접근 가능한 거래).

### `GET /v1/transactions/merchant-label-candidates` — 사람 라벨 검토 큐

```bash
curl -s 'http://localhost:3001/v1/transactions/merchant-label-candidates?householdId=3c2d…&limit=20' \
  -H 'Authorization: Bearer <accessToken>'
```

응답 `200 OK` (`merchantLabelCandidateListResponseSchema`):

```json
{
  "items": [
    {
      "representativeTransactionId": "txn-1…",
      "merchantNormalized": "스타벅스 강남점",
      "transactionCount": 2,
      "latestTransactionAt": "2026-07-19T05:00:00.000Z",
      "source": "model_prediction",
      "suggestedCategoryId": "cat-cafe…",
      "suggestedCategorySlug": "cafe"
    }
  ],
  "hasMore": false,
  "trainingReadiness": {
    "humanConfirmedLabels": 1,
    "requiredLabels": 100,
    "distinctClasses": 1,
    "requiredClasses": 3,
    "minimumClassLabels": 1,
    "requiredLabelsPerClass": 10,
    "missingLineage": 0,
    "status": "collect_labels"
  }
}
```

- 승인·집계 포함 거래 가운데 사람 확정 규칙이 없거나 AI 추천만 있는 가맹점을 묶는다.
  AI 추천이 있는 항목, 확인 가능한 거래 수, 최근 거래 시각 순으로 우선순위를 정한다.
- 일반 구성원은 본인 거래만, owner/admin은 본인 거래와 `household` 공개 거래만 검토할 수 있다.
  타인의 `private`·`summary_only` 거래는 가맹점 원문 유출 방지를 위해 후보에서 완전히 제외한다.
- 금액·메모·문자 원문은 응답하지 않는다. `source=model_prediction`은 추천값일 뿐 학습 정답이 아니다.
- 화면의 확인 동작은 대표 거래에 `PATCH { categoryId, applyRule: true }`를 보내며, 그때만
  규칙을 `human_confirmed`로 바꾸고 append-only `feedback_events` 계보를 남긴다.
- `trainingReadiness`는 가맹점명을 노출하지 않는 household 전체 집계다. 실제 학습은 이 라벨 수집
  기준 외에도 승인 snapshot과 `group_time` leakage audit를 별도로 통과해야 한다.
- `limit`은 양의 정수만 허용하고 최대 100으로 제한한다. 미가입 가족은 `403`이다.

### `PATCH /v1/transactions/:id` (`transactionUpdateRequestSchema`)

```json
{ "categoryId": "cat-food", "applyRule": true }
```

| 필드 | 규칙 |
|---|---|
| `categoryId` | 거래 카테고리 직접 지정(우선순위 1). |
| `applyRule` | `true` + `categoryId` 지정 시 `(householdId, merchantNormalized) → categoryId`를 `human_confirmed` 규칙으로 upsert하고 feedback 계보 기록 → **이후** 승격/재분류에만 반영(과거 소급 안 함). |
| `merchantNormalized` `cardId`(nullable) `memberId` `visibility` `memo` | 선택 수정. `cardId` 변경 시 visibility 재상속 옵션. |

- 수정은 소유자 또는 owner/admin만 허용한다.

---

## 4. 승격 파이프라인 (파싱 → 거래)

Phase 3 `card-sms-parse.processor`가 파싱을 마친 뒤, `parseStatus in ('parsed',
'pending_review')`이면 같은 잡 안에서 `TransactionPromotionService.promote(eventId)`를 실행한다
(별도 큐 없음 → 수집~반영 10초 이내). 상세 근거는 ADR-0009.

```
card_sms_events(parsed)                    payment_cards(household, 뒤4자리)
        │                                          │
        ▼                                          ▼
promote(eventId)  ── 멱등: sourceEventId UNIQUE + onConflictDoNothing
        │
        ├─ 카드 자동연결: maskedCardNumber 뒤4자리 == card.maskedNumber 뒤4자리
        │     → cardId, visibility = 카드 visibility (미매칭: cardId=null, visibility='household')
        ├─ merchantNormalized = normalizeMerchant(merchantRaw)
        ├─ 카테고리: 규칙(merchant_category_rules) → 키워드(categorizeByKeyword) → null
        │
        ├─ approval → 2차 중복 탐지(동일 card/amount/유사 merchant/시각 근접)
        │     매칭 있음 → status='duplicate_suspected', 없음 → 'approved'
        │     netAmount=amount, cancelledAmount=0, approvedAt=occurredAt
        │
        └─ cancellation → 취소 레코드 insert(netAmount=0, cancelledAt=occurredAt)
              대응 승인 탐색(같은 household/card, approvedAt<cancelledAt, 잔액≥취소액, 가맹점 유사)
              유일 매칭 → parentTransactionId 연결 + 승인 갱신(아래 §5)
              다중/불명확 → 취소 status='pending_review'(수동 연결 대기)
```

카테고리 우선순위(LLM 제외): **1. 사용자 직접 지정 → 2. 가맹점 규칙(정확 매칭) →
3. 키워드 규칙 → 4. 미분류(null)**. 결제 대행사만 확인되면 미분류로 두고 가맹점을 지어내지 않는다.

---

## 5. 취소 연결 예시 (승인 → 부분취소 → 전체취소)

같은 카드(신한 뒤4자리 `1234`)/가맹점(스타벅스) 승인 12,500원에 부분/전체 취소가 붙는 흐름.

**① 승인 12,500원** — `netAmount=amount`:

```json
{ "id": "txn-A", "transactionType": "approval", "status": "approved",
  "amount": 12500, "cancelledAmount": 0, "netAmount": 12500, "parentTransactionId": null }
```

**② 부분 취소 5,000원** — 취소 레코드는 `netAmount=0`이고 승인 `txn-A`에 연결, 승인은
`partially_cancelled`로 전이:

```json
// 취소 레코드
{ "id": "txn-C1", "transactionType": "cancellation", "status": "approved",
  "amount": 5000, "netAmount": 0, "parentTransactionId": "txn-A", "cancelledAt": "2026-07-15T00:40:00.000Z" }
// 승인 재계산
{ "id": "txn-A", "status": "partially_cancelled",
  "amount": 12500, "cancelledAmount": 5000, "netAmount": 7500 }
```

**③ 잔액 전체 취소 7,500원** — 승인은 `cancelled`, `netAmount=0`:

```json
// 취소 레코드
{ "id": "txn-C2", "transactionType": "cancellation", "status": "approved",
  "amount": 7500, "netAmount": 0, "parentTransactionId": "txn-A" }
// 승인 재계산
{ "id": "txn-A", "status": "cancelled",
  "amount": 12500, "cancelledAmount": 12500, "netAmount": 0 }
```

자동 연결이 애매하면 취소 레코드가 `pending_review`로 남고, 다음으로 수동 연결한다:

```bash
curl -s -X POST 'http://localhost:3001/v1/transactions/txn-C2/link-cancellation' \
  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \
  --data '{ "approvalTransactionId": "txn-A" }'   # linkCancellationRequestSchema
```

---

## 6. 공개범위 예시 (private 제외 · summary_only 마스킹)

userA(소유자)가 카드 3장을 등록하고, userB는 같은 가족 `member`다.

| 카드 | visibility | userB 목록에서 |
|---|---|---|
| 신한 `1234` | `household` | **포함**(가맹점 노출, `masked=false`) |
| 신한 `5678` | `private` | **완전 제외**(항목 없음) |
| 신한 `9012` | `summary_only` | **포함**하되 **가맹점 마스킹**(`merchantRaw=null`, `masked=true`, 금액은 노출) |

- 본인(userA) 조회 시에는 세 카드 거래가 모두 원문 그대로 보인다.
- 이 규칙은 서비스 계층에서 actor 기준으로 강제되므로 어떤 조회 경로에서도 동일하게 적용된다.

---

## 7. 상태(`status`) 기계

| 상태 | 의미 |
|---|---|
| `approved` | 정상 승인(취소 없음) 또는 검토 후 유효 확정. |
| `partially_cancelled` | 부분 취소 누적(`0 < cancelledAmount < amount`). |
| `cancelled` | 전체 취소(`cancelledAmount ≥ amount`, `netAmount=0`). |
| `pending_review` | 취소 대응 승인이 애매해 자동 연결 보류(수동 연결 대기). |
| `duplicate_suspected` | 2차 유사중복 의심(동일 card/amount/유사 merchant/시각 근접). |

취소(`cancellation`) 레코드 자체는 `approved`로 남고 순지출에 계상되지 않는다(`netAmount=0`).
승인 레코드가 `partially_cancelled`/`cancelled`의 결과를 담는다.

---

## 8. 검증 (완료 조건 e2e)

Phase 4 완료 조건은 `scripts/verify-phase4.mjs`가 실 스택(`http://localhost:3001`)을 대상으로
자동 검증한다(스펙 §8 시나리오 1~10). Node 내장 `fetch` + `node:crypto`만 사용하고, 장치 문자
서명은 verify-phase2/3와 동일한 레시피(`HMAC-SHA256(secret, ${ts}.${nonce}.${bodyString})`)로
만들며 body는 서명한 문자열과 **동일 바이트**로 전송한다. 수집→파싱→승격이 비동기이므로 거래는
최대 10초 폴링한다(`GET /v1/transactions`).

```bash
# 전체 스택 기동(진행자 수행): docker compose up -d --build
node scripts/verify-phase4.mjs
# 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase4.mjs
```

검증 시나리오: 카드 등록 → 승인 승격(카드연결·`netAmount=12500`·`categorySlug='cafe'`) →
부분 취소(`partially_cancelled`, `netAmount=7500`) → 전체 취소(`cancelled`, `netAmount=0`) →
카테고리 수정 + 규칙 저장(이후 승인 `categorySlug='food'`) → 공개범위(userB member: household
포함, 타인 private 제외, 타인 summary_only 가맹점 마스킹) → 월 요약 `totalNet`(목록 재계산과
일치, 정수) → 2차 중복 `duplicate_suspected` → 모든 금액 KRW 정수·netAmount 규약. 전부 통과 시
종료 코드 `0`, 하나라도 실패하면 첫 실패 지점에서 명확한 메시지와 함께 `1`로 종료한다. 로그에는
카드번호 원문·가맹점·secret·서명을 출력하지 않는다.
