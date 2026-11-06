"use client";
/**
 * 「주간 가계 돌아보기」— 읽기 전용.
 *
 * 한 주 지출 · 예산 대비·소진 · 미분류 정보 · 다가오는 정기지출을 한 화면에 모은다.
 * 된다/안 된다 칸·판정 버튼·금액 제안·UpsertBudgetRule·Subscription·기관 동기화는 없다.
 * 숫자는 서버 집계를 그대로 쓰고, 블록마다 asOf(Asia/Seoul)·출처를 붙인다.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { BudgetScopeType } from "@family/contracts";

import {
  ErrorState,
  ListLoading,
  ListRow,
  Money,
  PageBackHeader,
  SectionHeader,
  UsageBar,
} from "@/components/widgets";
import { budgetDisplayName } from "@/app/(app)/budgets/budget-text";
import { useAuth } from "@/lib/auth-context";
import { currentMonth, formatAsOfSeoul, formatMonthDay, formatWon } from "@/lib/format";
import { thisWeekWindow } from "@/lib/home-insights";
import { useHousehold } from "@/lib/household-context";
import {
  useBudgets,
  useCategoriesRange,
  useCategoryList,
  useFinanceQuality,
  useMonthlyRange,
  useTransactions,
} from "@/lib/queries";
import {
  endOfMonthKst,
  fetchRecurringUpcoming,
  recurringUpcomingQueryKey,
} from "@/lib/recurring-api";
import {
  merchantLabel,
  transactionOccurredAt,
} from "@/lib/transaction-display";
import {
  budgetEmptyText,
  categorizedCategoryRows,
  recurringExclusionNotes,
  recurringObservationLimitText,
  spendExclusionNotes,
  unclassifiedBurnCaveat,
  unclassifiedInfoText,
  unclassifiedPreviewRows,
  upcomingEmptyText,
  WEEKLY_REVIEW_SOURCES,
} from "@/lib/weekly-household-review";

const SCOPE_TYPE_LABEL: Record<BudgetScopeType, string> = {
  household: "가족 전체",
  member: "구성원",
  category: "카테고리",
  card: "카드",
  card_group: "여러 카드 합산",
};

/** 기준 시각 + 출처. 신선도 배지·새로고침 버튼 없음. */
function ProvenanceLine({
  asOfIso,
  source,
}: {
  asOfIso: string | null | undefined;
  source: string;
}) {
  return (
    <p className="text-caption text-muted-foreground mt-1">
      기준 {formatAsOfSeoul(asOfIso)} · 출처 {source}
    </p>
  );
}

function ExclusionLines({
  notes,
}: {
  notes: ReadonlyArray<{ count: number; reason: string }>;
}) {
  if (notes.length === 0) return null;
  return (
    <ul className="text-caption text-muted-foreground mt-2 list-none space-y-0.5">
      {notes.map((note) => (
        <li key={`${note.count}-${note.reason}`}>
          합계에서 제외 {note.count}건 — {note.reason}
        </li>
      ))}
    </ul>
  );
}

