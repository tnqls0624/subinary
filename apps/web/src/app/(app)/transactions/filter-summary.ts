export type TransactionFilterKey = "categoryId" | "cardId" | "memberId" | "type" | "status";
export type TransactionFilterOption = { value: string; label: string };
export type TransactionFilterChoices = Record<TransactionFilterKey, ReadonlyArray<TransactionFilterOption>>;
export type TransactionFilterValues = Record<TransactionFilterKey, string> & {
  reviewOnly: boolean;
  excludedOnly: boolean;
  sharedOnly: boolean;
};
export type ActiveTransactionFilter = {
  key: TransactionFilterKey | "reviewOnly" | "excludedOnly" | "sharedOnly";
  label: string;
};

export const TRANSACTION_FILTER_LABELS: Record<TransactionFilterKey, string> = {
  categoryId: "카테고리", cardId: "카드", memberId: "구성원", type: "유형", status: "상태",
};

/** Keep URL-only and unavailable reference filters visible without showing raw IDs.
 * Period and search stay separate: clearing these conditions must preserve both.
 */
export function activeTransactionFilters(values: TransactionFilterValues, choices: TransactionFilterChoices): ActiveTransactionFilter[] {
  const result: ActiveTransactionFilter[] = [];
  for (const key of Object.keys(TRANSACTION_FILTER_LABELS) as TransactionFilterKey[]) {
    if (!values[key]) continue;
    const label = choices[key].find((item) => item.value === values[key])?.label;
    result.push({ key, label: `${TRANSACTION_FILTER_LABELS[key]}: ${label ?? "선택됨"}` });
  }
  if (values.reviewOnly) result.push({ key: "reviewOnly", label: "확인할 거래" });
  if (values.excludedOnly) result.push({ key: "excludedOnly", label: "합계에서 뺀 거래만" });
  if (values.sharedOnly) result.push({ key: "sharedOnly", label: "공용 카드 거래만" });
  return result;
}
