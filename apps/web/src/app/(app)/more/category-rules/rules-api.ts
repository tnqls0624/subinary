/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 카테고리 규칙 · 소급 재분류 API
 *
 * 화면 옆에 두는 이유는 `recurring-api.ts`와 같다 — `lib/api-client.ts`·`queries.ts`는
 * 여러 작업이 동시에 편집하는 공유 지점이라 충돌 비용이 크다. 대신 공용 `apiFetch`를
 * 그대로 통과시켜 인증·에러 변환·네이티브 헤더 규약이 갈라지지 않게 한다.
 * ------------------------------------------------------------------------- */
import type {
  CategoryRuleList,
  RecategorizeBatchList,
  RecategorizePreview,
  RecategorizeResponse,
  RecategorizeRevertResponse,
} from "@family/contracts";

import { apiFetch } from "@/lib/api-client";

export const categoryRulesKey = (householdId: string | null) =>
  ["category-rules", householdId] as const;

export const recategorizeBatchesKey = (householdId: string | null) =>
  ["recategorize-batches", householdId] as const;

export function fetchCategoryRules(
  accessToken: string | null,
  householdId: string,
): Promise<CategoryRuleList> {
  return apiFetch<CategoryRuleList>(
    `/v1/transactions/recategorize/rules?householdId=${encodeURIComponent(householdId)}`,
    { accessToken },
  );
}

/** 규칙만 지운다 — 이미 붙은 분류는 그대로 남는다(되돌리기는 batch가 담당). */
export function deleteCategoryRule(
  accessToken: string | null,
  ruleId: string,
): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/v1/transactions/recategorize/rules/${ruleId}`, {
    method: "DELETE",
    accessToken,
  });
}

/** 미리보기 키에 가맹점·카테고리를 넣는 이유: 다른 대상으로 바꾸면 다른 질문이다. */
export const recategorizePreviewKey = (
  householdId: string | null,
  merchant: string,
  categoryId: string,
) => ["recategorize-preview", householdId, merchant, categoryId] as const;

export function fetchRecategorizePreview(
  accessToken: string | null,
  householdId: string,
  merchant: string,
  categoryId: string,
): Promise<RecategorizePreview> {
  const query = new URLSearchParams({ householdId, merchant, categoryId });
  return apiFetch<RecategorizePreview>(
    `/v1/transactions/recategorize/preview?${query.toString()}`,
    { accessToken },
  );
}

/**
 * 일괄 적용. `expectedCount`는 사용자가 **미리보기에서 본 숫자**를 그대로 되돌려 보낸다 —
 * 그 사이 거래가 바뀌었으면 서버가 409로 거절한다. 클라이언트가 세지 않는다.
 */
export function applyRecategorize(
  accessToken: string | null,
  input: { householdId: string; merchant: string; categoryId: string; expectedCount: number },
): Promise<RecategorizeResponse> {
  return apiFetch<RecategorizeResponse>(`/v1/transactions/recategorize`, {
    method: "POST",
    accessToken,
    body: input,
  });
}

export function fetchRecategorizeBatches(
  accessToken: string | null,
  householdId: string,
): Promise<RecategorizeBatchList> {
  return apiFetch<RecategorizeBatchList>(
    `/v1/transactions/recategorize/batches?householdId=${encodeURIComponent(householdId)}`,
    { accessToken },
  );
}

export function revertRecategorize(
  accessToken: string | null,
  batchId: string,
): Promise<RecategorizeRevertResponse> {
  return apiFetch<RecategorizeRevertResponse>(
    `/v1/transactions/recategorize/${batchId}/revert`,
    { method: "POST", accessToken },
  );
}