export default function WeeklyHouseholdReviewPage() {
  const now = useMemo(() => new Date(), []);
  const week = useMemo(() => thisWeekWindow(now), [now]);
  const thisMonth = currentMonth();
  const { householdId } = useHousehold();
  const { authedFetch } = useAuth();

  const monthly = useMonthlyRange(week);
  const categories = useCategoriesRange(week);
  const transactions = useTransactions({
    from: week.from,
    to: week.to,
    type: "approval",
    limit: 50,
  });
  const budgets = useBudgets(thisMonth);
  const quality = useFinanceQuality();
  const categoryList = useCategoryList();

  const until = useMemo(() => endOfMonthKst(), []);
  const upcoming = useQuery({
    queryKey: recurringUpcomingQueryKey(householdId, until),
    enabled: householdId != null,
    queryFn: () =>
      authedFetch((token) =>
        fetchRecurringUpcoming(token, householdId as string, until),
      ),
  });

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categoryList.data ?? []) {
      map.set(cat.id, cat.name);
    }
    return map;
  }, [categoryList.data]);

  const spendAsOf = monthly.dataUpdatedAt
    ? new Date(monthly.dataUpdatedAt).toISOString()
    : null;
  const budgetAsOf = budgets.dataUpdatedAt
    ? new Date(budgets.dataUpdatedAt).toISOString()
    : null;
  const qualityAsOf = quality.data?.asOf ?? null;
  const upcomingAsOf = upcoming.dataUpdatedAt
    ? new Date(upcoming.dataUpdatedAt).toISOString()
    : null;

  const uncategorizedCount = quality.data?.transactions.uncategorized ?? 0;
  const burnCaveat = unclassifiedBurnCaveat(uncategorizedCount);
  const categoryRows = categorizedCategoryRows(categories.data);
  const spendNotes = monthly.data
    ? spendExclusionNotes(monthly.data.meta)
    : [];
  const recurringNotes = upcoming.data
    ? recurringExclusionNotes(upcoming.data)
    : [];
  const preview = unclassifiedPreviewRows(transactions.data?.items ?? []);
  const spendRows = (transactions.data?.items ?? []).filter(
    (txn) => txn.excludedAt == null,
  );

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-24 pt-3">
      <PageBackHeader
        title="주간 가계 돌아보기"
        subtitle={week.label}
        backHref="/more"
      />

      {/* 1. 한 주 지출 */}
      <section className="finance-panel min-w-0 px-5 pb-4 pt-2" aria-label="한 주 지출">
        <SectionHeader title="한 주 지출" />
        {monthly.isLoading ? (
          <ListLoading rows={3} />
        ) : monthly.isError || !monthly.data ? (
          <ErrorState
            message="이번 주 지출을 불러오지 못했어요"
            onRetry={() => void monthly.refetch()}
            align="start"
          />
        ) : (
          <>
            <p className="text-heading tabular-nums">
              {formatWon(monthly.data.totalNet)}
            </p>
            <p className="text-body text-muted-foreground mt-0.5">
              {monthly.data.transactionCount}건 · 승인·지출 순지출
            </p>
            <ProvenanceLine
              asOfIso={spendAsOf}
              source={WEEKLY_REVIEW_SOURCES.spend}
            />
            <ExclusionLines notes={spendNotes} />

            {categoryRows.length > 0 ? (
              <div className="mt-4 space-y-2">
                <h3 className="text-caption text-muted-foreground font-semibold">
                  카테고리별
                </h3>
                {categoryRows.map((row) => (
                  <div
                    key={row.categoryId}
                    className="text-body flex min-w-0 items-baseline justify-between gap-3"
                  >
                    <span className="min-w-0 truncate">{row.categoryName}</span>
                    <span className="shrink-0 tabular-nums">
                      {formatWon(row.net)}
                    </span>
                  </div>
                ))}
                <ProvenanceLine
                  asOfIso={
                    categories.dataUpdatedAt
                      ? new Date(categories.dataUpdatedAt).toISOString()
                      : spendAsOf
                  }
                  source={WEEKLY_REVIEW_SOURCES.spend}
                />
              </div>
            ) : null}

            <div className="mt-4">
              <h3 className="text-caption text-muted-foreground mb-1 font-semibold">
                지출 내역
              </h3>
              {transactions.isLoading ? (
                <ListLoading rows={4} />
              ) : spendRows.length === 0 ? (
                <p className="text-body text-muted-foreground">
                  이번 주 승인 지출이 없어요.
                </p>
              ) : (
                <ul className="divide-border/60 divide-y">
                  {spendRows.map((txn) => (
                    <li key={txn.id}>
                      <ListRow
                        title={merchantLabel(txn)}
                        subtitle={`${formatMonthDay(transactionOccurredAt(txn), now)} · ${
                          txn.categoryId
                            ? (categoryNameById.get(txn.categoryId) ?? "미분류")
                            : "미분류"
                        }`}
                        value={
                          <span className="tabular-nums">
                            <Money amount={txn.netAmount} currency={txn.currency} />
                          </span>
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
              {transactions.dataUpdatedAt ? (
                <ProvenanceLine
                  asOfIso={new Date(transactions.dataUpdatedAt).toISOString()}
                  source={WEEKLY_REVIEW_SOURCES.spend}
                />
              ) : null}
            </div>
          </>
        )}
      </section>

      {/* 2. 예산 대비·소진 — 읽기만. UpsertBudgetRule UI 없음. */}
      <section className="finance-panel min-w-0 px-5 pb-4 pt-2" aria-label="예산 대비 소진">
        <SectionHeader title="예산 대비·소진" />
        {budgets.isLoading ? (
          <ListLoading rows={3} />
        ) : budgets.isError ? (
          <ErrorState
            message="예산을 불러오지 못했어요"
            onRetry={() => void budgets.refetch()}
            align="start"
          />
        ) : (
          <div className="space-y-4">
            {burnCaveat ? (
              <p className="text-caption text-muted-foreground">{burnCaveat}</p>
            ) : null}
            {!budgets.data || budgets.data.items.length === 0 ? (
              <p className="text-body text-muted-foreground">{budgetEmptyText()}</p>
            ) : (
              budgets.data.items.map((budget) => (
                <div key={budget.id} className="min-w-0">
                  <UsageBar
                    label={budgetDisplayName(budget)}
                    spent={budget.spent}
                    amount={budget.amount}
                    currency={budget.currency}
                    usageRate={budget.usageRate}
                    meta={`${SCOPE_TYPE_LABEL[budget.scopeType]} · ${budget.scopeLabel} · 남은 ${formatWon(budget.remaining)}`}
                  />
                </div>
              ))
            )}
            {budgets.data && budgets.data.items.length > 0 ? (
              <ProvenanceLine
                asOfIso={budgetAsOf}
                source={WEEKLY_REVIEW_SOURCES.budget}
              />
            ) : null}
          </div>
        )}
      </section>

      {/* 3. 미분류 정보 — 정보만. 채우기·재분류 없음. */}
      <section className="finance-panel min-w-0 px-5 pb-4 pt-2" aria-label="미분류 정보">
        <SectionHeader title="미분류 정보" />
        {quality.isLoading ? (
          <ListLoading rows={2} />
        ) : quality.isError || !quality.data ? (
          <ErrorState
            message="미분류 정보를 불러오지 못했어요"
            onRetry={() => void quality.refetch()}
            align="start"
          />
        ) : (
          <>
            <p className="text-body">{unclassifiedInfoText(uncategorizedCount)}</p>
            <ProvenanceLine
              asOfIso={qualityAsOf}
              source={WEEKLY_REVIEW_SOURCES.unclassified}
            />
            {preview.length > 0 ? (
              <ul className="divide-border/60 mt-3 divide-y">
                {preview.map((txn) => (
                  <li key={txn.id}>
                    <ListRow
                      title={merchantLabel(txn)}
                      subtitle={formatMonthDay(transactionOccurredAt(txn), now)}
                      value={
                        <span className="tabular-nums">
                          <Money amount={txn.netAmount} currency={txn.currency} />
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>

      {/* 4. 다가오는 정기지출 — recurring_series 관측만. */}
      <section
        className="finance-panel min-w-0 px-5 pb-4 pt-2"
        aria-label="다가오는 정기지출"
      >
        <SectionHeader title="다가오는 정기지출" />
        {upcoming.isLoading ? (
          <ListLoading rows={3} />
        ) : upcoming.isError ? (
          <ErrorState
            message="정기지출 예정을 불러오지 못했어요"
            onRetry={() => void upcoming.refetch()}
            align="start"
          />
        ) : !upcoming.data?.enabled || upcoming.data.items.length === 0 ? (
          <p className="text-body text-muted-foreground">{upcomingEmptyText()}</p>
        ) : (
          <>
            {upcoming.data.forecastableCount > 0 ? (
              <p className="text-heading tabular-nums">
                <Money
                  amount={upcoming.data.totalAmount}
                  currency={upcoming.data.totalCurrency}
                />
              </p>
            ) : (
              <p className="text-body text-muted-foreground">
                금액을 예고할 수 있는 예정이 없어요.
              </p>
            )}
            <ProvenanceLine
              asOfIso={upcomingAsOf}
              source={WEEKLY_REVIEW_SOURCES.recurring}
            />
            <ExclusionLines notes={recurringNotes} />
            <ul className="divide-border/60 mt-3 divide-y">
              {upcoming.data.items.map((item) => (
                <li key={item.id}>
                  <ListRow
                    title={item.merchant}
                    subtitle={`${formatMonthDay(item.nextExpectedAt, now)}쯤${
                      item.nextExpectedWindowDays > 0
                        ? ` (${item.nextExpectedWindowDays}일 앞뒤)`
                        : ""
                    }`}
                    value={
                      item.amountForecastable ? (
                        <span className="tabular-nums">
                          <Money amount={item.amount} currency={item.currency} />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">금액 확인 전</span>
                      )
                    }
                  />
                </li>
              ))}
            </ul>
            <p className="text-caption text-muted-foreground mt-3">
              {recurringObservationLimitText()}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
