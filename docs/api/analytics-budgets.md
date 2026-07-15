# 통계(Analytics) / 예산(Budgets) API 명세

> Phase 5 기준. 계약 스키마의 단일 소스는 `@family/contracts`(zod, `analytics.ts`/`budget.ts`)이며,
> 본 문서는 예시다. 모든 엔드포인트는 전역 prefix `v1`을 사용한다. 타임스탬프는 ISO 8601 문자열,
> **금액은 KRW 정수(원)**, 기간 경계는 `Asia/Seoul`다.
>
> 관련 설계: [ADR-0010 SQL 집계·예산](../adr/0010-analytics-sql-and-budgets.md) ·
> [ADR-0009 거래 모델·승격](../adr/0009-transaction-model-and-promotion.md) ·
> [Phase 5 빌드 스펙](../phase5-build-spec.md) · [거래 API](./transactions.md)

## 개요

Phase 5는 정규화 거래(`card_transactions`)를 **읽기 전용 집계**(통계)와 **예산 사용률**로
확장한다. 집계는 전부 drizzle SQL(`sum`/`count`/`group by`)로 수행하며 LLM/JS 루프 합산을
쓰지 않는다.

| 도메인 | 컨트롤러 | 인증 | 쓰임 |
|---|---|---|---|
| 통계 | `Controller('analytics')` | JWT Access Token | 월/카테고리/구성원/카드/가맹점 순지출 |
| 예산 | `Controller('budgets')` | JWT Access Token | 예산 CRUD + 현재월 사용률 |

핵심 규약(자세한 근거는 ADR-0010):

- **순지출 = `sum(netAmount) WHERE transactionType='approval'`** — 취소가 이미 반영되어
  이중계상이 없다.
- **공개범위(actor 기준)**: 집계 대상 = 본인 ∪ `household` ∪ `summary_only`(타인 금액도 포함),
  타인 `private`는 제외. `merchants`만 타인 `summary_only` 가맹점명을 `'(비공개)'`로 묶는다.
- **기간**: `month=YYYY-MM`(기본 이번달, Asia/Seoul) 또는 `from`/`to`(ISO). 집계는 `approvedAt` 기준.
- **예산 사용률**: 현재월 스코프 순지출 / `amount`. CRUD는 owner/admin, 조회는 멤버(PRD §7.2).
- 비멤버는 존재 여부를 노출하지 않는 **403**. 응답/로그에 카드번호·PII·secret을 남기지 않는다.

---

## 1. 통계 — `Controller('analytics')`

| 메서드 · 경로 | 성공 | 설명 |
|---|---|---|
| `GET /v1/analytics/monthly?householdId=…` | `200` | 순지출 + 전월(직전 동기간) 대비 |
| `GET /v1/analytics/categories?householdId=…` | `200` | 카테고리별 순지출 |
| `GET /v1/analytics/members?householdId=…` | `200` | 구성원별 순지출 |
| `GET /v1/analytics/cards?householdId=…` | `200` | 카드별 순지출 |
| `GET /v1/analytics/merchants?householdId=…` | `200` | 가맹점별 순지출(상위 20) |

공통 쿼리: `householdId`(필수), 기간은 `month=YYYY-MM` **또는** `from`/`to`(ISO, 함께 제공).
둘 다 없으면 이번달(Asia/Seoul).

### 공통 응답 메타 (`analyticsMetaSchema`)

```json
{
  "period": { "from": "2026-07-01T00:00:00.000Z", "to": "2026-08-01T00:00:00.000Z", "timezone": "Asia/Seoul" },
  "cancellationApplied": true,
  "includedMemberIds": ["<memberId-A>", "<memberId-B>"],
  "excludedByPermission": 1
}
```

| 필드 | 의미 |
|---|---|
| `period` | 집계 창(반개구간 `[from, to)`)과 timezone(`Asia/Seoul`). |
| `cancellationApplied` | 항상 `true` — 순지출에 취소가 이미 반영됨. |
| `includedMemberIds` | 금액이 집계된 구성원 id 목록(본인 ∪ household ∪ summary_only). |
| `excludedByPermission` | 공개범위로 **제외된 타인 `private` 승인 건수**. |

