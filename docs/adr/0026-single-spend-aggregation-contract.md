# ADR-0026: 지출 합계의 단일 정의 — 기간 창 헬퍼 + 월 단위 회고

## 제목

"이번 달 얼마 썼나"의 답이 경로마다 달라질 수 있었다. 지출 집계 조건을
`@family/database`의 헬퍼로 모아 **하나의 정의**로 못 박고, 그 위에 과거월을 조회하는
월 스위처를 올린다. 함께 결정한 것: `pending_review`/`duplicate_suspected`는 합계에
**포함**한다.

## 상태

2026-08-06 설계·구현 완료. 마이그레이션 없음(스키마 무변경). 신규 엔드포인트
`GET /v1/analytics/months` 1개.

## 배경

### 1. 데이터의 70%가 화면 밖에 있었다

`apps/web/src/app/(app)/dashboard/page.tsx`가 `currentMonth()`를 하드코딩해, 홈은 항상
이번 달만 보여줬다. 예산 화면도 `useBudgets()`에 month를 넘기지 않아 과거월 달성률을
볼 수 없었다.

프로덕션 실측(2026-08-06, `card_transactions` 104행, household 1개). 앱이 화면에
표시하는 정의(= 자산이동 제외) 기준:

| 달 | 건수 | 순지출 | 앱에서 조회 |
| --- | --- | --- | --- |
| 2026-03 | 2 | 1,338원 | 불가 |
| 2026-07 | 63 | **812,414원** | 불가 |
| 2026-08 (6일까지) | 28 | 411,089원 | 가능 |

누적 승인 지출 1,224,841원의 **약 2/3**가 어떤 화면에서도 열리지 않았다.
(자산이동을 포함하면 2026-07은 922,414원/66건이다 — ADR-0025로 제외한 ATM 인출 50,000원과
티머니 충전 30,000원×2가 그 달에 있다. 이 ADR의 모든 숫자는 화면 표시 정의를 따른다.)

`budgets` 3건은 전부 2026-07-19에 만든 뒤 **수정 0회** — 예산을 조정할 근거(지난달
실지출)를 앱이 보여주지 않았으므로 당연한 결과다.

서버는 이미 준비돼 있었다. `analytics/{monthly,categories,members,cards,merchants}`
5종이 `month|from&to`를 받고, `budgetListQuerySchema`에 `month`가 있고,
`apps/web/src/lib/queries.ts`의 훅 6개가 전부 `month?`를 받는다. 빠진 것은 UI 배선뿐이었다.

### 2. 회고를 열면 정의 불일치가 드러난다

과거월을 열 수 있게 되면 사용자는 숫자를 나란히 놓고 본다. 그런데 지출 합계의 기간
조건이 갈려 있었다:

| 지점 | 기간 조건 |
| --- | --- |
| `analytics.service.ts` `periodWindow` | `approvedAt` 창 **OR** `approvedAt IS NULL → createdAt` 창 |
| `budget.service.ts` `computeSpent` | `approvedAt` strict |
| `transaction.service.ts` `summary` | `approvedAt` strict |
| `transaction-promotion.service.ts` `budgetScopeSpent` | `approvedAt` strict |
| `notification-scheduler.service.ts` 주간요약 | `approvedAt` strict |
| `finance-ai.service.ts` 이상지출 | `approvedAt` strict + **`notTransferCategory()` 누락** |

`NULL >= from`은 항상 false다. 즉 승인시각을 문자에서 뽑지 못한 거래는 strict 쪽에서
**통째로 사라진다**. 방향이 과소집계라는 점이 특히 나쁘다 — 총액이 작게 나오면 사용자가
이상함을 알아채기 어렵다.

**현재 데이터에는 이 왜곡이 없다.** 실측 `approved_at IS NULL`은 cancellation 1건뿐이고,
그 타입은 `transactionType='approval'` 조건에서 이미 빠진다. 2026-07·2026-08 모두 strict
창과 관대한 창의 합계가 동일하다(각 812,414원/63건, 411,089원/28건). 즉 이 통일은
**지금 숫자를 바꾸지 않는다**(무회귀).

그런데도 지금 고치는 이유는 발현이 시간 문제이기 때문이다. 날짜가 없는 카드 문자는
`parse_failed`가 아니라 **정상 파싱된다** — `신한카드(1234)승인 / 5,000원 일시불 / 스타벅스`는
`transactionType='approval'`, `amount=5000`, `occurredAt=undefined`, confidence 80으로
승격된다(경고는 `timestamp not found` 하나). 그런 거래가 한 건이라도 들어오는 순간,
홈은 그 금액을 포함하고 예산 사용률과 주간 요약은 제외하는 상태가 된다. 회고 화면은
사용자가 숫자를 나란히 놓는 곳이므로 그 불일치가 바로 드러난다.

