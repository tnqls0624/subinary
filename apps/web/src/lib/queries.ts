"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · React Query 훅 (Phase 5 §6.1)
 *
 * 모든 훅은 authedFetch(401→refresh 재시도)로 감싸 호출하고, 활성 householdId를
 * queryKey에 포함해 가족 전환 시 캐시가 격리되도록 한다. 페이지(P6~P8)가 사용한다.
 * queryKeys 팩토리는 뮤테이션 이후 invalidate에 재사용한다.
 * ------------------------------------------------------------------------- */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type {
  CardSmsDeclineDismissResponse,
  CardSmsDeclineListResponse,
  CardBreakdown,
  CardSummary,
  CategoryBreakdown,
  CategorySummary,
  DeviceSummary,
  MemberBreakdown,
  MemberSummary,
  MerchantBreakdown,
  AnalyticsMonths,
  MerchantLabelCandidateListResponse,
  MerchantListResponse,
  MonthlyAnalytics,
  TransactionListResponse,
  BudgetListResponse,
  NotificationPreferences,
  NotificationPreferencesUpdateRequest,
  ManualParsePreviewRequest,
  ManualFieldsEntryRequest,
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
  merchants: (householdId: string | null) =>
    ["merchants", householdId] as const,
  declines: (householdId: string | null) =>
    ["card-sms-declines", householdId] as const,
  householdMembers: (householdId: string | null) =>
    ["household-members", householdId] as const,
  // 알림 계열은 household가 아니라 **user** 스코프다. 키에 userId를 넣어 같은 기기에서
  // 계정이 바뀌었을 때 캐시가 섞이지 않게 한다(로그아웃 시 clear가 1차 방어, 이건 2차).
  // 앞 요소를 유지하므로 ["notifications"] 같은 접두 무효화는 그대로 동작한다.
  notifications: (userId: string | null) => ["notifications", userId] as const,
  notificationUnread: (userId: string | null) =>
    ["notification-unread", userId] as const,
  notificationPreferences: (userId: string | null) =>
    ["notification-preferences", userId] as const,
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

/**
 * 거래가 있는 달의 목록(오름차순) — 월 스위처가 빈 달을 건너뛰는 데 쓴다.
 * 달 목록은 새 거래가 들어와도 거의 변하지 않으므로 폴링하지 않는다.
 */
export function useAnalyticsMonths(): UseQueryResult<AnalyticsMonths> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.analytics("months", householdId),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.analytics.months(token, householdId as string),
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

/**
 * 거래 목록 무한 스크롤용 쿼리. 단일 페이지 {@link useTransactions}(대시보드 최근거래
 * 등)와 별도 훅으로 둔다 — data 형태(pages 배열)가 다르고 queryKey도 "infinite"로
 * 구분한다(형태 충돌 방지). 커서는 각 페이지의 nextCursor로 이어받는다. queryKey는
 * ["transactions", …] 접두를 유지하므로 invalidateTransactionScope로 함께 무효화된다.
 */
export function useInfiniteTransactions(
  filters: Omit<TransactionListParams, "householdId" | "cursor"> = {},
  opts?: QueryOpts,
) {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useInfiniteQuery({
    queryKey: [...queryKeys.transactions(householdId, filters), "infinite"],
    enabled,
    refetchInterval: opts?.refetchInterval,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      authedFetch((token) =>
        api.transactions.list(token, {
          householdId: householdId as string,
          ...filters,
          cursor: pageParam,
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
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

// --- 결제 실패(declined) ----------------------------------------------------

/**
 * 실패한 결제 묶음. `declined`는 거래로 승격되지 않으므로 거래 목록 쿼리로는 볼 수 없다.
 * 홈 배너와 실패 화면이 함께 쓴다.
 */
export function useDeclineList(): UseQueryResult<CardSmsDeclineListResponse> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.declines(householdId),
    enabled,
    queryFn: () =>
      authedFetch((token) =>
        api.cardSms.declines(token, householdId as string),
      ),
  });
}

/**
 * 실패 묶음 확인 표시 토글. 성공 시 목록을 무효화해 배너·화면이 함께 갱신된다.
 * 표시 이후 새 거절이 오면 서버가 다시 노출하므로 클라이언트는 낙관적 갱신을 하지 않는다.
 */
export function useSetDeclineDismissed(): UseMutationResult<
  CardSmsDeclineDismissResponse,
  Error,
  { merchant: string | null; amount: number | null; dismissed: boolean }
> {
  const { householdId, authedFetch } = useHouseholdScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      authedFetch((token) =>
        api.cardSms.setDeclineDismissed(
          token,
          {
            householdId: householdId as string,
            merchant: input.merchant,
            amount: input.amount,
          },
          input.dismissed,
        ),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.declines(householdId),
      });
    },
  });
}

// --- Merchants (가맹점 아이덴티티) ------------------------------------------

/** 가맹점 목록 — 지출 큰 순, 별칭·카테고리 상태 포함. */
export function useMerchantList(): UseQueryResult<MerchantListResponse> {
  const { householdId, authedFetch, enabled } = useHouseholdScope();
  return useQuery({
    queryKey: queryKeys.merchants(householdId),
    enabled,
    queryFn: () =>
      authedFetch((token) => api.merchants.list(token, householdId as string)),
  });
}

