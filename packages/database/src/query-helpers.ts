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
import { and, gte, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

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
