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
  ChangePasswordRequest,
  AuthResult,
  CardBreakdown,
  CardCreateRequest,
  CardSummary,
  CardUpdateRequest,
  CardSmsDeclineListResponse,
  CardSmsDeclineDismissRequest,
  CardSmsDeclineDismissResponse,
  CardSmsEventDetail,
  CardSmsReviewRequest,
  CardSmsReviewResponse,
  ManualParsePreviewRequest,
  ManualParsePreviewResponse,
  ManualTextEntryRequest,
  ManualTextEntryResponse,
  ManualFieldsEntryRequest,
  CategoryBreakdown,
  CategoryCreateRequest,
  CategorySummary,
  CategoryUpdateRequest,
  DevicePingResponse,
  DeviceRegisterRequest,
  DeviceSecretResponse,
  DeviceSummary,
  HouseholdCreateRequest,
  HouseholdSummary,
  InvitationCreateRequest,
  InvitationCreated,
  InvitationPreview,
  InvitationSummary,
  LinkCancellationRequest,
  LoginRequest,
  MemberBreakdown,
  MemberColorUpdateRequest,
  MemberRoleUpdateRequest,
  MemberSummary,
  MeResponse,
  MerchantBreakdown,
  AnalyticsMonths,
  MerchantAliasCreateRequest,
  MerchantAliasCreateResponse,
  MerchantAliasDeleteResponse,
  MerchantListResponse,
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
  SlackWorkspaceSummary,
  WorkQueryRequest,
  WorkQueryResponse,
} from "@family/contracts";

import { isNative } from "./native";

/** API 베이스 URL. 환경변수 우선, 로컬 개발 기본값 fallback. */
const API =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** apiFetch 밖에서 직접 연결이 필요한 경우(SSE 스트림 등)에 쓰는 베이스 URL. */
export const API_BASE_URL = API;

/** access token 타입 별칭(메모리 보관, 없을 수 있음). */
export type AccessToken = string | null;

/**
 * 실패한 API 응답을 표현하는 에러(HTTP status + 서버 메시지 보존).
 *
 * `message`는 **화면에 그대로 띄울 수 있는 한국어**다(아래 매핑 결과). 서버 원문은
 * 진단용으로 `serverMessage`/`body`에 남는다 — 원문이 사라지면 로그만 보고
 * 어느 예외였는지 되짚을 수 없다.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** 서버가 준 원문 메시지(대부분 영문 도메인 언어). 로그·디버깅 전용. */
  readonly serverMessage: string | null;

  constructor(
    status: number,
    message: string,
    body?: unknown,
    serverMessage?: string | null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.serverMessage = serverMessage ?? null;
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

/** 서버 에러 본문(`{ statusCode, message, error }`)에서 원문 메시지를 뽑는다(번역 전). */
function extractServerMessage(body: unknown): string | null {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = record.message;
    if (typeof message === "string" && message.length > 0) return message;
    if (Array.isArray(message) && message.length > 0) {
      return message.map((m) => String(m)).join(", ");
    }
    if (typeof record.error === "string") return record.error;
  }
  return null;
}

/**
 * 서버 도메인 메시지(영문) → 사용자 문구(한국어).
 *
 * **번역은 표현 계층(여기)에서만 한다.** API의 예외 메시지는 도메인 언어이자
 * 로그·테스트·다른 클라이언트가 함께 읽는 계약이므로, 화면 문구 때문에 서버를 고치면
 * 그쪽이 깨진다(테스트가 문자열을 검사한다). 대신 이 한 파일이 모든 화면의 에러
 * 문구를 담당한다 — 여기 한 줄이 10개 넘는 화면을 동시에 고친다.
 *
 * 표에 없는 **영문 메시지는 사용자에게 보여주지 않는다**(상태 코드 폴백으로 내려감).
 * 원문은 ApiError.serverMessage로 남으므로 진단은 그대로 가능하다. 서버가 이미 한국어로
 * 던지는 메시지(category.service 등)는 손대지 않고 통과시킨다.
 *
 * 키는 `apps/api/src`의 `throw new *Exception('...')` 중 웹에서 도달 가능한 것들이다.
 */
