/* ---------------------------------------------------------------------------
 * 집계 → 거래 목록 딥링크 (C-7 "숫자 다음의 행동")
 *
 * 거래 화면은 이미 `month`/`memberId`/`cardId`/`categoryId`/`q`를 초기 필터로 읽는다
 * (transactions/page.tsx). 홈·예산의 집계 행이 그 파라미터를 그대로 만들어 주면
 * "식비 412,000원" → 내역 확인이 4번 조작에서 1번이 된다. 새 백엔드가 필요 없다.
 * ------------------------------------------------------------------------- */
import type { BudgetScopeType } from "@family/contracts";

/** 거래 화면이 초기 필터로 읽는 파라미터(빈 값은 링크에서 뺀다). */
export interface TransactionFilterLink {
  /** `YYYY-MM`. 홈에서 보고 있던 달을 그대로 넘긴다. */
  month?: string;
  memberId?: string;
  cardId?: string;
  categoryId?: string;
  /** 가맹점처럼 전용 필터가 없는 축은 검색어로 넘긴다. */
  q?: string;
}

/** 필터가 걸린 거래 목록 경로. 값이 하나도 없으면 필터 없는 `/transactions`. */
export function transactionsHref(filter: TransactionFilterLink): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/transactions?${qs}` : "/transactions";
}

/**
 * 예산 스코프 → 그 예산이 집계하는 거래 목록 경로.
 *
 * `household` 예산은 축이 없으므로 달만 건다. 대상이 있어야 하는 스코프인데
 * `scopeRefId`가 없으면(데이터 이상) 필터 없이 보내지 않고 `null`을 돌려
 * 호출부가 링크 자체를 만들지 않게 한다 — 엉뚱한 전체 목록으로 보내는 것보다
 * 링크가 없는 편이 낫다.
 */
export function budgetTransactionsHref(
  scopeType: BudgetScopeType,
  scopeRefId: string | null,
  month: string,
): string | null {
  if (scopeType === "household") return transactionsHref({ month });
  if (!scopeRefId) return null;
  const key =
    scopeType === "member"
      ? "memberId"
      : scopeType === "category"
        ? "categoryId"
        : "cardId";
  return transactionsHref({ month, [key]: scopeRefId });
}
