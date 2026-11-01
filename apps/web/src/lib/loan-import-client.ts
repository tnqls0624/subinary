"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  financialOverviewResponseSchema,
  loanImportCommitRequestSchema,
  loanImportDeleteRequestSchema,
  loanImportPreviewRequestSchema,
  loanImportPreviewResponseSchema,
  loanImportRecordListResponseSchema,
  loanImportRecordResponseSchema,
  loanImportUpdateRequestSchema,
  manualFinanceDeleteResponseSchema,
  type LoanImportCommitRequest,
  type LoanImportPreviewRequest,
  type LoanImportUpdateRequest,
  type ManualFinanceScope,
} from "@family/contracts";
import { apiFetch, type AccessToken } from "./api-client";
import { useAuth } from "./auth-context";
import { useHousehold } from "./household-context";

const base = "/v1/loan-imports";
const query = (householdId: string, scope?: ManualFinanceScope) =>
  `?${new URLSearchParams({ householdId, ...(scope ? { scope } : {}) })}`;

type ContextRow = {
  householdId: string;
  ownerUserId: string;
  visibility: "private" | "household";
};
function assertContext(items: ContextRow[], householdId: string, userId: string, scope?: ManualFinanceScope, ownerOnly = false) {
  if (items.some((item) => item.householdId !== householdId ||
    (scope && item.visibility !== scope) ||
    ((ownerOnly || scope === "private") && item.ownerUserId !== userId))) {
    throw new Error("loan import response context mismatch");
  }
}
function assertRecord(item: ContextRow & { id: string }, householdId: string, userId: string, id: string) {
  assertContext([item], householdId, userId, undefined, true);
  if (item.id !== id) throw new Error("loan import response record mismatch");
}
function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
}

/** The shared prefix also receives existing manual-finance refresh and revocation hints. */
export const loanImportKeys = {
  overview: (householdId: string | null, userId: string | null, scope: ManualFinanceScope) =>
    ["manual-finance", householdId, userId, scope, "overview"] as const,
  records: (householdId: string | null, userId: string | null) =>
    ["manual-finance", householdId, userId, "owner", "loan-import-records"] as const,
};

export const loanImportApi = {
  async preview(token: AccessToken, body: LoanImportPreviewRequest, userId: string, signal?: AbortSignal) {
    checkSignal(signal);
    const request = loanImportPreviewRequestSchema.parse(body);
    const result = loanImportPreviewResponseSchema.parse(await apiFetch(`${base}/preview`, {
      accessToken: token, method: "POST", body: request, signal,
    }));
    checkSignal(signal);
    if (JSON.stringify(result.capture) !== JSON.stringify(request.capture))
      throw new Error("loan import capture mismatch");
    if (result.existing) assertContext([result.existing], body.householdId, userId, undefined, true);
    assertContext(result.replacementOptions, body.householdId, userId, undefined, true);
    if (result.replacementOptions.some((item) => item.kind !== "loan" || !item.canEdit))
      throw new Error("loan import replacement mismatch");
    return result;
  },
  async commit(token: AccessToken, body: LoanImportCommitRequest, userId: string, signal?: AbortSignal) {
    checkSignal(signal);
    const request = loanImportCommitRequestSchema.parse(body);
    const result = loanImportRecordResponseSchema.parse(await apiFetch(`${base}/commit`, {
      accessToken: token, method: "POST", body: request, signal,
    }));
    checkSignal(signal);
    assertRecord(result.item, body.householdId, userId, body.recordId);
    return result;
  },
  async records(token: AccessToken, householdId: string, userId: string, signal?: AbortSignal) {
    checkSignal(signal);
    const result = loanImportRecordListResponseSchema.parse(await apiFetch(`${base}/records${query(householdId)}`, {
      accessToken: token, signal,
    }));
    checkSignal(signal);
    assertContext(result.items, householdId, userId, undefined, true);
    return result;
  },
  async update(token: AccessToken, householdId: string, userId: string, id: string, body: LoanImportUpdateRequest, signal?: AbortSignal) {
    checkSignal(signal);
    const request = loanImportUpdateRequestSchema.parse(body);
    const result = loanImportRecordResponseSchema.parse(await apiFetch(`${base}/records/${encodeURIComponent(id)}${query(householdId)}`, {
      accessToken: token, method: "PATCH", body: request, signal,
    }));
    checkSignal(signal);
    assertRecord(result.item, householdId, userId, id);
    return result;
  },
  async remove(token: AccessToken, householdId: string, id: string, expectedVersion: number, signal?: AbortSignal) {
    checkSignal(signal);
    const body = loanImportDeleteRequestSchema.parse({ expectedVersion });
    const result = manualFinanceDeleteResponseSchema.parse(await apiFetch(`${base}/records/${encodeURIComponent(id)}${query(householdId)}`, {
      accessToken: token, method: "DELETE", body, signal,
    }));
    checkSignal(signal);
    return result;
  },
  async overview(token: AccessToken, householdId: string, userId: string, scope: ManualFinanceScope, signal?: AbortSignal) {
    checkSignal(signal);
    const result = financialOverviewResponseSchema.parse(await apiFetch(`/v1/financial-overview${query(householdId, scope)}`, {
      accessToken: token, signal,
    }));
    checkSignal(signal);
    assertContext(result.manualItems, householdId, userId, scope);
    assertContext(result.loanItems, householdId, userId, scope);
    return result;
  },
};

/** No inactive sensitive cache survives a route, household, identity, or session change. */
function useLoanCacheCleanup(key: readonly unknown[]) {
  const qc = useQueryClient();
  const keyString = JSON.stringify(key);
  useEffect(() => {
    const queryKey: unknown[] = JSON.parse(keyString);
    return () => {
      void qc.cancelQueries({ queryKey, exact: true });
      qc.removeQueries({ queryKey, exact: true });
    };
  }, [qc, keyString]);
}

export function useFinancialOverview(scope: ManualFinanceScope = "household") {
  const { householdId } = useHousehold();
  const { user, status, authedFetch } = useAuth();
  const active = Boolean(householdId && user && status === "authenticated");
  const key = loanImportKeys.overview(active ? householdId : null, active ? user!.id : null, scope);
  useLoanCacheCleanup(key);
  return useQuery({
    queryKey: key, enabled: active,
    queryFn: ({ signal }) => authedFetch((token) => loanImportApi.overview(token, householdId!, user!.id, scope, signal)),
    staleTime: 0, gcTime: 0, retry: false,
  });
}

export function useOwnedLoanImports() {
  const { householdId } = useHousehold();
  const { user, status, authedFetch } = useAuth();
  const active = Boolean(householdId && user && status === "authenticated");
  const key = loanImportKeys.records(active ? householdId : null, active ? user!.id : null);
  useLoanCacheCleanup(key);
  return useQuery({
    queryKey: key, enabled: active,
    queryFn: ({ signal }) => authedFetch((token) => loanImportApi.records(token, householdId!, user!.id, signal)),
    staleTime: 0, gcTime: 0, retry: false,
  });
}