/**
 * "이 이름들은 같은 가게" 확정. 서버가 과거 거래·카테고리 규칙까지 대표 이름으로
 * 백필하므로 거래/집계/예산 캐시도 통째로 무효화한다(가맹점 목록만 갱신하면
 * 대시보드가 옛 분리 상태를 계속 보여준다).
 */
export function useCreateMerchantAliases() {
  const { householdId, authedFetch } = useHouseholdScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      canonical,
      aliases,
    }: {
      canonical: string;
      aliases: string[];
    }) =>
      authedFetch((token) =>
        api.merchants.createAliases(token, {
          householdId: householdId as string,
          canonical,
          aliases,
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.merchants(householdId) });
      invalidateTransactionScope(qc);
    },
  });
}

/** 별칭 해제 — 서버가 해당 거래를 원문 재정규화 값으로 되돌린다. */
export function useDeleteMerchantAlias() {
  const { householdId, authedFetch } = useHouseholdScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch((token) => api.merchants.deleteAlias(token, id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.merchants(householdId) });
      invalidateTransactionScope(qc);
    },
  });
}

// --- Notifications ----------------------------------------------------------

/** 현재 사용자의 알림 선호(user 스코프, household 무관). 행 없으면 서버가 기본값. */
export function useNotificationPreferences(): UseQueryResult<NotificationPreferences> {
  const { authedFetch, user } = useAuth();
  return useQuery({
    queryKey: queryKeys.notificationPreferences(user?.id ?? null),
    queryFn: () =>
      authedFetch((token) => api.notifications.getPreferences(token)),
  });
}

/** 알림 선호 전체 대체(PUT). 성공 시 캐시를 응답으로 갱신. */
export function useUpdateNotificationPreferences() {
  const { authedFetch, user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationPreferencesUpdateRequest) =>
      authedFetch((token) => api.notifications.updatePreferences(token, body)),
    onSuccess: (data) => {
      // setQueryData는 접두가 아니라 **완전 일치** 키를 쓴다 — 훅과 같은 팩토리로 만든다.
      qc.setQueryData(queryKeys.notificationPreferences(user?.id ?? null), data);
    },
  });
}

/** 인앱 알림함 목록(최신순, 커서 무한스크롤). */
export function useNotifications() {
  const { authedFetch, user } = useAuth();
  return useInfiniteQuery({
    queryKey: queryKeys.notifications(user?.id ?? null),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      authedFetch((token) =>
        api.notifications.list(token, { cursor: pageParam, limit: 30 }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** 안읽음 개수(헤더 벨 뱃지). 포커스 복귀 시 재조회. */
export function useUnreadCount(): UseQueryResult<{ count: number }> {
  const { authedFetch, user } = useAuth();
  return useQuery({
    queryKey: queryKeys.notificationUnread(user?.id ?? null),
    queryFn: () => authedFetch((token) => api.notifications.unreadCount(token)),
    refetchOnWindowFocus: true,
  });
}

/**
 * 전체 읽음(알림함 진입 시 자동 호출). 목록 캐시는 **무효화하지 않아** 진입 당시의
 * 안읽음/읽음 구분(스냅샷)을 화면에 유지하고, 헤더 벨 뱃지(unread-count)만 갱신한다.
 */
export function useMarkAllNotificationsRead() {
  const { authedFetch } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      authedFetch((token) => api.notifications.markAllRead(token)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notification-unread"] });
    },
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

// --- Manual entry (문자 붙여넣기 / 직접 입력) -------------------------------

/** 붙여넣은 문자 파싱 미리보기(등록 전 인식 결과 표시). */
export function useParsePreview() {
  const { authedFetch } = useHouseholdScope();
  return useMutation({
    mutationFn: (body: ManualParsePreviewRequest) =>
      authedFetch((token) => api.cardSms.parsePreview(token, body)),
  });
}

/**
 * 문자 붙여넣기 등록. 수집 후 워커의 파싱·승격을 기다리며 이벤트 상태를 폴링한다
 * (~15회 × 0.9s). 최종 이벤트 detail을 함께 반환해 UI가 결과(승격/실패)를 표시한다.
 */
export function useManualTextEntry() {
  const { householdId, authedFetch } = useHouseholdScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { content: string; sender?: string }) => {
      const res = await authedFetch((token) =>
        api.cardSms.manualText(token, {
          householdId: householdId as string,
          ...input,
        }),
      );
      let detail = await authedFetch((token) =>
        api.cardSms.eventStatus(token, res.cardSmsEventId),
      );
      for (let i = 0; i < 15 && detail.parseStatus === "pending"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        detail = await authedFetch((token) =>
          api.cardSms.eventStatus(token, res.cardSmsEventId),
        );
      }
      return { ...res, detail };
    },
    onSuccess: () => invalidateTransactionScope(qc),
  });
}

/** 직접 입력 거래 등록(동기). 성공 시 거래/집계/예산 캐시 무효화. */
export function useManualFieldsEntry() {
  const { householdId, authedFetch } = useHouseholdScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<ManualFieldsEntryRequest, "householdId">) =>
      authedFetch((token) =>
        api.cardSms.manualFields(token, {
          householdId: householdId as string,
          ...body,
        }),
      ),
    onSuccess: () => invalidateTransactionScope(qc),
  });
}