const SERVER_MESSAGE_KO: Readonly<Record<string, string>> = {
  // auth
  "invalid credentials": "이메일 또는 비밀번호가 맞지 않아요",
  "invalid session": "로그인이 만료됐어요. 다시 로그인해 주세요",
  unauthorized: "로그인이 필요해요",
  "email already registered": "이미 가입된 이메일이에요",
  "registration is closed": "지금은 회원가입을 받지 않아요",
  "an invitation is required to register": "가입하려면 초대 링크가 필요해요",
  "device authentication failed": "기기 인증에 실패했어요",
  // household · 구성원 · 초대
  "not a household member": "이 가족의 구성원이 아니에요",
  "insufficient role": "권한이 부족해요",
  "insufficient permission": "권한이 부족해요",
  "insufficient permission for this transaction":
    "이 거래를 수정할 권한이 없어요",
  "household owner or admin required": "가족 관리자만 할 수 있어요",
  "household not found": "가족을 찾을 수 없어요",
  "member not found": "구성원을 찾을 수 없어요",
  "member does not belong to this household": "이 가족의 구성원이 아니에요",
  "cannot change an owner role": "소유자의 역할은 바꿀 수 없어요",
  "cannot remove the last owner": "마지막 소유자는 내보낼 수 없어요",
  "cannot set color for a removed member":
    "내보낸 구성원의 색은 바꿀 수 없어요",
  "consent is required to join a household": "가족 참여에 동의가 필요해요",
  "invitation not found": "초대를 찾을 수 없어요",
  "invitation is no longer pending": "이미 처리된 초대예요",
  "invitation has already been accepted": "이미 수락된 초대예요",
  "invitation has been revoked": "취소된 초대예요",
  "invitation has expired": "만료된 초대예요",
  "invitation is for a different account": "다른 계정으로 보낸 초대예요",
  // 카드
  "card not found": "카드를 찾을 수 없어요",
  "card not found in household": "이 가족에 등록된 카드가 아니에요",
  "card does not belong to this household": "이 가족의 카드가 아니에요",
  "owner must be an active household member":
    "카드 소유자는 현재 가족 구성원이어야 해요",
  // 카테고리 · 가맹점
  "category not found": "카테고리를 찾을 수 없어요",
  "invalid category": "선택한 카테고리를 쓸 수 없어요",
  "merchant alias not found": "가맹점 묶음을 찾을 수 없어요",
  // 거래
  "transaction not found": "거래를 찾을 수 없어요",
  "transaction is not pending review": "확인이 필요한 거래가 아니에요",
  "source is not a cancellation transaction": "취소 거래가 아니에요",
  "target is not an approval transaction": "승인 거래가 아니에요",
  "cancellation is already linked": "이미 연결된 취소 거래예요",
  "transactions belong to different households":
    "서로 다른 가족의 거래는 연결할 수 없어요",
  "transactions have different currencies":
    "통화가 다른 거래는 연결할 수 없어요",
  // 예산
  "budget not found": "예산을 찾을 수 없어요",
  "a budget for this scope already exists": "같은 조건의 예산이 이미 있어요",
  // 기기
  "device not found": "기기를 찾을 수 없어요",
  // 카드문자(수동 등록 · 검토)
  "card-sms event not found": "문자 내역을 찾을 수 없어요",
  "card-sms event not found after ingest":
    "등록한 문자를 찾지 못했어요. 잠시 후 다시 시도해 주세요",
  "a transaction already exists for this card-sms event":
    "이미 거래로 등록된 문자예요",
  "amount is required for a non-declined review": "금액을 입력해 주세요",
  "occurredAt is required for a non-declined review":
    "결제 일시를 입력해 주세요",
  "merchantRaw is required for a non-declined review":
    "가맹점명을 입력해 주세요",
  // 공통(전역 ZodValidationPipe · 필수 파라미터)
  "validation failed": "입력한 내용을 다시 확인해 주세요",
  "householdid is required": "가족을 먼저 선택해 주세요",
};

