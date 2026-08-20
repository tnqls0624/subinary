/**
 * 지출 집계에서 반복되는 SQL 조건 — **누락 방지용 단일 정의**.
 *
 * 왜 헬퍼로 빼는가: `excludedAt`(중복 제외) 조건을 도입할 때 집계 지점마다 손으로
 * 조건을 넣었고, 그 뒤 "새 집계 지점을 추가하면 조건도 함께 넣어야 한다"는 규약이
 * 사람의 기억에 의존하게 됐다. 실제로 지출 집계 지점은 api/worker에 걸쳐 7곳이다
 * (analytics 초크포인트 · 권한제외 카운트 · budgets 사용률 · transactions 요약 ·
 * promotion 예산알림 · scheduler 주간요약 · finance-ai 이상지출). 조건을 이름 있는
 * 함수로 만들어 두면 grep 한 번으로 적용 여부를 확인할 수 있다.
 *
 * 지출 합계의 단일 정의(ADR-0026): `transactionType='approval'` + `excludedAt IS NULL`
 * + {@link notTransferCategory} + 통화 일치 + {@link spendPeriodWindow}.
 * `pending_review`/`duplicate_suspected` status는 **합계에 포함**한다(검토 플래그일
 * 뿐이므로 자동 제외하면 과소집계가 된다).
 */