`finance-ai`의 `notTransferCategory()` 누락은 이와 달리 **실데이터로 발현 가능한 상태**였다. 이상지출 판정의
분모(월 평균 = `totalNet/transactionCount`)는 analytics 집계에서 오므로 자산이동이
빠져 있는데, 분자(최고액 단건)는 자산이동을 포함했다. ATM 인출·티머니 충전 14만원이
총액에서는 빠지고 "평소보다 큰 지출" 문장으로는 등장할 수 있었다.

`packages/database/src/query-helpers.ts`의 `notTransferCategory()`는 이미
"누락 방지용 단일 정의"라는 목적으로 존재했지만, **기간 창과 status는 그 규약 밖**에
있었다.

## 결정

### 1. 기간 창을 헬퍼로 승격하고, 관대한 쪽으로 통일한다

`spendPeriodWindow(from, to)`를 `@family/database`에 추가하고 집계 7지점이 모두 쓴다.
정의는 analytics가 쓰던 관대한 창이다:

```
(approvedAt >= from AND approvedAt < to)
OR (approvedAt IS NULL AND createdAt >= from AND createdAt < to)
```

**관대한 쪽을 고른 이유**: 두 정의 중 하나를 골라야 하고, strict는 과소집계고 관대한
쪽은 "승인시각을 모르는 거래를 수신 시각으로 잡는" 근사다. 근사는 사용자가 거래 상세에서
날짜를 고쳐 바로잡을 수 있지만, 사라진 거래는 존재 자체가 보이지 않는다.

COALESCE를 SQL 표현식으로 쓰지 않고 컬럼 기반 OR로 표현한다 — drizzle에서 Date를
표현식에 보간하면 바인딩이 깨진다(ADR-0023에서 겪은 것과 같은 계열의 문제).

### 2. 지출 합계의 단일 정의를 문서화한다

```
transactionType = 'approval'
AND excludedAt IS NULL
AND notTransferCategory()
AND currency = <집계 통화>       -- analytics/요약은 'KRW', 예산은 budget.currency
AND spendPeriodWindow(from, to)
AND <공개범위 스코프>             -- 예산 알림은 뷰어가 없어 미적용
```

새 집계 지점을 추가할 때는 `packages/database/src/query-helpers.ts`의 헬퍼를 경유한다.
grep 한 번으로 적용 여부를 확인할 수 있다는 것이 이 규약의 전부다.

### 3. `pending_review`와 `duplicate_suspected`는 합계에 **포함**한다

이번 작업에서 `notDuplicateSuspected()` 헬퍼를 추가하는 방안을 검토했고 **기각**했다.

`duplicate_suspected`는 판정이 아니라 **검토 플래그**다. 자동으로 합계에서 빼면 오탐일 때
실제 지출이 조용히 사라진다. 이는 2026-07-17에 '중복 제외' 기능을 만들 때 이미 내린
결정과 같다 — 그때도 자동 숨김을 피하고 **사용자가 `excludedAt`으로 확정**하는 경로를
택했다(A안). 같은 이유가 여기서도 성립한다.

실측 기준으로는 어느 쪽이든 차이가 없다 — `duplicate_suspected` 2건은 이미 `excluded_at`
처리됐으므로 두 정의 모두 합계에서 빠진다. 차이가 없을 때 더 안전한 정의를 고정해 두는
것이 이 결정의 목적이다.

`pending_review`도 같다 — "확인이 필요하다"는 것이 "쓰지 않았다"는 뜻은 아니다.

### 4. 월 목록은 별도 엔드포인트로 내려준다

`GET /v1/analytics/months?householdId=` — 거래가 있는 달과 그 달 순지출·건수를
오름차순으로 준다. 버킷 키는 `to_char(coalesce(approved_at, created_at) at time zone
'Asia/Seoul', 'YYYY-MM')`으로 `spendPeriodWindow`의 규칙과 일치시킨다(다른 규칙을 쓰면
스위처에는 보이는데 열면 0원인 달이 생긴다).

**왜 필요한가**: 실측 데이터는 2026-03과 2026-07 사이 4개월이 비어 있다. 스위처가 단순히
`addMonths(-1)`로 움직이면 사용자가 빈 화면을 네 번 지나야 한다. 이동을 이 목록 안으로
제한해 건너뛴다.

집계 조건은 `periodApprovalConditions`에서 기간만 제거한 `approvalConditions`를 공유하므로,
목록이 말하는 net은 그 달을 실제로 열었을 때의 `monthly.totalNet`과 같은 값이다.

