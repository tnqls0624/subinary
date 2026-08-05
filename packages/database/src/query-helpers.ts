/**
 * 지출 집계에서 반복되는 SQL 조건 — **누락 방지용 단일 정의**.
 *
 * 왜 헬퍼로 빼는가: `excludedAt`(중복 제외) 조건을 도입할 때 집계 지점마다 손으로
 * 조건을 넣었고, 그 뒤 "새 집계 지점을 추가하면 조건도 함께 넣어야 한다"는 규약이
 * 사람의 기억에 의존하게 됐다. 실제로 지출 집계 지점은 api/worker에 걸쳐 6곳이다
 * (analytics 초크포인트 · 권한제외 카운트 · budgets 사용률 · transactions 요약 ·
 * promotion 예산알림 · scheduler 주간요약). 조건을 이름 있는 함수로 만들어 두면
 * grep 한 번으로 적용 여부를 확인할 수 있다.
 */
import { sql, type SQL } from 'drizzle-orm';

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
