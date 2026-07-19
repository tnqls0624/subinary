"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · React Query 훅 (Phase 5 §6.1)
 *
 * 모든 훅은 authedFetch(401→refresh 재시도)로 감싸 호출하고, 활성 householdId를
 * queryKey에 포함해 가족 전환 시 캐시가 격리되도록 한다. 페이지(P6~P8)가 사용한다.
 * queryKeys 팩토리는 뮤테이션 이후 invalidate에 재사용한다.
 * ------------------------------------------------------------------------- */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import type {
  CardBreakdown,
  CardSummary,
  CategoryBreakdown,
  CategorySummary,
  DeviceSummary,
  MemberBreakdown,
  MemberSummary,
  MerchantBreakdown,
  MerchantLabelCandidateListResponse,
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
  insights: (householdId: string | null, month?: string) =>
    ["monthly-insights", householdId, month ?? null] as const,
  devices: (householdId: string | null) =>
    ["devices", householdId] as const,
  cards: (householdId: string | null) => ["cards", householdId] as const,
  categories: (householdId: string | null) =>
    ["categories", householdId] as const,
  merchantLabelCandidates: (householdId: string | null, limit: number) =>
    ["merchant-label-candidates", householdId, limit] as const,
  householdMembers: (householdId: string | null) =>
    ["household-members", householdId] as const,
};

/**
 * 거래 변화에 영향받는 쿼리 일괄 무효화(거래·집계·예산·인사이트·카드문자 이벤트).
 * 뮤테이션 onSuccess와 실시간 힌트(activity-provider) 양쪽에서 공용으로 쓴다 —
 * 새 화면이 생겨도 여기 한 곳만 유지하면 무효화 누락이 없다.
 */
export function invalidateTransactionScope(qc: QueryClient): void {
  for (const key of [
    ["transactions"],
    ["analytics"],
    ["budgets"],
    ["monthly-insights"],
    ["card-sms-events"],
    ["merchant-label-candidates"],
    // 카테고리 이름 변경/삭제(가족 원격 편집)가 목록·아이콘에 반영되도록 포함.
    ["categories"],
  ]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

/** 활성 household가 정해질 때까지 쿼리를 비활성화하기 위한 공통 플래그. */
function useHouseholdScope() {
  const { householdId } = useHousehold();
  const { authedFetch } = useAuth();
  return { householdId, authedFetch, enabled: householdId != null };
}

// --- Analytics --------------------------------------------------------------

/** 실시간 폴링 등 쿼리별 오버라이드. */
export interface QueryOpts {
  /** ms 간격 폴링(포커스 상태에서만). 새 카드문자 자동 반영에 사용. */
  refetchInterval?: number;
}

export function useMonthly(
  month?: string,
  opts?: QueryOpts,
): UseQueryResult<MonthlyAnalytics> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.analytics("monthly", householdId, month),
    enabled,
    refetchInterval: opts?.refetchInterval,
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
  opts?: QueryOpts,
): UseQueryResult<TransactionListResponse> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.transactions(householdId, filters),
    enabled,
    refetchInterval: opts?.refetchInterval,
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

/** 현재 사용자가 검토·확정할 수 있는 가맹점 라벨 batch. */
export function useMerchantLabelCandidates(
  limit = 20,
): UseQueryResult<MerchantLabelCandidateListResponse> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.merchantLabelCandidates(householdId, limit),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.transactions.labelCandidates(
          token,
          householdId as string,
          limit,
        ),
      ),
  });
}

/** 선택한 카테고리를 사람 확정 규칙과 append-only feedback으로 저장한다. */
export function useConfirmMerchantLabel() {
  const qc = useQueryClient();
  const { authedFetch } = useHouseholdScope();
  return useMutation({
    mutationFn: ({
      transactionId,
      categoryId,
    }: {
      transactionId: string;
      categoryId: string;
    }) =>
      authedFetch((token) =>
        api.transactions.update(token, transactionId, {
          categoryId,
          applyRule: true,
        }),
      ),
    onSuccess: (_transaction, variables) => {
      qc.setQueriesData<MerchantLabelCandidateListResponse>(
        { queryKey: ["merchant-label-candidates"] },
        (current) =>
          current
            ? {
                ...current,
                items: current.items.filter(
                  (candidate) =>
                    candidate.representativeTransactionId !==
                    variables.transactionId,
                ),
              }
            : current,
      );
      invalidateTransactionScope(qc);
    },
  });
}

// --- Category mutations (커스텀 카테고리 CRUD) ------------------------------

/** 커스텀 카테고리 생성. 성공 시 생성된 CategorySummary 반환 + 목록 캐시 갱신. */
export function useCreateCategory() {
  const { householdId, authedFetch } = useHouseholdScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      authedFetch((token) =>
        api.categories.create(token, {
          householdId: householdId as string,
          name,
        }),
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.categories(householdId) }),
  });
}

/** 커스텀 카테고리 이름 변경. */
export function useUpdateCategory() {
  const { householdId, authedFetch } = useHouseholdScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      authedFetch((token) => api.categories.update(token, id, { name })),
    // 카테고리 이름은 서버 응답에 임베드된다(analytics categoryName·budget scopeLabel·
    // monthly-insights 카테고리 사실) → 목록뿐 아니라 이 화면들도 갱신해야 옛 이름이 안 남는다.
    onSuccess: () => invalidateTransactionScope(qc),
  });
}

/** 커스텀 카테고리 삭제. 삭제 시 거래가 미분류로 되돌아가므로 관련 캐시도 갱신. */
export function useDeleteCategory() {
  const { householdId, authedFetch } = useHouseholdScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch((token) => api.categories.delete(token, id)),
    onSuccess: () => invalidateTransactionScope(qc),
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