/**
 * 매핑에 없는 실패의 상태 코드별 문구. 원인을 특정하지 못해도 **사용자가 다음에
 * 무엇을 할지**는 알려줄 수 있다. 429는 @fastify/rate-limit이 영문으로 내려주는
 * 경로라 여기서 잡는 게 유일한 방법이다.
 */
const STATUS_FALLBACK_KO: Readonly<Record<number, string>> = {
  400: "입력한 내용을 다시 확인해 주세요",
  401: "로그인이 필요해요",
  403: "권한이 없어요",
  404: "찾을 수 없어요",
  409: "이미 처리됐거나 중복된 요청이에요",
  410: "만료된 링크예요",
  413: "보낸 내용이 너무 커요",
  429: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요",
};

/** 이미 한국어인 메시지는 서버가 사용자에게 말하려고 쓴 것이므로 그대로 통과시킨다. */
function isKorean(message: string): boolean {
  return /[가-힣]/.test(message);
}

/** 서버 실패를 화면에 그대로 띄울 수 있는 한국어 문구로 만든다. */
function toUserMessage(status: number, serverMessage: string | null): string {
  if (serverMessage) {
    if (isKorean(serverMessage)) return serverMessage;
    const mapped = SERVER_MESSAGE_KO[serverMessage.trim().toLowerCase()];
    if (mapped) return mapped;
  }
  const fallback = STATUS_FALLBACK_KO[status];
  if (fallback) return fallback;
  if (status >= 500) {
    return "서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요";
  }
  return `요청이 실패했어요 (HTTP ${status})`;
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
    const serverMessage = extractServerMessage(parsed);
    throw new ApiError(
      response.status,
      toUserMessage(response.status, serverMessage),
      parsed,
      serverMessage,
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
  /** 가맹점·메모 부분 일치 검색어. */
  q?: string;
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
    /**
     * 비밀번호 변경. 서버가 **모든 세션을 폐기**하고 refresh 쿠키를 지우므로,
     * 호출부는 성공 후 로그아웃 처리를 해야 한다(다른 기기도 함께 로그아웃된다).
     */
    changePassword: (accessToken: AccessToken, body: ChangePasswordRequest) =>
      apiFetch<{ success: true }>("/v1/auth/change-password", {
        method: "POST",
        body,
        accessToken,
      }),
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
    /**
     * 초대 미리보기 — **비인증 공개 경로**라 accessToken을 받지 않는다.
     * 서버는 `pending`일 때만 가족명·(마스킹된) 초대자명·역할을 준다.
     */
    previewInvite: (token: string) =>
      apiFetch<InvitationPreview>(
        `/v1/household-invitations/${encodeURIComponent(token)}`,
      ),
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

  mobileEvents: {
    /**
     * 연결 테스트 — 수집 토큰(Bearer)이 유효한지만 확인한다(본문 없음).
     *
     * 로그인 access token이 아니라 **장치의 collect token**을 Bearer로 보낸다.
     * 인증 성공과 문자 수신은 다른 문제라, 이 호출로 앞쪽을 먼저 확정해야
     * 사용자가 원인을 좁힐 수 있다(로드맵 C-2 Signal Doctor).
     * 서버가 `lastSeenAt`을 갱신하므로 이후 진단에도 그대로 반영된다.
     */
    pingWithCollectToken: (collectToken: string) =>
      apiFetch<DevicePingResponse>("/v1/mobile-events/ping-token", {
        method: "POST",
        accessToken: collectToken,
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

  merchants: {
    list: (accessToken: AccessToken, householdId: string) =>
      apiFetch<MerchantListResponse>(
        `/v1/merchants${buildQuery({ householdId })}`,
        { accessToken },
      ),
    createAliases: (
      accessToken: AccessToken,
      body: MerchantAliasCreateRequest,
    ) =>
      apiFetch<MerchantAliasCreateResponse>("/v1/merchants/aliases", {
        method: "POST",
        body,
        accessToken,
      }),
    deleteAlias: (accessToken: AccessToken, id: string) =>
      apiFetch<MerchantAliasDeleteResponse>(`/v1/merchants/aliases/${id}`, {
        method: "DELETE",
        accessToken,
      }),
  },

  transactions: {
    list: (accessToken: AccessToken, params: TransactionListParams) =>
      apiFetch<TransactionListResponse>(
        `/v1/transactions${buildQuery({ ...params })}`,
        { accessToken },
      ),
    get: (accessToken: AccessToken, id: string) =>
      apiFetch<TransactionSummary>(`/v1/transactions/${id}`, { accessToken }),
    /**
     * 이 **취소** 행에 연결할 수 있는 승인 후보 전량.
     *
     * 서버가 통화·잔액·시간 역전·공개범위를 이미 걸러 준다. **자격 조건을 여기서 다시
     * 거르지 말 것** — 규칙이 두 벌이 되면 "보이는데 저장하면 거부되는" 후보가 생긴다.
     * `limit` 파라미터가 없는 것은 의도다(최근 100건만 보여 오래된 승인에 도달할 수
     * 없던 결함을 없애기 위한 엔드포인트라 상한을 두면 원점이다). `nextCursor`는 항상
     * `null` = 이게 전부라는 뜻.
     */
    cancellationCandidates: (accessToken: AccessToken, id: string) =>
      apiFetch<TransactionListResponse>(
        `/v1/transactions/${id}/cancellation-candidates`,
        { accessToken },
      ),
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
    /**
     * 격리(quarantined)·실패(parse_failed) 건을 사람이 확인·교정해 확정한다.
     * 거래를 만들고 동시에 학습 라벨을 남긴다(ADR-0023 S3).
     */
    review: (accessToken: AccessToken, id: string, body: CardSmsReviewRequest) =>
      apiFetch<CardSmsReviewResponse>(`/v1/card-sms-events/${id}/review`, {
        method: "POST",
        body,
        accessToken,
      }),
    /**
     * 실패한 결제 묶음 목록. `declined`는 거래로 승격되지 않아 거래 목록에 없으므로
     * 별도 경로로 읽는다.
     */
    declines: (accessToken: AccessToken, householdId: string) =>
      apiFetch<CardSmsDeclineListResponse>(
        `/v1/card-sms-events/declines${buildQuery({ householdId })}`,
        { accessToken },
      ),
    /**
     * 실패 묶음 확인 표시 토글. 묶음은 조회 시점 집계라 id가 없어
     * `(merchant, amount)`로 지목한다(둘 다 미파싱이면 null).
     */
    setDeclineDismissed: (
      accessToken: AccessToken,
      body: CardSmsDeclineDismissRequest,
      dismissed: boolean,
    ) =>
      apiFetch<CardSmsDeclineDismissResponse>(
        `/v1/card-sms-events/declines/${dismissed ? "dismiss" : "undismiss"}`,
        { method: "POST", body, accessToken },
      ),
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
    /**
     * 거래가 있는 달의 목록 — 월 스위처가 빈 달을 건너뛰는 데 쓴다.
     * 기간 파라미터가 없다(전 기간을 달별로 버킷팅).
     */
    months: (accessToken: AccessToken, householdId: string) =>
      apiFetch<AnalyticsMonths>(
        `/v1/analytics/months${buildQuery({ householdId })}`,
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
    /**
     * 업무 기억 질의 — 가져온 Slack 기록에 근거한 답변 + 출처(채널·시각·스니펫).
     * 근거가 없으면 서버가 `refused: true`를 돌려준다(오류가 아니다). 이 경우
     * **가계부 집계로 갈아타지 않는다** — 못 찾았다고 그대로 말한다.
     */
    workQuery: (
      accessToken: AccessToken,
      body: WorkQueryRequest,
    ) =>
      apiFetch<WorkQueryResponse>("/v1/ai/work-query", {
        method: "POST",
        body,
        accessToken,
      }),
  },

  slack: {
    /**
     * 내가 **소유한** Slack 워크스페이스 목록. 서버가
     * `workspaces.ownerUserId = 나`로 필터하므로(PRD §26) 가족 구성원은 이름도
     * message count도 볼 수 없고 빈 배열을 받는다.
     */
    listWorkspaces: (accessToken: AccessToken) =>
      apiFetch<SlackWorkspaceSummary[]>("/v1/slack/workspaces", {
        accessToken,
      }),
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
