import type { ManualAssetSummary, ManualHousingSummary, MonthlyAnalytics } from "@family/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomeConsumptionCard, type HomeConsumptionCardProps } from "./home-consumption-card";
import { HomeHousingCard } from "./home-housing-card";
import { ManualAssetsSummary } from "./manual-finance/asset-summary";

const noExceptions = { count: 0, loading: false, error: false, truncated: false };
const base: HomeConsumptionCardProps = { month: "2026-10", isCurrentMonth: true, loading: false, error: false, reviews: noExceptions, processing: noExceptions };
const monthly: MonthlyAnalytics = {
  meta: { period: { from: "2026-09-30T15:00:00Z", to: "2026-10-31T15:00:00Z", timezone: "Asia/Seoul" }, cancellationApplied: true, includedMemberIds: [], excludedByPermission: 0, excludedManual: { count: 0, net: 0 }, excludedTransfer: { count: 0, net: 0 } },
  totalNet: 0, totalApproved: 0, totalCancelled: 0, transactionCount: 0, previousNet: 0, deltaNet: 0, deltaRate: null,
};
const consumption = (props: Partial<HomeConsumptionCardProps> = {}) => renderToStaticMarkup(createElement(HomeConsumptionCard, { ...base, ...props }));
const housing = (summary?: ManualHousingSummary, props: { loading?: boolean; error?: boolean } = {}) => renderToStaticMarkup(createElement(HomeHousingCard, { summary, loading: false, error: false, scope: "household", ...props }));

describe("asset summary empty and partial states", () => {
  const empty: ManualAssetSummary = { currency: "KRW", grossAssets: null, debt: null, netAssets: null, assetsCompleteness: "empty", debtCompleteness: "empty", completeness: "empty", asOfDate: null, oldestAsOfDate: null, newestAsOfDate: null, mixedAsOfDates: false };
  it("shows an invitation to add assets instead of empty financial totals", () => {
    const html = renderToStaticMarkup(createElement(ManualAssetsSummary, { summary: empty }));
    expect(html).toContain("등록된 자산이 없어요");
    expect(html).not.toContain("— 원");
    expect(html).not.toContain("0원");
  });
  it("keeps a partial total distinct from a complete net worth", () => {
    const html = renderToStaticMarkup(createElement(ManualAssetsSummary, { summary: { ...empty, grossAssets: "100000", assetsCompleteness: "partial", completeness: "partial" }, scope: "private" }));
    expect(html).toContain("100,000원");
    expect(html).toContain("자산 (일부 입력)");
    expect(html).toContain("미입력");
    expect(html).toContain("순자산은 아직 계산하지 않았어요");
    expect(html).not.toContain("— 원");
    expect(html).toContain("나만 보는 자산");
    expect(html).not.toContain("등록된 자산이 없어요");
  });
  it("shows a known debt without assuming absent assets are zero or presenting a negative net worth", () => {
    const html = renderToStaticMarkup(createElement(ManualAssetsSummary, {
      summary: { ...empty, debt: "90071992547409931234", debtCompleteness: "complete", completeness: "partial" },
    }));
    expect(html).toContain("90,071,992,547,409,931,234원");
    expect(html).toContain("남은 대출");
    expect(html).toContain("미입력");
    expect(html).toContain("순자산은 아직 계산하지 않았어요");
    expect(html).not.toContain("-90,071");
    expect(html).not.toContain(">0원<");
    expect(html).not.toContain("— 원");
  });
  const mixedDates: ManualAssetSummary = {
    ...empty,
    grossAssets: "200000",
    debt: "100000",
    netAssets: "100000",
    assetsCompleteness: "complete",
    debtCompleteness: "complete",
    completeness: "complete",
    oldestAsOfDate: "2020-01-01",
    newestAsOfDate: "2020-01-03",
    mixedAsOfDates: true,
  };
  it("preserves an explicitly calculated zero net worth", () => {
    const html = renderToStaticMarkup(createElement(ManualAssetsSummary, {
      summary: { ...mixedDates, grossAssets: "100000", netAssets: "0" },
    }));
    expect(html).toContain(">0원</p>");
    expect(html).not.toContain("순자산은 아직 계산하지 않았어요");
  });
  it("does not present manual dates as bank balance dates when imported debt is included", () => {
    const html = renderToStaticMarkup(createElement(ManualAssetsSummary, {
      summary: mixedDates,
      hasImportedBalance: true,
      sourceLabel: "직접 입력·신한 브라우저 확인",
    }));
    expect(html).toContain("100,000원");
    expect(html).toContain("은행 잔액 기준일 미확인");
    expect(html).toContain("직접 입력·신한 브라우저 확인");
    expect(html).not.toContain("항목별 기준일");
    expect(html).not.toContain("2020-01-01");
    expect(html).not.toContain("2020-01-03");
  });
  it.each([undefined, false])("preserves the manual date range when hasImportedBalance is %s", (hasImportedBalance) => {
    const html = renderToStaticMarkup(createElement(ManualAssetsSummary, { summary: mixedDates, hasImportedBalance }));
    expect(html).toContain("항목별 기준일 2020-01-01 ~ 2020-01-03");
    expect(html).toContain("직접 입력");
    expect(html).not.toContain("은행 잔액 기준일 미확인");
  });
});

