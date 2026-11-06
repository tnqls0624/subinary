/**
 * 「주간 가계 돌아보기」읽기 전용 화면.
 * 네 블록·asOf/출처·빈 상태·금지 UI(판정·예산 편집·Subscription)를 잠근다.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BudgetListResponse,
  CategoryBreakdown,
  FinanceQuality,
  MonthlyAnalytics,
  RecurringUpcomingResponse,
  TransactionListResponse,
} from "@family/contracts";

import { endOfMonthKst, recurringUpcomingQueryKey } from "@/lib/recurring-api";

const HOUSEHOLD = "00000000-0000-4000-8000-000000000001";

const hooks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/ledger/weekly-review",
}));
vi.mock("@/lib/nav-history", () => ({
  canGoBackInApp: () => false,
  prepareColdEntryReplacement: () => undefined,
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ authedFetch: (fn: (t: string) => unknown) => fn("token") }),
}));
vi.mock("@/lib/household-context", () => ({
  useHousehold: () => ({ householdId: HOUSEHOLD }),
}));
vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const hook = (name: string) => () => hooks.state[name];
  return {
    ...actual,
    useMonthlyRange: hook("useMonthlyRange"),
    useCategoriesRange: hook("useCategoriesRange"),
    useTransactions: hook("useTransactions"),
    useBudgets: hook("useBudgets"),
    useFinanceQuality: hook("useFinanceQuality"),
    useCategoryList: hook("useCategoryList"),
  };
});

import WeeklyHouseholdReviewPage from "./page";

function ok<T>(data: T, dataUpdatedAt = Date.parse("2026-11-05T14:43:00+09:00")) {
  return {
    data,
    dataUpdatedAt,
    isLoading: false,
    isError: false,
    isSuccess: true,
    isFetching: false,
    refetch: vi.fn(),
  };
}

const meta: MonthlyAnalytics["meta"] = {
  period: {
    from: "2026-11-01T15:00:00.000Z",
    to: "2026-11-08T15:00:00.000Z",
    timezone: "Asia/Seoul",
  },
  cancellationApplied: true,
  includedMemberIds: [],
  excludedByPermission: 1,
  excludedManual: { count: 2, net: 3000 },
  excludedTransfer: { count: 0, net: 0 },
};

function defaults(): Record<string, unknown> {
  return {
    useMonthlyRange: ok<MonthlyAnalytics>({
      meta,
      totalNet: 42_000,
      totalApproved: 42_000,
      totalCancelled: 0,
      transactionCount: 3,
      previousNet: 0,
      deltaNet: 42_000,
      deltaRate: null,
    }),
    useCategoriesRange: ok<CategoryBreakdown>({
      meta,
      items: [
        {
          categoryId: null,
          categorySlug: null,
          categoryName: "미분류",
          net: 42_000,
          ratio: 1,
          count: 3,
        },
      ],
    }),
    useTransactions: ok<TransactionListResponse>({
      items: [
        {
          id: "t1",
          householdId: HOUSEHOLD,
          memberId: "m1",
          cardId: null,
          transactionType: "approval",
          status: "approved",
          amount: 12_000,
          cancelledAmount: 0,
          netAmount: 12_000,
          currency: "KRW",
          originalAmount: null,
          originalCurrency: null,
          exchangeRate: null,
          merchantRaw: "편의점",
          merchantNormalized: "편의점",
          categoryId: null,
          categorySlug: null,
          approvedAt: "2026-11-03T01:00:00.000Z",
          cancelledAt: null,
          installmentMonths: null,
          parentTransactionId: null,
          visibility: "household",
          memo: null,
          masked: false,
          excludedAt: null,
          createdAt: "2026-11-03T01:00:00.000Z",
        },
      ],
      nextCursor: null,
    }),
    useBudgets: ok<BudgetListResponse>({ items: [], month: "2026-11" }),
    useFinanceQuality: ok<FinanceQuality>({
      asOf: "2026-11-05T05:43:00.000Z",
      scope: {
        period: "all_time",
        transactions: "visible_non_excluded",
        sms: "own_member",
      },
      transactions: {
        uncategorized: 4,
        duplicateSuspected: 0,
        unlinkedCancellations: 0,
        cardOwnerMismatches: 0,
      },
      sms: {
        pending: 0,
        parseFailed: 0,
        pendingReview: 0,
        quarantined: 0,
        ignored: 0,
        lastReceivedAt: null,
      },
    }),
    useCategoryList: ok([]),
  };
}

function render(overrides: Record<string, unknown> = {}): string {
  hooks.state = { ...defaults(), ...overrides };
  const client = new QueryClient();
  client.setQueryData<RecurringUpcomingResponse>(
    recurringUpcomingQueryKey(HOUSEHOLD, endOfMonthKst()),
    {
      enabled: true,
      until: endOfMonthKst(),
      items: [],
      totalAmount: 0,
      totalCurrency: "KRW",
      forecastableCount: 0,
      excludedCount: 0,
      otherCurrencyCount: 0,
    },
  );
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(WeeklyHouseholdReviewPage),
    ),
  );
}

beforeEach(() => {
  hooks.state = defaults();
});

describe("주간 가계 돌아보기", () => {
  it("네 블록이 한 화면에 있고 판정·편집 UI가 없다", () => {
    const html = render();
    expect(html).toContain("주간 가계 돌아보기");
    expect(html).toContain("한 주 지출");
    expect(html).toContain("예산 대비·소진");
    expect(html).toContain("미분류 정보");
    expect(html).toContain("다가오는 정기지출");
    expect(html).not.toMatch(/된다|안 된다|애매/);
    expect(html).not.toContain("예산 만들기");
    expect(html).not.toContain("지금 써도 되나");
    expect(html).not.toContain("Subscription");
    // SnapshotBalances용 신선도 배지·전용 새로고침은 없다(불러오기 실패 재시도는 ErrorState).
    expect(html).not.toContain("신선");
  });

  it("보이는 숫자마다 asOf와 출처를 붙이고 스펙 예시 금액을 고정하지 않는다", () => {
    const html = render();
    expect(html).toContain("42,000원");
    expect(html).toContain("2026-11-05 14:43 Asia/Seoul");
    expect(html).toContain("출처 Transaction 집계");
    expect(html).toContain("출처 finance-quality");
    expect(html).toContain("미분류 거래 4건");
    expect(html).toContain("2026-11-05 14:43 Asia/Seoul");
    expect(html).not.toContain("169,610");
    expect(html).not.toContain("OPENAI");
  });

  it("합계 제외·카테고리 표 생략·예산 없음·예정 없음·미분류 소진 한계를 스펙대로 처리한다", () => {
    const html = render();
    expect(html).toContain("합계에서 제외 2건 — 직접 합계에서 뺀 거래");
    expect(html).toContain("합계에서 제외 1건 — 다른 구성원의 비공개 거래");
    // 전부 미분류면 카테고리 표를 생략한다.
    expect(html).not.toContain("카테고리별");
    expect(html).toContain("이번 달에 적용된 예산 규칙이 없어요.");
    expect(html).toContain("예정 데이터 없음");
    expect(html).toContain("미분류 4건이 있어");
    expect(html).toContain("적게 보일 수 있어요");
  });

  it("정기지출 제외 사유와 관측 한계를 보여 주고 가짜 구독 행은 만들지 않는다", () => {
    const clientHtml = (() => {
      hooks.state = {
        ...defaults(),
        useFinanceQuality: ok<FinanceQuality>({
          asOf: "2026-11-05T05:43:00.000Z",
          scope: {
            period: "all_time",
            transactions: "visible_non_excluded",
            sms: "own_member",
          },
          transactions: {
            uncategorized: 0,
            duplicateSuspected: 0,
            unlinkedCancellations: 0,
            cardOwnerMismatches: 0,
          },
          sms: {
            pending: 0,
            parseFailed: 0,
            pendingReview: 0,
            quarantined: 0,
            ignored: 0,
            lastReceivedAt: null,
          },
        }),
      };
      const client = new QueryClient();
      client.setQueryData<RecurringUpcomingResponse>(
        recurringUpcomingQueryKey(HOUSEHOLD, endOfMonthKst()),
        {
          enabled: true,
          until: endOfMonthKst(),
          items: [
            {
              id: "s1",
              merchant: "관측된구독",
              amount: 9_900,
              amountMin: 9_900,
              amountMax: 9_900,
              currency: "KRW",
              cadence: "monthly",
              nextExpectedAt: "2026-11-20T01:00:00.000Z",
              nextExpectedWindowDays: 3,
              nextExpectedPhase: "upcoming",
              overdueDays: 0,
              mine: true,
              amountForecastable: false,
              amountVaries: false,
              cardId: null,
            },
          ],
          totalAmount: 0,
          totalCurrency: "KRW",
          forecastableCount: 0,
          excludedCount: 1,
          otherCurrencyCount: 0,
        },
      );
      return renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(WeeklyHouseholdReviewPage),
        ),
      );
    })();
    expect(clientHtml).toContain("관측된구독");
    expect(clientHtml).toContain("금액 확인 전");
    expect(clientHtml).toContain(
      "합계에서 제외 1건 — money_contract_version 미충족으로 금액을 예고할 수 없음",
    );
    expect(clientHtml).toContain("카드 문자로 잡힌 반복 결제만");
    expect(clientHtml).not.toContain("29,000");
  });
});
