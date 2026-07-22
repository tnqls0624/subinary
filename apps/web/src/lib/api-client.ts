/* ---------------------------------------------------------------------------
 * Family Memory AI — web · API 클라이언트 (Phase 5 §6.1)
 *
 * 얇은 fetch 래퍼 + 도메인별 호출 함수. 모든 요청은:
 *  - `${NEXT_PUBLIC_API_URL}` 기준 절대경로(글로벌 prefix `/v1`).
 *  - `credentials:'include'` (HttpOnly refresh 쿠키는 `/v1/auth` 스코프에서 자동 전송).
 *  - access token은 인자로 받아 `Authorization: Bearer` 헤더로만 전달(메모리 보관).
 *
 * 401 재시도/refresh 로직은 auth-context의 authedFetch가 담당한다(여기선 순수 호출).
 * 타입은 전부 @family/contracts 계약을 사용한다.
 * ------------------------------------------------------------------------- */
import type {
  AcceptInvitationRequest,
  AuthResult,
  CardBreakdown,
  CardCreateRequest,
  CardSummary,
  CardUpdateRequest,
  CardSmsEventDetail,
  ManualParsePreviewRequest,
  ManualParsePreviewResponse,
  ManualTextEntryRequest,
  ManualTextEntryResponse,
  ManualFieldsEntryRequest,
  CategoryBreakdown,
  CategoryCreateRequest,
  CategorySummary,
  CategoryUpdateRequest,
  DeviceRegisterRequest,
  DeviceSecretResponse,
  DeviceSummary,
  HouseholdCreateRequest,
  HouseholdSummary,
  InvitationCreateRequest,
  InvitationCreated,
  InvitationSummary,
  LinkCancellationRequest,
  LoginRequest,
  MemberBreakdown,
  MemberColorUpdateRequest,
  MemberRoleUpdateRequest,
  MemberSummary,
  MeResponse,
  MerchantBreakdown,
  MonthlyAnalytics,
  RegisterRequest,
  TransactionListResponse,
  TransactionSummary,
  TransactionSummaryResponse,
  TransactionUpdateRequest,
  BudgetCreateRequest,
  BudgetListResponse,
  BudgetSummary,
  BudgetUpdateRequest,
  FinanceQueryRequest,
  FinanceQueryResponse,
  MonthlyInsightsResponse,
  MerchantLabelCandidateListResponse,
  LearningOperationsMetricsResponse,
  PushSubscriptionRegisterRequest,
  PushSubscriptionResponse,
  NotificationPreferences,
  NotificationPreferencesUpdateRequest,
  NotificationListResponse,
  NotificationUnreadCount,
} from "@family/contracts";

import { isNative } from "./native";

/** API 베이스 URL. 환경변수 우선, 로컬 개발 기본값 fallback. */
const API =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** apiFetch 밖에서 직접 연결이 필요한 경우(SSE 스트림 등)에 쓰는 베이스 URL. */
export const API_BASE_URL = API;

/** access token 타입 별칭(메모리 보관, 없을 수 있음). */
export type AccessToken = string | null;

/** 실패한 API 응답을 표현하는 에러(HTTP status + 서버 메시지 보존). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

interface ApiFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  accessToken?: AccessToken;
  signal?: AbortSignal;
  /**
   * 네이티브 전용: refresh 토큰을 X-Refresh-Token 헤더로 실어 보낸다(쿠키 대체).
   * 웹에서는 사용하지 않는다(HttpOnly 쿠키가 자동 전송됨).
   */
  refreshToken?: string;
}

/** 서버 에러 본문(`{ statusCode, message, error }`)에서 사람이 읽을 메시지를 추출한다. */
function extractErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = record.message;
    if (typeof message === "string" && message.length > 0) return message;
    if (Array.isArray(message) && message.length > 0) {
      return message.map((m) => String(m)).join(", ");
    }
    if (typeof record.error === "string") return record.error;
  }
  return `요청이 실패했습니다 (HTTP ${status})`;
}