describe("quiet home transaction exceptions", () => {
  it("has no standing review card, empty count or synthetic financial values", () => {
    const html = consumption();
    expect(html).not.toContain("확인할 거래");
    expect(html).not.toContain("거래 검토함");
    expect(html).not.toContain("가상");
    expect(html).not.toContain("— 원");
    expect(html).not.toContain(">0원</p>");
    expect(html).toContain("카드 사용액을 불러오지 못했어요");
  });

  it("shows a small all-time review link only after the count is known", () => {
    const props = { reviews: { ...noExceptions, count: 2, truncated: true } };
    expect(consumption(props)).toContain('href="/transactions?review=1"');
    expect(consumption(props)).toContain("확인할 거래 2+건");
    expect(consumption({ reviews: { ...props.reviews, loading: true } })).not.toContain("확인할 거래");
    expect(consumption({ reviews: { ...props.reviews, error: true } })).not.toContain("확인할 거래");
  });

  it("keeps processing as a neutral state instead of a user judgment notice", () => {
    const html = consumption({ processing: { ...noExceptions, count: 3 } });
    expect(html).toContain("문자·환율 확인 대기 3건");
    expect(html).toContain('role="status"');
    expect(html).toContain('href="/todo?section=processing"');
    expect(html).not.toContain("확인할 거래");
    expect(html).not.toContain("재처리");
  });

  it("preserves explicit zero from a successful server response but hides failed cached values", () => {
    expect(consumption({ monthly })).toContain(">0원</p>");
    expect(consumption({ monthly: { ...monthly, totalNet: 123456 }, error: true })).not.toContain("123,456원");
    expect(consumption({ monthly, error: true })).toContain("카드 사용액을 불러오지 못했어요");
    expect(consumption({ monthly, error: true })).not.toContain(">0원</p>");
    expect(consumption({ monthly: { ...monthly, totalNet: 123456 }, loading: true })).not.toContain("123,456원");
  });

  it("does not display another member's private-row existence count on the new home", () => {
    const before = consumption({ monthly });
    const after = consumption({ monthly: { ...monthly, meta: { ...monthly.meta, excludedByPermission: 98765 } } });
    expect(after).toBe(before);
  });
});

describe("home housing summary evidence", () => {
  it("does not turn absent payment or occupancy information into zero or a claimed date", () => {
    const html = housing({ nextPayment: null, hasIncompletePayments: true });
    expect(html).not.toContain("— 원");
    expect(html).toContain("금액·날짜·납부 내역이 비어 있는 항목");
    expect(html).not.toContain("2029");
    expect(html).not.toContain("0원</p>");
  });

  it("uses one compact schedule link when no payment is scheduled", () => {
    const html = housing({ nextPayment: null, hasIncompletePayments: false });
    expect(html).toContain("예정된 납부 일정이 없어요");
    expect(html.match(/href=/g)).toHaveLength(1);
    expect(html).toContain('href="/plan?scope=household"');
    expect(html).not.toContain("납부할 금액");
    expect(html).not.toContain("— 원");
    expect(html).not.toContain("0원");
  });

  it("shows only the server-selected payment and its exact stored amount and date", () => {
    const html = housing({ nextPayment: { planId: "00000000-0000-4000-8000-000000000001", paymentId: "00000000-0000-4000-8000-000000000002", label: "합성 테스트 주택", kind: "interim", installment: 2, dueDate: "2026-11-01", remainingAmountKrw: "90071992547409931234" }, hasIncompletePayments: false });
    expect(html).toContain("합성 테스트 주택");
    expect(html).toContain("중도금 2회차");
    expect(html).toContain("2026-11-01");
    expect(html).toContain("90,071,992,547,409,931,234원");
  });

  it("hides cached payment evidence while the query has failed or the scope is loading", () => {
    const summary: ManualHousingSummary = { nextPayment: { planId: "00000000-0000-4000-8000-000000000001", paymentId: "00000000-0000-4000-8000-000000000002", label: "합성 테스트 주택", kind: "balance", installment: null, dueDate: "2026-11-01", remainingAmountKrw: "7000000" }, hasIncompletePayments: false };
    for (const state of [{ error: true }, { loading: true }]) {
      const html = housing(summary, state);
      expect(html).not.toContain("합성 테스트 주택");
      expect(html).not.toContain("7,000,000원");
      expect(html).not.toContain("— 원");
      expect(html).not.toContain("예정된 납부 일정이 없어요");
      expect(html).toContain(state.error ? "납부 일정을 불러오지 못했어요" : "납부 일정을 불러오는 중이에요");
    }
  });
});
