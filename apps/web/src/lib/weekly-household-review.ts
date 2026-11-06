/* ---------------------------------------------------------------------------
 * 「주간 가계 돌아보기」 읽기 전용 화면용 순수 헬퍼.
 *
 * 금액·건수는 서버 집계(ADR-0026 / budgets / finance-quality / recurring upcoming)
 * 를 그대로 쓴다. 여기선 문구·필터·출처 라벨만 만든다. 된다/안 된다 판정·추정·쓰기
 * CTA는 두지 않는다.
 * ------------------------------------------------------------------------- */
import type {
  AnalyticsMeta,
  BudgetSummary,
  CategoryBreakdown,
  RecurringUpcomingItem,
  RecurringUpcomingResponse,
  TransactionSummary,
} from "@family/contracts";

/** 숫자에 붙는 기준 시각·출처. 블록마다 다를 수 있다. */
export interface NumberProvenance {
  readonly asOf: string;
  readonly source: string;
}

export const WEEKLY_REVIEW_SOURCES = {
  spend: "Transaction 집계",
  budget: "BudgetRule+Transaction",
  unclassified: "finance-quality (approval · categoryId IS NULL)",
  recurring: "recurring_series 관측",
} as const;

/** 합계에서 빠진 한 덩어리 — 건수와 사유를 같이 말한다. */
export interface ExclusionNote {
  readonly count: number;
  readonly reason: string;
}

/**
 * 주간 순지출 합계에서 빠진 건. analytics meta의 세 버킷을 그대로 풀어 쓴다.
 * 금액은 노출하지 않는 권한 제외분은 건수만.
 */
export function spendExclusionNotes(meta: AnalyticsMeta): ExclusionNote[] {
  const notes: ExclusionNote[] = [];
  if (meta.excludedManual.count > 0) {
    notes.push({
      count: meta.excludedManual.count,
      reason: "직접 합계에서 뺀 거래",
    });
  }
  if (meta.excludedTransfer.count > 0) {
    notes.push({
      count: meta.excludedTransfer.count,
      reason: "자산 이동(이체·충전 등)이라 지출이 아님",
    });
  }
  if (meta.excludedByPermission > 0) {
    notes.push({
      count: meta.excludedByPermission,
      reason: "다른 구성원의 비공개 거래",
    });
  }
  return notes;
}

/**
 * 카테고리별 합계 표에 넣을 행. categoryId가 있는 것만.
 * 전부 미분류이거나 비면 표를 생략한다(스펙).
 */
export function categorizedCategoryRows(
  breakdown: CategoryBreakdown | undefined,
): ReadonlyArray<{
  categoryId: string;
  categoryName: string;
  net: number;
  count: number;
}> {
  if (!breakdown) return [];
  return breakdown.items
    .filter(
      (item): item is typeof item & { categoryId: string } =>
        item.categoryId != null && item.net !== 0,
    )
    .map((item) => ({
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      net: item.net,
      count: item.count,
    }));
}

/** 예산 규칙이 없을 때 — 만들기/편집 CTA 없이 한 줄만. */
export function budgetEmptyText(): string {
  return "이번 달에 적용된 예산 규칙이 없어요.";
}

/**
 * 미분류가 있으면 카테고리·예산 소진이 실제보다 적게 잡힐 수 있다는 한계.
 * 예산 블록에 숨기지 않는다.
 */
export function unclassifiedBurnCaveat(uncategorizedCount: number): string | null {
  if (uncategorizedCount <= 0) return null;
  return `미분류 ${uncategorizedCount}건이 있어 카테고리 기준 지출·예산 소진이 실제보다 적게 보일 수 있어요.`;
}

/** 미분류 정보 블록 본문. 채우기·재분류 CTA 없음. */
export function unclassifiedInfoText(uncategorizedCount: number): string {
  if (uncategorizedCount <= 0) return "미분류 거래가 없어요.";
  return `미분류 거래 ${uncategorizedCount}건이 있어요. (승인·카테고리 없음)`;
}

/**
 * finance-quality 정의와 같은 미분류 후보 미리보기.
 * transactionType=approval AND categoryId IS NULL. etc·brand null·빈 merchant_raw는
 * 따로 세지 않는다(이미 categoryId 유무만 본다).
 */
export function unclassifiedPreviewRows(
  items: ReadonlyArray<TransactionSummary>,
  limit = 5,
): ReadonlyArray<TransactionSummary> {
  return items
    .filter(
      (txn) =>
        txn.transactionType === "approval" &&
        txn.categoryId === null &&
        txn.excludedAt == null,
    )
    .slice(0, limit);
}

/** 다가오는 정기지출이 없을 때. 가짜 구독·추정 행 금지. */
export function upcomingEmptyText(): string {
  return "예정 데이터 없음";
}

/**
 * 합계에서 빠진 정기지출. money_contract_version 미충족·외화.
 * 근거 카드 갈림(cardId null)은 금액 합계 제외가 아니라 예산 매칭용이라,
 * 행은 보이되 합계 제외 사유로는 넣지 않는다(upcoming-summary와 동일).
 */
export function recurringExclusionNotes(
  data: Pick<RecurringUpcomingResponse, "excludedCount" | "otherCurrencyCount">,
): ExclusionNote[] {
  const notes: ExclusionNote[] = [];
  if (data.excludedCount > 0) {
    notes.push({
      count: data.excludedCount,
      reason: "money_contract_version 미충족으로 금액을 예고할 수 없음",
    });
  }
  if (data.otherCurrencyCount > 0) {
    notes.push({
      count: data.otherCurrencyCount,
      reason: "외화라 KRW 합계에 넣지 않음",
    });
  }
  return notes;
}

/** 카드 문자가 구독을 잘 못 잡는 한계 — 짧은 안내. 가짜 행은 만들지 않는다. */
export function recurringObservationLimitText(): string {
  return "카드 문자로 잡힌 반복 결제만 보여요. 문자에 안 온 구독은 여기 없어요.";
}

/** 예산 사용률·남은 금액은 화면에서 다시 계산하지 않고 서버 값을 쓴다. */
export function budgetReadOnlyRows(
  items: ReadonlyArray<BudgetSummary>,
): ReadonlyArray<BudgetSummary> {
  return items;
}

/** 금액 예고 가능한 예정 행만 합계에 들어간다 — 목록 자체는 예정 데이터가 있는 전부. */
export function upcomingVisibleRows(
  items: ReadonlyArray<RecurringUpcomingItem>,
): ReadonlyArray<RecurringUpcomingItem> {
  return items;
}