### 5. 과거월 예산은 읽기 전용이다

과거월에서 예산 CRUD를 숨긴다. 예산액을 지금 바꾸면 그 달 달성률이 소급해 달라지는데,
그건 기록이 아니라 조작이다. 대신 현재월 수정 다이얼로그에 **지난달 실지출**을 보조
문구로 보여준다(자동 입력은 하지 않는다 — "지난달만큼 쓰겠다"가 사용자의 의도라는 근거가
없다).

## 트레이드오프와 대안

| 대안 | 기각 이유 |
| --- | --- |
| 합계 해부 화면(`/analytics/monthly/breakdown`) | 고치려는 왜곡의 실측 총합이 3건이다. 아무도 요청하지 않은 회계 시트를 위해 새 API 표면을 늘릴 이유가 없다 |
| strict 창으로 통일 | 과소집계 방향. 승인시각 미파싱 거래가 합계에서 사라지고, 사라진 것은 보이지 않는다 |
| `duplicate_suspected` 자동 제외 | 오탐 시 지출이 숨는다(위 §3) |
| 다월 추세 차트·임의 기간 UI | 거래 103건 규모에서 월 스위처가 답하는 질문과 겹친다. 스위처를 실제로 쓰는지(성공지표) 본 뒤에 판단한다 |
| 파서 `supports()` 게이트 수정(신한/KB) | 발현 경로가 없다(이벤트 0건·카드 미등록). 게이트를 조이다 정상 승인 문자를 `parse_failed`로 떨어뜨리면 반대 방향 실패가 생긴다. **회귀 테스트만** 추가하고 착수는 카드 등록 시점으로 미룬다 |
| 월 상태를 URL에 싣지 않기 | 새로고침·공유·알림 딥링크가 화면을 재현하지 못한다. 홈은 `?month=`로 URL이 상태를 소유하게 했다(예산 화면은 딥링크가 없어 로컬 상태) |

## 검증

`scripts/verify-monthly-review.mjs`:

1. `analytics/months`가 거래 있는 달만 오름차순 + net/count 일치
2. 같은 달 총액이 **3경로 일치**(analytics/monthly · transactions/summary · budgets spent)
3. 승인시각 미파싱 거래가 3경로 **모두**에 잡힘 ← 이번 변경의 핵심 인수 조건
4. 자산이동이 3경로·월목록·AI 이상지출에서 빠짐
5. `duplicate_suspected`가 합계에 **포함**됨
6. 타 가족 `householdId` → 403/404

`packages/card-parsers/src/dispatch.test.ts`의 `describe('비카드 문자 배제')`가 실유입
토스뱅크 은행 출금 4건(원문 그대로)과 비카드 안내 4종이 approval로 승격되지 않음을 고정한다.
신한/KB 게이트는 `it.todo` + 실측 표로 남겼다(`KB국민카드 결제 예정 금액 1,200,000원`이
현재 코드에서 approval로 승격된다는 사실을 포함).

회귀: `verify-phase5`(analytics·budgets), `verify-phase4`(승격),
`verify-exclude-duplicate`(excludedAt 합계), `verify-ai-finance`(인사이트·질의),
`pnpm test`(card-parsers vitest).

**배포 전 무회귀 근거(2026-08-06, 프로덕션 읽기 전용 조회)**: 2026-07·2026-08 각각에 대해
strict 창과 관대한 창의 합계·건수가 동일함을 확인했다(812,414원/63건 · 411,089원/28건).
비-KRW 거래는 0건이고 approval 중 `approved_at IS NULL`은 0건이다. 따라서 헬퍼 치환의
기대 diff는 **0원**이며, 배포 후 이 두 값이 그대로여야 한다.

## 결과

- `pending_review`/`duplicate_suspected` 합계 포함이 **결정으로 고정**됐다. 이후 이 정의를
  바꾸려면 이 ADR을 supersede해야 한다.
- 새 집계 지점은 `query-helpers.ts`를 경유해야 한다. 우회하면 "같은 달, 다른 총액"이
  다시 생긴다.
- 성공지표로 **과거월 조회 로그**를 4주 관찰한다. 0이면 월 스위처 위에 아무것도 더 쌓지
  않는다(다월 차트·비교 화면은 그 관찰 뒤에 판단).

## 관련

- ADR-0025: 자산 이동 분리 — `notTransferCategory()`의 출처. 이 ADR은 그 헬퍼 규약을
  기간 창과 status까지 확장한다.
- ADR-0024: 결제 실패 가시성 — `declined`가 승격되지 않아 합계에 없는 이유.
- ADR-0010: analytics SQL·예산 — 세 경로의 원래 설계.
