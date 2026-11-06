import { describe, expect, it } from "vitest";

import type {
  AnalyticsMeta,
  CategoryBreakdown,
  RecurringUpcomingResponse,
  TransactionSummary,
} from "@family/contracts";

import { formatAsOfSeoul } from "./format";
import {
  budgetEmptyText,
  categorizedCategoryRows,
  recurringExclusionNotes,
  spendExclusionNotes,
  unclassifiedBurnCaveat,
  unclassifiedInfoText,
  unclassifiedPreviewRows,
  upcomingEmptyText,
  WEEKLY_REVIEW_SOURCES,
} from "./weekly-household-review";

const meta = (
  partial: Partial<AnalyticsMeta> = {},
): AnalyticsMeta => ({
  period: {
    from: "2026-11-01T15:00:00.000Z",
    to: "2026-11-08T15:00:00.000Z",
    timezone: "Asia/Seoul",
  },
  cancellationApplied: true,
  includedMemberIds: [],
  excludedByPermission: 0,
  excludedManual: { count: 0, net: 0 },
  excludedTransfer: { count: 0, net: 0 },
  ...partial,
});

describe("asOf 표기", () => {
  it("Asia/Seoul 절대 시각만 쓰고 신선도 배지용 상대 문구를 만들지 않는다", () => {
    expect(formatAsOfSeoul("2026-11-05T14:43:00+09:00")).toBe(
      "2026-11-05 14:43 Asia/Seoul",
    );
  });
});

describe("한 주 지출 제외 공시", () => {
  it("빠진 건마다 건수와 사유를 붙인다", () => {
    expect(
      spendExclusionNotes(
        meta({
          excludedManual: { count: 2, net: 1000 },
          excludedTransfer: { count: 1, net: 500 },
          excludedByPermission: 3,
        }),
      ),
    ).toEqual([
      { count: 2, reason: "직접 합계에서 뺀 거래" },
      { count: 1, reason: "자산 이동(이체·충전 등)이라 지출이 아님" },
      { count: 3, reason: "다른 구성원의 비공개 거래" },
    ]);
  });
  it("빠진 게 없으면 비운다", () => {
    expect(spendExclusionNotes(meta())).toEqual([]);
  });
});

describe("카테고리 표", () => {
  it("categoryId가 있는 행만 남기고, 없으면 표를 생략할 수 있게 빈 배열을 준다", () => {
    const breakdown = {
      meta: meta(),
      items: [
        {
          categoryId: null,
          categorySlug: null,
          categoryName: "미분류",
          net: 10_000,
          ratio: 1,
          count: 2,
        },
      ],
    } satisfies CategoryBreakdown;
    expect(categorizedCategoryRows(breakdown)).toEqual([]);
    expect(
      categorizedCategoryRows({
        ...breakdown,
        items: [
          ...breakdown.items,
          {
            categoryId: "11111111-1111-4111-8111-111111111111",
            categorySlug: "food",
            categoryName: "식비",
            net: 5_000,
            ratio: 0.5,
            count: 1,
          },
        ],
      }),
    ).toEqual([
      {
        categoryId: "11111111-1111-4111-8111-111111111111",
        categoryName: "식비",
        net: 5_000,
        count: 1,
      },
    ]);
  });
});

describe("예산·미분류·정기지출 빈 상태", () => {
  it("예산 규칙 없음은 만들기 CTA 없이 한 줄만", () => {
    expect(budgetEmptyText()).toBe("이번 달에 적용된 예산 규칙이 없어요.");
    expect(budgetEmptyText()).not.toMatch(/만들|편집|수정/);
  });

  it("미분류 건수와 소진이 적게 잡히는 한계를 말한다", () => {
    expect(unclassifiedInfoText(0)).toBe("미분류 거래가 없어요.");
    expect(unclassifiedInfoText(4)).toContain("4건");
    expect(unclassifiedBurnCaveat(0)).toBeNull();
    expect(unclassifiedBurnCaveat(4)).toContain("4건");
    expect(unclassifiedBurnCaveat(4)).toMatch(/적게/);
  });

  it("미분류 미리보기는 approval · categoryId null 만", () => {
    const rows = unclassifiedPreviewRows([
      txn({ id: "1", transactionType: "approval", categoryId: null }),
      txn({
        id: "2",
        transactionType: "approval",
        categoryId: "11111111-1111-4111-8111-111111111111",
      }),
      txn({ id: "3", transactionType: "cancellation", categoryId: null }),
      txn({
        id: "4",
        transactionType: "approval",
        categoryId: null,
        excludedAt: "2026-11-01T00:00:00.000Z",
      }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["1"]);
  });

  it("예정 없음·합계 제외 사유를 스펙대로 둔다", () => {
    expect(upcomingEmptyText()).toBe("예정 데이터 없음");
    expect(
      recurringExclusionNotes({
        excludedCount: 2,
        otherCurrencyCount: 1,
      } as Pick<
        RecurringUpcomingResponse,
        "excludedCount" | "otherCurrencyCount"
      >),
    ).toEqual([
      {
        count: 2,
        reason: "money_contract_version 미충족으로 금액을 예고할 수 없음",
      },
      { count: 1, reason: "외화라 KRW 합계에 넣지 않음" },
    ]);
  });

  it("출처 라벨에 SnapshotBalances 새로고침·판정 문구가 없다", () => {
    for (const source of Object.values(WEEKLY_REVIEW_SOURCES)) {
      expect(source).not.toMatch(/된다|안 된다|애매|새로고침|Subscription/);
    }
  });
});

function txn(
  partial: Partial<TransactionSummary> & Pick<TransactionSummary, "id">,
): TransactionSummary {
  return {
    householdId: "hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh",
    memberId: "mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm",
    cardId: null,
    transactionType: "approval",
    status: "approved",
    amount: 1000,
    cancelledAmount: 0,
    netAmount: 1000,
    currency: "KRW",
    originalAmount: null,
    originalCurrency: null,
    exchangeRate: null,
    merchantRaw: "테스트",
    merchantNormalized: "테스트",
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
    ...partial,
  };
}