### `GET /v1/analytics/monthly` (`monthlyAnalyticsSchema`)

```json
{
  "meta": { "...": "위 메타" },
  "totalNet": 148000,
  "totalApproved": 160000,
  "totalCancelled": 12000,
  "transactionCount": 5,
  "previousNet": 120000,
  "deltaNet": 28000,
  "deltaRate": 0.2333333333333333
}
```

| 필드 | 규칙 |
|---|---|
| `totalNet` | 승인 `netAmount` 합(취소 반영). `= totalApproved - totalCancelled`. |
| `totalApproved` / `totalCancelled` | 승인 `amount` 합 / `cancelledAmount` 합. |
| `transactionCount` | 창 내 공개범위 승인 건수. |
| `previousNet` | 직전 동기간(같은 길이 이전 창) 순지출. |
| `deltaNet` | `totalNet - previousNet`. |
| `deltaRate` | `deltaNet / previousNet`. `previousNet=0`이면 **`null`**. |

### `GET /v1/analytics/categories` (`categoryBreakdownSchema`)

```json
{
  "meta": { "...": "메타" },
  "items": [
    { "categoryId": "…", "categorySlug": "shopping", "categoryName": "쇼핑", "net": 90000, "ratio": 0.6081, "count": 2 },
    { "categoryId": "…", "categorySlug": "medical",  "categoryName": "의료", "net": 25000, "ratio": 0.1689, "count": 1 },
    { "categoryId": "…", "categorySlug": "cafe",     "categoryName": "카페", "net": 18000, "ratio": 0.1216, "count": 1 },
    { "categoryId": "…", "categorySlug": "food",     "categoryName": "식비", "net": 15000, "ratio": 0.1013, "count": 1 }
  ]
}
```

- `ratio = net / totalNet`, `items`의 `net` 합 `= totalNet`, `ratio` 합 `≈ 1`.
- 미분류(null 카테고리)는 `categoryId=null`, `categoryName='미분류'`로 묶인다.

### `GET /v1/analytics/members` (`memberBreakdownSchema`)

```json
{
  "meta": { "...": "메타" },
  "items": [
    { "memberId": "…", "name": "엄마", "net": 133000, "ratio": 0.8986, "count": 4 },
    { "memberId": "…", "name": "아빠", "net": 15000,  "ratio": 0.1013, "count": 1 }
  ]
}
```

### `GET /v1/analytics/cards` (`cardBreakdownSchema`)

```json
{
  "meta": { "...": "메타" },
  "items": [
    { "cardId": "…", "alias": "우리집 신한카드", "issuer": "신한카드", "net": 68000, "ratio": 0.4594, "count": 2 },
    { "cardId": null, "alias": "미연결", "issuer": null, "net": 0, "ratio": 0, "count": 0 }
  ]
}
```

- 카드 미연결 거래는 `cardId=null`, `alias='미연결'`, `issuer=null`로 묶인다.

### `GET /v1/analytics/merchants` (`merchantBreakdownSchema`)

```json
{
  "meta": { "...": "메타" },
  "items": [
    { "merchant": "이마트", "net": 50000, "ratio": 0.4310, "count": 1 },
    { "merchant": "(비공개)", "net": 25000, "ratio": 0.2155, "count": 1 },
    { "merchant": "스타벅스", "net": 18000, "ratio": 0.1551, "count": 1 }
  ]
}
```

- `merchantNormalized` 기준 group by, 순지출 상위 20건.
- **타인 `summary_only`** 가맹점은 `'(비공개)'`로, 미확인 가맹점은 `'미확인 가맹점'`으로 묶인다
  (금액은 포함, 가맹점명만 마스킹).

---

## 2. 예산 — `Controller('budgets')`

| 메서드 · 경로 | 성공 | 권한 | 설명 |
|---|---|---|---|
| `GET /v1/budgets?householdId=&month=` | `200` | 활성 멤버 | 예산 목록 + 현재월 사용률 |
| `POST /v1/budgets` | `201` | owner/admin | 예산 생성 |
| `PATCH /v1/budgets/:id` | `200` | owner/admin | name/amount 수정 |
| `DELETE /v1/budgets/:id` | `204` | owner/admin | 예산 삭제 |