import { and, eq, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { cardTransactions } from './schema.js';

/**
 * 자산 이동(현금 인출·선불 충전) 카테고리 거래를 제외한다.
 *
 * 소비가 아니라 잔액을 옮긴 것이므로 지출 합계에 들어가면 총액이 부풀고, 충전한 잔액을
 * 실제로 쓸 때 다시 잡혀 이중 계상이 된다. 실측(2026-08): ATM 50,000 + 모바일티머니선불
 * 60,000 = 110,000원이 지출로 계상돼 있었다.
 *
 * `NOT EXISTS`인 이유: `categoryId`가 NULL(미분류)인 거래는 자산 이동이 아니므로 **남아야**
 * 한다. JOIN이나 `is_transfer = false` 비교로는 NULL 행이 조용히 탈락한다.
 *
 * 적용 대상은 **지출 합계**뿐이다. 거래 목록·가맹점 목록·검토 리마인더·라벨 후보에는
 * 넣지 않는다 — 자산 이동도 사용자가 보고 분류하고 별칭을 묶을 대상이다.
 */
export function notTransferCategory(): SQL {
  return sql`not exists (
    select 1
    from expense_categories ec
    where ec.id = ${cardTransactions.categoryId}
      and ec.is_transfer
  )`;
}

/**
 * {@link notTransferCategory}의 **정확한 여집합** — 자산 이동 카테고리 거래만.
 *
 * 용도는 하나다: 총액에서 자산 이동으로 빠진 금액을 **공시**하는 것. 지출 집계에
 * 쓰면 안 된다(그건 위 함수가 빼는 대상이다).
 *
 * 여집합을 여기에 함께 두는 이유: `is_transfer = true` 비교를 호출부에서 직접 쓰면
 * `categoryId IS NULL`(미분류)의 취급이 두 함수 사이에서 갈릴 수 있다. 같은
 * `EXISTS` 형태로 짝지어 두면 "미분류는 어느 쪽에도 들지 않는다"가 구조로 보장되고,
 * 두 카운트의 합이 모집단을 넘지 않는다.
 */
export function transferCategory(): SQL {
  return sql`exists (
    select 1
    from expense_categories ec
    where ec.id = ${cardTransactions.categoryId}
      and ec.is_transfer
  )`;
}

/**
 * 지출 집계의 기간 창 `[from, to)` — **승인시각 기준이되, 미파싱은 생성시각으로 구제**.
 *
 * 왜 헬퍼인가: 같은 달의 총액을 묻는 경로가 세 개(analytics/monthly ·
 * transactions/summary · budgets 사용률)인데 기간 조건이 갈려 있었다. analytics만
 * 이 관대한 창을 쓰고 나머지 5곳은 `approvedAt` strict 비교여서, **동일한 달에 대해
 * 서로 다른 총액**이 나올 수 있었다(ADR-0026).
 *
 * 왜 관대한 쪽으로 통일하는가: `approvedAt`이 NULL인 거래(문자에서 승인시각을 못
 * 뽑은 경우)는 `NULL >= from`이 항상 false라 strict 창에서 **통째로 사라진다**. 즉
 * strict 쪽은 과소집계고, 과소집계는 사용자가 알아채기 더 어려운 방향의 오류다.
 * 실측(2026-08) `approved_at IS NULL` 1건이 analytics에는 잡히고 예산·요약에는
 * 빠져 있었다.
 *
 * COALESCE를 SQL 표현식으로 쓰면 Date 바인딩이 깨지므로 컬럼 기반 OR로 표현한다.
 *
 * ⚠️ 여기에 status 조건(특히 `duplicate_suspected` 제외)을 넣지 마라. 중복 '의심'은
 * 검토 플래그일 뿐이고, 자동으로 합계에서 빼면 오탐일 때 지출이 조용히 숨는다.
 * 중복 확정은 사용자가 `excludedAt`으로 한다(ADR-0026 · 2026-07-17 결정).
 */
export function spendPeriodWindow(from: Date, to: Date): SQL {
  return or(
    and(
      gte(cardTransactions.approvedAt, from),
      lt(cardTransactions.approvedAt, to),
    ),
    and(
      isNull(cardTransactions.approvedAt),
      gte(cardTransactions.createdAt, from),
      lt(cardTransactions.createdAt, to),
    ),
  ) as SQL;
}

/**
 * 가려진 가맹점명 라벨 — 타인의 `summary_only` 거래를 한 버킷으로 모을 때 쓴다.
 *
 * analytics·finance-ai가 각자 문자열 리터럴을 들고 있으면 한쪽만 바뀌었을 때
 * 같은 개념이 두 이름으로 화면에 나온다. 라벨은 여기 한 곳에서만 정의한다.
 */
export const REDACTED_MERCHANT_LABEL = '(비공개)';

/**
 * 공개범위 WHERE 조각 — **집계 지점마다 반복되던 것을 단일 정의로 모은다**.
 *
 * 규칙(PRD §8/§16/§26): 본인 행 ∪ `visibility='household'` ∪ `visibility='summary_only'`.
 * 타인의 `private` 행은 제외한다(금액도 이름도 새어 나가면 안 된다). `summary_only`는
 * **금액은 포함하되 이름을 가린다** — 가맹점명을 드러내는 집계에서는 반드시
 * {@link redactedMerchantLabel}로 라벨을 덮어써야 한다.
 *
 * 왜 헬퍼인가: 이 조건이 analytics·budgets·transactions·finance-ai에 각각 복사돼
 * 있었고, 네 번째 집계 API(`/v1/merchants`)를 추가할 때 **통째로 누락**돼 타인의
 * private 거래 가맹점명·금액이 그대로 노출됐다(2026-08 발견). `notTransferCategory`와
 * 같은 이유로 이름 있는 함수로 두면 grep 한 번으로 적용 여부를 확인할 수 있다.
 */
export function visibilityScope(actorMemberId: string): SQL {
  return or(
    eq(cardTransactions.memberId, actorMemberId),
    inArray(cardTransactions.visibility, ['household', 'summary_only']),
  ) as SQL;
}

/**
 * 그룹핑 가능한 가맹점명 표현식 — 타인의 `summary_only` 행을
 * {@link REDACTED_MERCHANT_LABEL}로 접는다.
 *
 * `unknownLabel`은 `merchantNormalized`가 NULL일 때 쓸 라벨이다. NULL을 그대로 두면
 * GROUP BY 버킷이 하나 더 생기고 화면에 빈 이름이 나오므로 호출부가 자기 화면에 맞는
 * 라벨을 준다. NULL 행을 애초에 WHERE에서 거르는 호출부(가맹점 목록)는 생략해도 된다.
 *
 * ⚠️ 이 표현식을 GROUP BY에 다시 넘기지 마라 — 파라미터 placeholder가 새로 부여돼
 * SELECT 쪽 사본과 어긋난다. `groupBy(sql\`1\`)`처럼 **ordinal**로 묶어야 한다.
 */
export function redactedMerchantLabel(
  actorMemberId: string,
  unknownLabel?: string,
): SQL<string> {
  const unknownBranch = unknownLabel
    ? sql`when ${cardTransactions.merchantNormalized} is null then ${unknownLabel}`
    : sql``;
  return sql<string>`case
    when ${cardTransactions.memberId} <> ${actorMemberId}::uuid
      and ${cardTransactions.visibility} = 'summary_only'
      then ${REDACTED_MERCHANT_LABEL}
    ${unknownBranch}
    else ${cardTransactions.merchantNormalized}
  end`;
}

/**
 * 일괄 재분류가 **쓸 수 있는** 행의 범위.
 *
 * 읽기 스코프({@link visibilityScope})보다 좁다. 이유는 `summary_only`의 의미에 있다 —
 * 그 공개범위는 "얼마 썼는지는 합계에 넣되 **어디서 썼는지는 감춘다**"이다. 그런데
 * 가맹점 이름을 키로 남의 행을 UPDATE하면, 결과 건수만으로 "그 사람이 그 가맹점을
 * 썼다"가 드러난다. 감췄던 이름-존재 결합이 쓰기를 통해 되살아나는 것이다.
 *
 * 그래서 대상은 **내 거래 ∪ (권한자인 경우) 타인의 `household` 거래**로 한정한다.
 * 권한자에게도 타인 `summary_only`는 열지 않는다 — 목록·상세·집계 어디서도 owner를
 * 봐주지 않는 규약과 같은 선이다(`visibilityScope` 주석 참조).
 *
 * ⚠️ 이 조건은 {@link visibilityScope}를 **대체하지 않는다.** 둘 다 WHERE에 넣어야
 * 한다 — 이건 쓰기 상한이고 저건 하드 플로어다.
 */
export function mutableByActor(actorMemberId: string, privileged: boolean): SQL {
  if (!privileged) {
    return eq(cardTransactions.memberId, actorMemberId) as SQL;
  }
  return or(
    eq(cardTransactions.memberId, actorMemberId),
    eq(cardTransactions.visibility, 'household'),
  ) as SQL;
}
