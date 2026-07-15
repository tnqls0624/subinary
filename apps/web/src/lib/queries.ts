"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · React Query 훅 (Phase 5 §6.1)
 *
 * 모든 훅은 authedFetch(401→refresh 재시도)로 감싸 호출하고, 활성 householdId를
 * queryKey에 포함해 가족 전환 시 캐시가 격리되도록 한다. 페이지(P6~P8)가 사용한다.
 * queryKeys 팩토리는 뮤테이션 이후 invalidate에 재사용한다.
 * ------------------------------------------------------------------------- */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type {
  CardBreakdown,
  CardSummary,
  CategoryBreakdown,
  CategorySummary,
  DeviceSummary,
  MemberBreakdown,
  MemberSummary,
  MerchantBreakdown,
  MonthlyAnalytics,
  TransactionListResponse,
  BudgetListResponse,
} from "@family/contracts";

import {
  api,
  type TransactionListParams,
} from "./api-client";
import { useAuth } from "./auth-context";
import { useHousehold } from "./household-context";

/** queryKey 팩토리(hook + 뮤테이션 invalidate 공용). */
export const queryKeys = {
  analytics: (kind: string, householdId: string | null, month?: string) =>
    ["analytics", kind, householdId, month ?? null] as const,
  transactions: (
    householdId: string | null,
    filters: Omit<TransactionListParams, "householdId">,
  ) => ["transactions", householdId, filters] as const,
  budgets: (householdId: string | null, month?: string) =>
    ["budgets", householdId, month ?? null] as const,
  devices: (householdId: string | null) =>
    ["devices", householdId] as const,
  cards: (householdId: string | null) => ["cards", householdId] as const,
  categories: (householdId: string | null) =>
    ["categories", householdId] as const,
  householdMembers: (householdId: string | null) =>
    ["household-members", householdId] as const,
};

/** 활성 household가 정해질 때까지 쿼리를 비활성화하기 위한 공통 플래그. */
function useHouseholdScope() {
  const { householdId } = useHousehold();
  const { authedFetch } = useAuth();
  return { householdId, authedFetch, enabled: householdId != null };
}

// --- Analytics --------------------------------------------------------------

export function useMonthly(
  month?: string,
): UseQueryResult<MonthlyAnalytics> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.analytics("monthly", householdId, month),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.analytics.monthly(token, { householdId: householdId as string, month }),
      ),
  });
}

export function useCategories(
  month?: string,
): UseQueryResult<CategoryBreakdown> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.analytics("categories", householdId, month),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.analytics.categories(token, {
          householdId: householdId as string,
          month,
        }),
      ),
  });
}

export function useMembers(month?: string): UseQueryResult<MemberBreakdown> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.analytics("members", householdId, month),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.analytics.members(token, {
          householdId: householdId as string,
          month,
        }),
      ),
  });
}

export function useCards(month?: string): UseQueryResult<CardBreakdown> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.analytics("cards", householdId, month),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.analytics.cards(token, {
          householdId: householdId as string,
          month,
        }),
      ),
  });
}

export function useMerchants(
  month?: string,
): UseQueryResult<MerchantBreakdown> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.analytics("merchants", householdId, month),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.analytics.merchants(token, {
          householdId: householdId as string,
          month,
        }),
      ),
  });
}

// --- Transactions -----------------------------------------------------------

export function useTransactions(
  filters: Omit<TransactionListParams, "householdId"> = {},
): UseQueryResult<TransactionListResponse> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.transactions(householdId, filters),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.transactions.list(token, {
          householdId: householdId as string,
          ...filters,
        }),
      ),
  });
}

// --- Budgets ----------------------------------------------------------------

export function useBudgets(month?: string): UseQueryResult<BudgetListResponse> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.budgets(householdId, month),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.budgets.list(token, { householdId: householdId as string, month }),
      ),
  });
}

// --- Resource lists (필터/폼 채우기용) --------------------------------------

export function useDevices(): UseQueryResult<DeviceSummary[]> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.devices(householdId),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.devices.list(token, householdId as string),
      ),
  });
}

export function useCardList(): UseQueryResult<CardSummary[]> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.cards(householdId),
    enabled,
    queryFn: () =>
      authedFetch((token) => api.cards.list(token, householdId as string)),
  });
}

export function useCategoryList(): UseQueryResult<CategorySummary[]> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.categories(householdId),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.categories.list(token, householdId as string),
      ),
  });
}

export function useHouseholdMembers(): UseQueryResult<MemberSummary[]> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.householdMembers(householdId),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.households.members(token, householdId as string),
      ),
  });
}
