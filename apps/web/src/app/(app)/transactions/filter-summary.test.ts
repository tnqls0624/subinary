import { describe, expect, it } from "vitest";
import { activeTransactionFilters, type TransactionFilterChoices, type TransactionFilterValues } from "./filter-summary";

const empty: TransactionFilterValues = {
  categoryId: "", cardId: "", memberId: "", type: "", status: "",
  reviewOnly: false, excludedOnly: false, sharedOnly: false,
};
const choices: TransactionFilterChoices = {
  categoryId: [], cardId: [{ value: "card-1", label: "생활비 카드" }], memberId: [],
  type: [{ value: "cancellation", label: "취소" }],
  status: [{ value: "pending_review", label: "확인필요" }],
};

describe("visible transaction conditions", () => {
  it("does not count the always-visible period or search as collapsed conditions", () => {
    expect(activeTransactionFilters({ ...empty, month: "2025-01", q: "가게" } as TransactionFilterValues, choices)).toEqual([]);
  });

  it("keeps every applied deep-link condition visible while the panel is closed", () => {
    const result = activeTransactionFilters({ ...empty, cardId: "card-1", type: "cancellation", status: "pending_review", reviewOnly: true, excludedOnly: true, sharedOnly: true }, choices);
    expect(result).toEqual([
      { key: "cardId", label: "카드: 생활비 카드" },
      { key: "type", label: "유형: 취소" },
      { key: "status", label: "상태: 확인필요" },
      { key: "reviewOnly", label: "확인할 거래" },
      { key: "excludedOnly", label: "합계에서 뺀 거래만" },
      { key: "sharedOnly", label: "공용 카드 거래만" },
    ]);
  });

  it("does not lose inactive or unavailable references or expose their IDs", () => {
    const result = activeTransactionFilters({ ...empty, categoryId: "category-unavailable", memberId: "member-inactive", cardId: "card-private" }, choices);
    expect(result).toEqual([
      { key: "categoryId", label: "카테고리: 선택됨" },
      { key: "cardId", label: "카드: 선택됨" },
      { key: "memberId", label: "구성원: 선택됨" },
    ]);
  });

  it("updates labels when reference lists load without changing the selected condition", () => {
    const values = { ...empty, cardId: "card-1" };
    expect(activeTransactionFilters(values, { ...choices, cardId: [] })[0]).toEqual({ key: "cardId", label: "카드: 선택됨" });
    expect(activeTransactionFilters(values, choices)[0]).toEqual({ key: "cardId", label: "카드: 생활비 카드" });
    expect(values.cardId).toBe("card-1");
  });
});