/**
 * 핵심 fetch 래퍼. JSON 요청/응답, 쿠키 포함, 실패 시 {@link ApiError} throw.
 * 204/빈 본문은 `undefined`로 반환한다.
 */
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const { method = "GET", body, accessToken, signal, refreshToken } = options;

  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  // 네이티브: 서버가 바디로 refresh 토큰을 내려주도록 플랫폼을 알리고, refresh/logout
  // 호출 시 저장해둔 토큰을 헤더로 재전송한다(cross-site 쿠키 미사용).
  if (isNative()) headers["x-client-platform"] = "capacitor";
  if (refreshToken) headers["x-refresh-token"] = refreshToken;

  const response = await fetch(`${API}${path}`, {
    method,
    credentials: "include",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
    cache: "no-store",
  });

  const text = await response.text();
  let parsed: unknown;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(response.status, parsed),
      parsed,
    );
  }

  return parsed as T;
}

/** undefined/null/'' 를 건너뛰고 쿼리스트링을 만든다(선행 `?` 포함, 없으면 빈 문자열). */
function buildQuery(
  params: Readonly<Record<string, string | number | boolean | null | undefined>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

// --- 요청 파라미터 타입 -----------------------------------------------------

/** analytics.* 공통 쿼리(월 또는 from/to 범위). */
export interface AnalyticsParams {
  householdId: string;
  month?: string;
  from?: string;
  to?: string;
}

/** transactions.list 필터(PRD §17.4). 금액은 KRW 정수. */
export interface TransactionListParams {
  householdId: string;
  memberId?: string;
  cardId?: string;
  type?: string;
  status?: string;
  categoryId?: string;
  from?: string;
  to?: string;
  minAmount?: number;
  maxAmount?: number;
  limit?: number;
  cursor?: string;
}

/** transactions.summary(검증용 월 요약) 쿼리. */
export interface TransactionSummaryParams {
  householdId: string;
  from?: string;
  to?: string;
}

/** budgets.list 쿼리(현재월 사용률 기준). */
export interface BudgetListParams {
  householdId: string;
  month?: string;
}

// --- 도메인 호출 함수 -------------------------------------------------------

/**
 * 도메인별 API 함수. 인증이 필요한 호출은 첫 인자로 accessToken을 받는다.
 * (auth-context가 authedFetch로 감싸 401 재시도를 처리한다.)
 */
export const api = {
  auth: {
    register: (body: RegisterRequest) =>
      apiFetch<AuthResult>("/v1/auth/register", { method: "POST", body }),
    login: (body: LoginRequest) =>
      apiFetch<AuthResult>("/v1/auth/login", { method: "POST", body }),
    // refreshToken: 네이티브에서만 전달(웹은 쿠키). refresh는 토큰을 로테이션하므로
    // 호출부(auth-context)가 응답의 refreshToken을 다시 저장해야 한다.
    refresh: (refreshToken?: string) =>
      apiFetch<AuthResult>("/v1/auth/refresh", { method: "POST", refreshToken }),
    logout: (refreshToken?: string) =>
      apiFetch<{ success: true }>("/v1/auth/logout", {
        method: "POST",
        refreshToken,
      }),
    me: (accessToken: AccessToken) =>
      apiFetch<MeResponse>("/v1/auth/me", { accessToken }),
  },

  households: {
    create: (accessToken: AccessToken, body: HouseholdCreateRequest) =>
      apiFetch<HouseholdSummary>("/v1/households", {
        method: "POST",
        body,
        accessToken,
      }),
    get: (accessToken: AccessToken, id: string) =>
      apiFetch<HouseholdSummary>(`/v1/households/${id}`, { accessToken }),
    members: (accessToken: AccessToken, id: string) =>
      apiFetch<MemberSummary[]>(`/v1/households/${id}/members`, { accessToken }),
    invitations: (accessToken: AccessToken, id: string) =>
      apiFetch<InvitationSummary[]>(`/v1/households/${id}/invitations`, {
        accessToken,
      }),
    invite: (
      accessToken: AccessToken,
      id: string,
      body: InvitationCreateRequest,
    ) =>
      apiFetch<InvitationCreated>(`/v1/households/${id}/invitations`, {
        method: "POST",
        body,
        accessToken,
      }),
    acceptInvite: (
      accessToken: AccessToken,
      token: string,
      body: AcceptInvitationRequest,
    ) =>
      apiFetch<HouseholdSummary>(
        `/v1/household-invitations/${token}/accept`,
        { method: "POST", body, accessToken },
      ),
    updateRole: (
      accessToken: AccessToken,
      id: string,
      memberId: string,
      body: MemberRoleUpdateRequest,
    ) =>
      apiFetch<MemberSummary>(`/v1/households/${id}/members/${memberId}`, {
        method: "PATCH",
        body,
        accessToken,
      }),
    updateColor: (
      accessToken: AccessToken,
      id: string,
      memberId: string,
      body: MemberColorUpdateRequest,
    ) =>
      apiFetch<MemberSummary>(
        `/v1/households/${id}/members/${memberId}/color`,
        { method: "PATCH", body, accessToken },
      ),
    removeMember: (accessToken: AccessToken, id: string, memberId: string) =>
      apiFetch<{ removed: true }>(
        `/v1/households/${id}/members/${memberId}`,
        { method: "DELETE", accessToken },
      ),
    revokeInvite: (
      accessToken: AccessToken,
      id: string,
      invitationId: string,
    ) =>
      apiFetch<InvitationSummary>(
        `/v1/households/${id}/invitations/${invitationId}`,
        { method: "DELETE", accessToken },
      ),
  },

  notifications: {
    subscribe: (
      accessToken: AccessToken,
      body: PushSubscriptionRegisterRequest,
    ) =>
      apiFetch<PushSubscriptionResponse>("/v1/notifications/subscriptions", {
        method: "POST",
        body,
        accessToken,
      }),
    unsubscribe: (accessToken: AccessToken, token: string) =>
      apiFetch<{ removed: true }>(
        `/v1/notifications/subscriptions/${encodeURIComponent(token)}`,
        { method: "DELETE", accessToken },
      ),
    getPreferences: (accessToken: AccessToken) =>
      apiFetch<NotificationPreferences>("/v1/notifications/preferences", {
        accessToken,
      }),
    updatePreferences: (
      accessToken: AccessToken,
      body: NotificationPreferencesUpdateRequest,
    ) =>
      apiFetch<NotificationPreferences>("/v1/notifications/preferences", {
        method: "PUT",
        body,
        accessToken,
      }),
    // 인앱 알림함.
    list: (
      accessToken: AccessToken,
      params: { cursor?: string; limit?: number } = {},
    ) =>
      apiFetch<NotificationListResponse>(
        `/v1/notifications${buildQuery({
          cursor: params.cursor,
          limit: params.limit,
        })}`,
        { accessToken },
      ),
    unreadCount: (accessToken: AccessToken) =>
      apiFetch<NotificationUnreadCount>("/v1/notifications/unread-count", {
        accessToken,
      }),
    markRead: (accessToken: AccessToken, id: string) =>
      apiFetch<{ success: true }>(
        `/v1/notifications/${encodeURIComponent(id)}/read`,
        { method: "POST", accessToken },
      ),
    markAllRead: (accessToken: AccessToken) =>
      apiFetch<{ success: true }>("/v1/notifications/read-all", {
        method: "POST",
        accessToken,
      }),
  },

  devices: {
    list: (accessToken: AccessToken, householdId: string) =>
      apiFetch<DeviceSummary[]>(
        `/v1/devices${buildQuery({ householdId })}`,
        { accessToken },
      ),
    register: (accessToken: AccessToken, body: DeviceRegisterRequest) =>
      apiFetch<DeviceSecretResponse>("/v1/devices/register", {
        method: "POST",
        body,
        accessToken,
      }),
    rotate: (accessToken: AccessToken, id: string) =>
      apiFetch<DeviceSecretResponse>(`/v1/devices/${id}/rotate-secret`, {
        method: "POST",
        accessToken,
      }),
    revoke: (accessToken: AccessToken, id: string) =>
      apiFetch<{ revoked: true }>(`/v1/devices/${id}`, {
        method: "DELETE",
        accessToken,
      }),
  },

  cards: {
    list: (accessToken: AccessToken, householdId: string) =>
      apiFetch<CardSummary[]>(`/v1/cards${buildQuery({ householdId })}`, {
        accessToken,
      }),
    // create additionally reports how many previously-unlinked transactions the
    // registration retroactively linked (server-side backfill), for disclosure.
    create: (accessToken: AccessToken, body: CardCreateRequest) =>
      apiFetch<CardSummary & { linkedTransactionCount: number }>("/v1/cards", {
        method: "POST",
        body,
        accessToken,
      }),
    get: (accessToken: AccessToken, id: string) =>
      apiFetch<CardSummary>(`/v1/cards/${id}`, { accessToken }),
    update: (accessToken: AccessToken, id: string, body: CardUpdateRequest) =>
      apiFetch<CardSummary>(`/v1/cards/${id}`, {
        method: "PATCH",
        body,
        accessToken,
      }),
  },

  categories: {
    list: (accessToken: AccessToken, householdId: string) =>
      apiFetch<CategorySummary[]>(
        `/v1/categories${buildQuery({ householdId })}`,
        { accessToken },
      ),
    create: (accessToken: AccessToken, body: CategoryCreateRequest) =>
      apiFetch<CategorySummary>("/v1/categories", {
        method: "POST",
        body,
        accessToken,
      }),
    update: (accessToken: AccessToken, id: string, body: CategoryUpdateRequest) =>
      apiFetch<CategorySummary>(`/v1/categories/${id}`, {
        method: "PATCH",
        body,
        accessToken,
      }),
    delete: (accessToken: AccessToken, id: string) =>
      apiFetch<void>(`/v1/categories/${id}`, { method: "DELETE", accessToken }),
  },

  transactions: {
    list: (accessToken: AccessToken, params: TransactionListParams) =>
      apiFetch<TransactionListResponse>(
        `/v1/transactions${buildQuery({ ...params })}`,
        { accessToken },
      ),
    get: (accessToken: AccessToken, id: string) =>
      apiFetch<TransactionSummary>(`/v1/transactions/${id}`, { accessToken }),
    labelCandidates: (
      accessToken: AccessToken,
      householdId: string,
      limit = 20,
    ) =>
      apiFetch<MerchantLabelCandidateListResponse>(
        `/v1/transactions/merchant-label-candidates${buildQuery({ householdId, limit })}`,
        { accessToken },
      ),
    update: (
      accessToken: AccessToken,
      id: string,
      body: TransactionUpdateRequest,
    ) =>
      apiFetch<TransactionSummary>(`/v1/transactions/${id}`, {
        method: "PATCH",
        body,
        accessToken,
      }),
    remove: (accessToken: AccessToken, id: string) =>
      apiFetch<{ deleted: true }>(`/v1/transactions/${id}`, {
        method: "DELETE",
        accessToken,
      }),
    linkCancellation: (
      accessToken: AccessToken,
      id: string,
      body: LinkCancellationRequest,
    ) =>
      apiFetch<TransactionSummary>(
        `/v1/transactions/${id}/link-cancellation`,
        { method: "POST", body, accessToken },
      ),
    markDuplicate: (accessToken: AccessToken, id: string) =>
      apiFetch<TransactionSummary>(`/v1/transactions/${id}/mark-duplicate`, {
        method: "POST",
        accessToken,
      }),
    markValid: (accessToken: AccessToken, id: string) =>
      apiFetch<TransactionSummary>(`/v1/transactions/${id}/mark-valid`, {
        method: "POST",
        accessToken,
      }),
    /** 합계/예산에서 제외(중복 확정 등). 이력은 남는다. */
    exclude: (accessToken: AccessToken, id: string) =>
      apiFetch<TransactionSummary>(`/v1/transactions/${id}/exclude`, {
        method: "POST",
        accessToken,
      }),
    /** 제외 취소(다시 합계에 포함). */
    include: (accessToken: AccessToken, id: string) =>
      apiFetch<TransactionSummary>(`/v1/transactions/${id}/include`, {
        method: "POST",
        accessToken,
      }),
    summary: (accessToken: AccessToken, params: TransactionSummaryParams) =>
      apiFetch<TransactionSummaryResponse>(
        `/v1/transactions/summary${buildQuery({ ...params })}`,
        { accessToken },
      ),
  },

  cardSms: {
    /** 붙여넣은 문자 상태 없는 파싱 미리보기(등록 전 인식 결과 표시). */
    parsePreview: (accessToken: AccessToken, body: ManualParsePreviewRequest) =>
      apiFetch<ManualParsePreviewResponse>("/v1/card-sms/parse-preview", {
        method: "POST",
        body,
        accessToken,
      }),
    /** 문자 붙여넣기 등록(수집 파이프라인 경유, 비동기 승격). cardSmsEventId로 폴링. */
    manualText: (accessToken: AccessToken, body: ManualTextEntryRequest) =>
      apiFetch<ManualTextEntryResponse>("/v1/card-sms/manual-text", {
        method: "POST",
        body,
        accessToken,
      }),
    /** 직접 입력 거래 등록(동기) — 생성된 거래를 반환. */
    manualFields: (accessToken: AccessToken, body: ManualFieldsEntryRequest) =>
      apiFetch<TransactionSummary>("/v1/card-sms/manual-fields", {
        method: "POST",
        body,
        accessToken,
      }),
    /** manual-text 등록 후 파싱 상태 폴링(GET card-sms-events/:id). */
    eventStatus: (accessToken: AccessToken, id: string) =>
      apiFetch<CardSmsEventDetail>(`/v1/card-sms-events/${id}`, { accessToken }),
  },

  analytics: {
    monthly: (accessToken: AccessToken, params: AnalyticsParams) =>
      apiFetch<MonthlyAnalytics>(
        `/v1/analytics/monthly${buildQuery({ ...params })}`,
        { accessToken },
      ),
    categories: (accessToken: AccessToken, params: AnalyticsParams) =>
      apiFetch<CategoryBreakdown>(
        `/v1/analytics/categories${buildQuery({ ...params })}`,
        { accessToken },
      ),
    members: (accessToken: AccessToken, params: AnalyticsParams) =>
      apiFetch<MemberBreakdown>(
        `/v1/analytics/members${buildQuery({ ...params })}`,
        { accessToken },
      ),
    cards: (accessToken: AccessToken, params: AnalyticsParams) =>
      apiFetch<CardBreakdown>(
        `/v1/analytics/cards${buildQuery({ ...params })}`,
        { accessToken },
      ),
    merchants: (accessToken: AccessToken, params: AnalyticsParams) =>
      apiFetch<MerchantBreakdown>(
        `/v1/analytics/merchants${buildQuery({ ...params })}`,
        { accessToken },
      ),
  },

  budgets: {
    list: (accessToken: AccessToken, params: BudgetListParams) =>
      apiFetch<BudgetListResponse>(
        `/v1/budgets${buildQuery({ ...params })}`,
        { accessToken },
      ),
    create: (accessToken: AccessToken, body: BudgetCreateRequest) =>
      apiFetch<BudgetSummary>("/v1/budgets", {
        method: "POST",
        body,
        accessToken,
      }),
    update: (accessToken: AccessToken, id: string, body: BudgetUpdateRequest) =>
      apiFetch<BudgetSummary>(`/v1/budgets/${id}`, {
        method: "PATCH",
        body,
        accessToken,
      }),
    delete: (accessToken: AccessToken, id: string) =>
      apiFetch<void>(`/v1/budgets/${id}`, {
        method: "DELETE",
        accessToken,
      }),
  },

  ai: {
    /** 자연어 가계부 질의 — 근거(SQL 집계) 기반 해요체 답변. */
    financeQuery: (
      accessToken: AccessToken,
      body: FinanceQueryRequest,
    ) =>
      apiFetch<FinanceQueryResponse>("/v1/ai/finance-query", {
        method: "POST",
        body,
        accessToken,
      }),
    /** 월간 인사이트 — 서버 계산 사실 + LLM 문구 다듬기. */
    monthlyInsights: (
      accessToken: AccessToken,
      params: { householdId: string; month?: string },
    ) =>
      apiFetch<MonthlyInsightsResponse>(
        `/v1/ai/monthly-insights${buildQuery({ ...params })}`,
        { accessToken },
      ),
  },

  learning: {
    /** owner/admin용 원문 없는 AI 파이프라인 운영 집계. */
    operationsMetrics: (
      accessToken: AccessToken,
      params: { householdId: string; windowHours?: number },
    ) =>
      apiFetch<LearningOperationsMetricsResponse>(
        `/v1/learning/operations/metrics${buildQuery({ ...params })}`,
        { accessToken },
      ),
  },
} as const;