- 스코프: `scopeType ∈ {household, member, category, card}`, `period='monthly'`.
- `household`는 `scopeRefId` 없음(전체), 그 외는 해당 member/category/card id가 가족 소속이어야 함.
- `(householdId, scopeType, scopeRefId)`는 유일 — 중복 시 **409**.

### `POST /v1/budgets` (`budgetCreateRequestSchema`)

```json
{
  "householdId": "3c2d…",
  "name": "가족 월 예산",
  "scopeType": "household",
  "amount": 3000000
}
```

카테고리 예산 예: `{ "householdId": "…", "name": "쇼핑 예산", "scopeType": "category", "scopeRefId": "<categoryId>", "amount": 100000 }`

| 필드 | 규칙 |
|---|---|
| `householdId` | 필수(uuid). 요청자는 이 가족의 **owner/admin**이어야 함(아니면 `403`). |
| `name` | 선택(최대 100자). |
| `scopeType` | `household`/`member`/`category`/`card`. |
| `scopeRefId` | `household`는 생략. 그 외 필수(uuid, 가족 소속 검증). |
| `amount` | **양의 KRW 정수**. |

### 응답 (`budgetSummarySchema`)

```json
{
  "id": "…",
  "householdId": "3c2d…",
  "name": "가족 월 예산",
  "scopeType": "household",
  "scopeRefId": null,
  "scopeLabel": "가족 전체",
  "amount": 3000000,
  "spent": 148000,
  "remaining": 2852000,
  "usageRate": 0.04933333333333333,
  "period": "monthly",
  "currency": "KRW"
}
```

| 필드 | 규칙 |
|---|---|
| `spent` | **현재월** 스코프 순지출(`sum(netAmount)` 승인, 공개범위 반영, actor 기준). |
| `remaining` | `amount - spent`. |
| `usageRate` | `spent / amount`(amount=0이면 0). |
| `scopeLabel` | '가족 전체' / 구성원명 / 카테고리명 / 카드별칭. |

> `household` 예산의 `spent`는 같은 달 `GET /v1/analytics/monthly`(같은 요청자)의 `totalNet`과
> **정의상 동일**하다.

### `GET /v1/budgets?householdId=&month=` (`budgetListResponseSchema`)

```json
{
  "items": [ { "…": "budgetSummary" } ],
  "month": "2026-07"
}
```

- `month`(선택, `YYYY-MM`)로 회계월을 이동. 생략 시 이번달(Asia/Seoul). 사용률은 그 달 기준 재계산.

### `PATCH /v1/budgets/:id` (`budgetUpdateRequestSchema`)

```json
{ "name": "가족 월 예산(상향)", "amount": 3500000 }
```

- `name`/`amount`만 수정 가능(스코프는 불변 — 변경하려면 삭제 후 재생성). owner/admin만. 응답은
  갱신된 `budgetSummary`.

### `DELETE /v1/budgets/:id`

- 성공 시 `204 No Content`. owner/admin만.

---

## 3. 상태 코드 요약

| 상황 | 코드 |
|---|---|
| 정상 조회/수정 | `200` |
| 예산 생성 | `201` |
| 예산 삭제 | `204` |
| `householdId` 누락/`month` 형식 오류/`amount` 비정수·비양수/`scopeRefId` 불일치 | `400` |
| 미인증(access token 없음/만료) | `401` |
| 비멤버 조회 / member 의 예산 CRUD | `403` |
| 예산 미존재(PATCH/DELETE) | `404` |
| `(householdId, scopeType, scopeRefId)` 중복 | `409` |

## 4. 웹 연동(CORS/인증)

- api는 `enableCors({ origin: CORS_ORIGIN, credentials: true })`(와일드카드 금지, 기본
  `http://localhost:3000`). 웹은 모든 fetch를 `credentials:'include'`로 보낸다.
- access token은 메모리(React context), refresh는 HttpOnly 쿠키. `401 → refresh 1회 재시도 →
  재실패 시 로그인 이동`. 근거는 [ADR-0010 §5](../adr/0010-analytics-sql-and-budgets.md).
