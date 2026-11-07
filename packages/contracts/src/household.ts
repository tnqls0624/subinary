import { z } from 'zod';

/** Full household role hierarchy (PRD §7.2). */
export const householdRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export type HouseholdRole = z.infer<typeof householdRoleSchema>;

/**
 * Roles an owner may assign via invitation or role change.
 * `owner` is excluded — ownership transfer is out of scope for Phase 1.
 */
const invitableRoleSchema = z.enum(['admin', 'member', 'viewer']);

/** Membership lifecycle status. */
const memberStatusSchema = z.enum(['active', 'removed']);

/**
 * Member accent-color palette keys. The web maps each key to a fixed
 * light/dark Tailwind class pair; `null` means "auto" (hash-derived).
 */
export const memberColorSchema = z.enum([
  'rose',
  'orange',
  'amber',
  'emerald',
  'teal',
  'sky',
  'violet',
  'fuchsia',
]);
export type MemberColor = z.infer<typeof memberColorSchema>;

/** Invitation lifecycle status. */
const invitationStatusSchema = z.enum(['pending', 'accepted', 'revoked', 'expired']);

// --- Requests ---

/** `POST /v1/households` — create a household. */
export const householdCreateRequestSchema = z.object({
  name: z.string().min(1).max(100),
});
export type HouseholdCreateRequest = z.infer<typeof householdCreateRequestSchema>;

/** `PATCH /v1/households/:id` — rename a household. */
export const householdUpdateRequestSchema = z.object({
  name: z.string().min(1).max(100),
});
export type HouseholdUpdateRequest = z.infer<typeof householdUpdateRequestSchema>;

/** `POST /v1/households/:id/invitations` — create an invitation (owner only). */
export const invitationCreateRequestSchema = z.object({
  email: z.string().email().optional(),
  role: invitableRoleSchema.default('member'),
  expiresInHours: z.number().int().min(1).max(720).default(168),
});
export type InvitationCreateRequest = z.infer<typeof invitationCreateRequestSchema>;

/**
 * `POST /v1/household-invitations/:token/accept` — accept an invitation.
 * 가족 가입 동의 절차는 2026-11-05에 없앴다(소유자 결정). 옛 앱 번들은 `consent: true`를
 * 보내므로 받기만 하고 쓰지 않는다.
 */
export const acceptInvitationRequestSchema = z.object({
  consent: z.literal(true).optional(),
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

/**
 * `PATCH /v1/households/:id/members/:memberId` — change a member's role.
 * Promotion/demotion to/from `owner` is unsupported in Phase 1.
 */
export const memberRoleUpdateRequestSchema = z.object({
  role: invitableRoleSchema,
});
export type MemberRoleUpdateRequest = z.infer<typeof memberRoleUpdateRequestSchema>;

/**
 * `PATCH /v1/households/:id/members/:memberId/color` — set a member's accent
 * color. `null` resets to the automatic (hash-derived) color.
 */
export const memberColorUpdateRequestSchema = z.object({
  color: memberColorSchema.nullable(),
});
export type MemberColorUpdateRequest = z.infer<typeof memberColorUpdateRequestSchema>;

/**
 * `PATCH /v1/households/:id/shared-color` — 공용 카드 결제의 표시 색.
 * `null`이면 중립 회색(기본)으로 되돌린다.
 *
 * 구성원 색과 같은 팔레트를 쓴다. 겹쳐도 막지 않는다 — 사용자가 "공용을 아내 색과
 * 같게" 두고 싶을 수 있고, 그것을 시스템이 금지하면 이유를 설명할 수 없다.
 */
export const householdSharedColorUpdateRequestSchema = z.object({
  color: memberColorSchema.nullable(),
});
export type HouseholdSharedColorUpdateRequest = z.infer<
  typeof householdSharedColorUpdateRequestSchema
>;

// --- Responses ---

/** Household summary as seen by the requesting member. */
export const householdSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  myRole: householdRoleSchema,
  /** 공용 카드 결제의 표시 색. null이면 중립 회색(기본). */
  sharedColor: memberColorSchema.nullable(),
});
export type HouseholdSummary = z.infer<typeof householdSummarySchema>;

/** One active household membership entry (used by `GET /v1/auth/me`). */
export const householdMembershipSummarySchema = z.object({
  householdId: z.string(),
  name: z.string(),
  role: householdRoleSchema,
  status: memberStatusSchema,
});
export type HouseholdMembershipSummary = z.infer<typeof householdMembershipSummarySchema>;

/** A member row for `GET /v1/households/:id/members`. */
export const memberSummarySchema = z.object({
  memberId: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string().email(),
  role: householdRoleSchema,
  status: memberStatusSchema,
  color: memberColorSchema.nullable(),
  joinedAt: z.string(),
});
export type MemberSummary = z.infer<typeof memberSummarySchema>;

/** Invitation creation response — `token` (raw) is exposed exactly once. */
export const invitationCreatedSchema = z.object({
  invitationId: z.string(),
  token: z.string(),
  expiresAt: z.string(),
  role: householdRoleSchema,
  acceptUrlPath: z.string(),
});
export type InvitationCreated = z.infer<typeof invitationCreatedSchema>;

/**
 * `GET /v1/household-invitations/:token` — 수락 전 미리보기.
 *
 * **비인증 공개 경로다.** 토큰을 아는 사람에게만 응답하지만, 초대 링크는 메신저·
 * 메일로 전달되며 그 대화방에 남는다. 그래서 노출 범위를 이렇게 나눴다.
 *
 * - `householdName`: 그대로 준다. "어느 가족이 초대했는지"가 이 화면의 존재 이유고,
 *   사용자가 직접 지은 별칭('우리집')이라 개인 식별력이 낮다.
 * - `inviterName`: **가운데를 가린다**(`홍*동`). 받는 사람은 누가 보냈는지 이미 알기
 *   때문에 확인에는 충분하고, 링크가 흘러나갔을 때 수집되는 값은 줄어든다.
 * - `email`: 절대 주지 않는다. 지정 초대인지 여부(`emailRestricted`)만 알린다 —
 *   "다른 계정으로 로그인하면 거절돼요"를 안내하는 데는 이 불리언이면 된다.
 * - `pending`이 아니면(수락·취소·만료) 위 정보를 **전부 `null`로 막는다.** 이미 죽은
 *   링크로 가족 정보를 계속 조회할 수 있으면 토큰 하나가 영구 조회권이 된다.
 *   상태와 만료 시각만 남겨 화면이 정확한 사유를 안내하게 한다.
 */
export const invitationPreviewSchema = z.object({
  status: invitationStatusSchema,
  /** 만료 시각(ISO). 시각만으로는 가족을 특정할 수 없어 상태와 무관하게 준다. */
  expiresAt: z.string(),
  /** 가족 이름. `pending`이 아니면 `null`. */
  householdName: z.string().nullable(),
  /** 초대한 사람의 마스킹된 이름. `pending`이 아니면 `null`. */
  inviterName: z.string().nullable(),
  /** 수락 시 부여될 역할. `pending`이 아니면 `null`. */
  role: householdRoleSchema.nullable(),
  /** 특정 이메일 앞으로 온 초대인지. 이메일 자체는 노출하지 않는다. */
  emailRestricted: z.boolean(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/** Invitation listing entry (never exposes the raw token). */
export const invitationSummarySchema = z.object({
  id: z.string(),
  email: z.string().email().nullable(),
  role: householdRoleSchema,
  status: invitationStatusSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type InvitationSummary = z.infer<typeof invitationSummarySchema>;

/* -------------------------------------------------------------------------- */
/* 개인정보 Control Center — 버전된 동의 + 즉시 철회 (C-3 1단계)                */
/* -------------------------------------------------------------------------- */

/** 동의 종류. 지금은 가족 합류 동의 하나뿐이다(DB `consent_type`과 같은 값). */
export const householdConsentTypeSchema = z.enum(['household_join']);
export type HouseholdConsentType = z.infer<typeof householdConsentTypeSchema>;

/** 동의 행의 상태. 철회는 삭제가 아니라 이 전이로 남는다. */
export const householdConsentStatusSchema = z.enum(['granted', 'revoked']);
export type HouseholdConsentStatus = z.infer<typeof householdConsentStatusSchema>;

/** 철회 사유. 사후에 "왜 끊겼는지"를 설명할 수 있어야 한다. */
export const householdConsentRevokeReasonSchema = z.enum([
  /** 사용자가 Control Center에서 직접 철회했다. */
  'user_request',
  /** 가구에서 제거되었다(본인 탈퇴 포함). 동의의 대상 관계 자체가 끝났다. */
  'member_removed',
]);
export type HouseholdConsentRevokeReason = z.infer<
  typeof householdConsentRevokeReasonSchema
>;

/**
 * **현재 유효한 동의 문구 버전.**
 *
 * DB(`household_consents.consent_version`)에는 이 문자열만 남고, 사용자가 실제로 읽은
 * 문구 원문은 아래 {@link householdConsentDocuments}에서 되짚는다. 그래서 규칙은 하나다 —
 * **문구를 한 글자라도 고치면 반드시 버전을 올리고 이전 버전 문서를 지우지 않는다.**
 * 지우면 "이 사람이 무엇에 동의했는가"를 답할 수 없게 된다.
 *
 * 왜 contracts에 문구 본문이 있는가: api(버전 기록)와 web(문구 표시)이 같은 출처를
 * 봐야 하는데 두 앱이 함께 의존하는 패키지가 여기뿐이다. 서버가 v2를 기록하는데
 * 화면은 v1 문구를 보여주는 상황을 타입으로 막는 것이 목적이다.
 */
export const CURRENT_HOUSEHOLD_CONSENT_VERSION = 'v3';

/** 동의 문구의 한 조항. */
export const householdConsentClauseSchema = z.object({
  title: z.string(),
  body: z.string(),
});
export type HouseholdConsentClause = z.infer<typeof householdConsentClauseSchema>;

/** 버전 하나의 동의 문구 원문. */
export const householdConsentDocumentSchema = z.object({
  version: z.string(),
  /** 체크박스 옆 한 줄(동의 행위의 이름). */
  headline: z.string(),
  clauses: z.array(householdConsentClauseSchema),
});
export type HouseholdConsentDocument = z.infer<
  typeof householdConsentDocumentSchema
>;

/**
 * 버전별 동의 문구 원문 레지스트리 — **추가만 하고 지우지 않는다.**
 *
 * ⚠️ 문구는 서비스가 실제로 하는 일만 적는다. 지키지 못할 보관·삭제 약속을 쓰지 않는다.
 */
export const householdConsentDocuments: Readonly<
  Record<string, HouseholdConsentDocument>
> = {
  /** 최초 문구. 가족 열람만 알렸고 문자 수집·보관은 설명하지 않았다. */
  v1: {
    version: 'v1',
    headline: '가족 데이터 공유에 동의해요',
    clauses: [
      {
        title: '가족끼리 열람',
        body: '공동 지출과 예산을 가족끼리 서로 열람할 수 있어요.',
      },
    ],
  },
  /**
   * 문자 수집·원문 보관·철회를 명시한 개정판(C-3 1단계).
   * 자동 삭제가 없던 시점이라 그렇게 적혀 있다 — 지우지 않는다.
   */
  v2: {
    version: 'v2',
    headline: '가족 데이터 공유와 카드 문자 수집에 동의해요',
    clauses: [
      {
        title: '가족끼리 열람',
        body: '공동 지출과 예산을 가족 구성원이 서로 볼 수 있어요.',
      },
      {
        title: '카드 문자 수집',
        body: '내가 등록한 기기가 보낸 카드사 결제 문자를 받아 거래로 정리해요. 등록하지 않은 기기에서는 수집되지 않아요.',
      },
      {
        title: '문자 원문 보관',
        body: '수집한 문자의 원문이 데이터베이스와 파일 저장소에 함께 보관돼요. 지금은 보관 기간 제한이나 자동 삭제가 없어요.',
      },
      {
        title: '언제든 철회',
        body: '더보기 › 개인정보에서 언제든 철회할 수 있어요. 철회하면 등록된 기기가 즉시 해제되어 새 문자 수집이 멈춰요. 다만 이미 보관된 문자 원문은 이 화면에서 지워지지 않아요.',
      },
    ],
  },
  /**
   * 보존 정책 선택·원문 자동 삭제를 명시한 개정판(SOO-34 / C-3 본체).
   * 개정은 재동의 요청이지 동의 취소가 아니다(ADR-0028).
   */
  v3: {
    version: 'v3',
    headline: '가족 데이터 공유와 카드 문자 수집에 동의해요',
    clauses: [
      {
        title: '가족끼리 열람',
        body: '공동 지출과 예산을 가족 구성원이 서로 볼 수 있어요.',
      },
      {
        title: '카드 문자 수집',
        body: '내가 등록한 기기가 보낸 카드사 결제 문자를 받아 거래로 정리해요. 등록하지 않은 기기에서는 수집되지 않아요.',
      },
      {
        title: '문자 원문 보관',
        body: '수집한 문자의 원문이 데이터베이스와 파일 저장소에 함께 보관돼요. 더보기 › 개인정보에서 원문을 얼마나 남길지 고를 수 있고, 고른 정책에 맞는 원문은 자동으로 지워져요. 거래·금액·분류 결과는 지우지 않아요.',
      },
      {
        title: '언제든 철회',
        body: '더보기 › 개인정보에서 언제든 철회할 수 있어요. 철회하면 등록된 기기가 즉시 해제되어 새 문자 수집이 멈춰요. 이미 보관된 문자 원문은 철회로 한꺼번에 지워지지 않고, 선택한 보존 정책에 따라 지워져요.',
      },
    ],
  },
};

/** 화면에 보여줄 현재 문구. 레지스트리와 상수가 어긋나면 여기서 바로 드러난다. */
export const currentHouseholdConsentDocument: HouseholdConsentDocument =
  householdConsentDocuments[CURRENT_HOUSEHOLD_CONSENT_VERSION] as HouseholdConsentDocument;

/** 동의 이력 한 줄(append-only). `granted` 행이 나중에 `revoked`로 전이한다. */
export const householdConsentRecordSchema = z.object({
  id: z.string(),
  consentType: householdConsentTypeSchema,
  version: z.string(),
  status: householdConsentStatusSchema,
  consentedAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
  /** 이 버전의 문구 원문이 코드에 남아 있는가. false면 화면이 원문을 못 보여준다. */
  documentAvailable: z.boolean(),
});
export type HouseholdConsentRecord = z.infer<typeof householdConsentRecordSchema>;

/**
 * 문자 원문 자동 삭제 정책(SOO-34 / 로드맵 C-3).
 *
 * - `none`: 계속 — 자동 삭제 없음(기존 기본값, 이름 유지로 마이그레이션 없이 호환)
 * - `days_30`: 수신 시각 기준 30일이 지난 원문 삭제
 * - `after_parse`: 파싱 성공(`parsed`) 원문 삭제
 * - `failures_only`: 실패·처리 중만 남기고 성공·비거래(`parsed`/`ignored`) 원문 삭제
 */
export const retentionPolicySchema = z.enum([
  'none',
  'days_30',
  'after_parse',
  'failures_only',
]);
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

/** 원문 purge 이력 한 줄 — 본문은 절대 포함하지 않는다. 실패 건수를 남긴다. */
export const smsRawPurgeLogSchema = z.object({
  id: z.string(),
  policy: retentionPolicySchema,
  purgedEventCount: z.number().int(),
  purgedSuppressionCount: z.number().int(),
  failedEventCount: z.number().int(),
  failedSuppressionCount: z.number().int(),
  status: z.enum(['completed', 'failed']),
  triggeredBy: z.enum(['user', 'scheduler']),
  createdAt: z.string(),
});
export type SmsRawPurgeLog = z.infer<typeof smsRawPurgeLogSchema>;

/** "지금 무엇이 얼마나 보관되어 있는가" + 선택한 보존 정책. */
export const privacyRetentionSchema = z.object({
  policy: retentionPolicySchema,
  /** 원문 사본이 아직 남은 카드 문자 건수. */
  smsEventCount: z.number().int(),
  /** 파일 저장소에 올라간 원문의 총 바이트(집계 기준: source_items.size_bytes). */
  storedBytes: z.number().int(),
  /** 가장 오래된/최근 수신 시각(ISO). 보관 건이 없으면 null. */
  oldestReceivedAt: z.string().nullable(),
  newestReceivedAt: z.string().nullable(),
  /** 파일 저장소에서 이 가구의 원문이 쌓이는 경로 접두사. */
  objectKeyPrefix: z.string(),
  /** 최근 삭제 이력(최신순, 소수). 원문 본문 없음. */
  recentPurges: z.array(smsRawPurgeLogSchema),
});
export type PrivacyRetention = z.infer<typeof privacyRetentionSchema>;

/**
 * `POST /v1/households/:id/privacy/retention/preview` — 정책 변경 전 영향 미리보기.
 * 미리보기와 실제 삭제가 같은 판정 함수를 쓴다.
 */
export const privacyRetentionPreviewRequestSchema = z.object({
  policy: retentionPolicySchema,
});
export type PrivacyRetentionPreviewRequest = z.infer<
  typeof privacyRetentionPreviewRequestSchema
>;

export const privacyRetentionPreviewResponseSchema = z.object({
  policy: retentionPolicySchema,
  matchingEventCount: z.number().int(),
  matchingSuppressionCount: z.number().int(),
  /** 이 정책이 앞으로 하는 일(화면 문구). */
  effectSummary: z.string(),
});
export type PrivacyRetentionPreviewResponse = z.infer<
  typeof privacyRetentionPreviewResponseSchema
>;

/**
 * `POST /v1/households/:id/privacy/retention` — 정책 적용.
 * `confirm: true`와 미리보기 건수가 같아야 한다(어긋나면 409).
 */
export const privacyRetentionUpdateRequestSchema = z.object({
  policy: retentionPolicySchema,
  confirm: z.literal(true),
  expectedEventCount: z.number().int().nonnegative(),
  expectedSuppressionCount: z.number().int().nonnegative(),
});
export type PrivacyRetentionUpdateRequest = z.infer<
  typeof privacyRetentionUpdateRequestSchema
>;

/** `GET /v1/households/:id/privacy` — Control Center가 읽는 전체 현황. */
export const privacyOverviewSchema = z.object({
  householdId: z.string(),
  /** 코드가 정의한 현재 문구 버전. */
  currentVersion: z.string(),
  /** 지금 유효한 동의. 한 번도 동의한 적 없거나 철회했으면 null. */
  activeConsent: householdConsentRecordSchema.nullable(),
  /** 유효한 동의는 있으나 문구가 개정됐다 → 재동의 요청. */
  needsRenewal: z.boolean(),
  /** append-only 이력 전체(최신순). */
  history: z.array(householdConsentRecordSchema),
  retention: privacyRetentionSchema,
  /**
   * 내 멤버십 id. 화면이 기기 목록에서 "내 기기"와 "가족의 다른 기기"를 갈라야 하는데,
   * `/v1/auth/me`의 멤버십 요약에는 memberId가 없어 여기서 함께 준다.
   */
  myMemberId: z.string(),
  /** 내 이름으로 등록되어 지금 수집 중인 기기 수. */
  myActiveDeviceCount: z.number().int(),
});
export type PrivacyOverview = z.infer<typeof privacyOverviewSchema>;

export const privacyRetentionUpdateResponseSchema = z.object({
  overview: privacyOverviewSchema,
  purgedEventCount: z.number().int(),
  purgedSuppressionCount: z.number().int(),
  failedEventCount: z.number().int(),
  failedSuppressionCount: z.number().int(),
});
export type PrivacyRetentionUpdateResponse = z.infer<
  typeof privacyRetentionUpdateResponseSchema
>;

/**
 * `POST /v1/households/:id/privacy/consent` — 동의(최초·재동의 공통).
 *
 * `version`을 클라이언트가 실어 보내는 이유: 캐시된 옛 화면이 v1 문구를 보여주고
 * 서버는 v2로 기록하는 어긋남을 막는다. 현재 버전이 아니면 409로 거절한다.
 */
export const privacyConsentGrantRequestSchema = z.object({
  version: z.string(),
  consent: z.literal(true),
});
export type PrivacyConsentGrantRequest = z.infer<
  typeof privacyConsentGrantRequestSchema
>;

/**
 * `POST /v1/households/:id/privacy/consent/revoke` — 철회.
 *
 * `confirm: true`를 요구하는 이유: 철회는 기기 해제를 동반해 수집이 끊긴다. 실수로
 * 도달하는 경로가 없어야 한다(되돌릴 수는 있다 — 재동의하면 기기를 다시 등록한다).
 */
export const privacyConsentRevokeRequestSchema = z.object({
  confirm: z.literal(true),
});
export type PrivacyConsentRevokeRequest = z.infer<
  typeof privacyConsentRevokeRequestSchema
>;

/** 철회 결과 — 갱신된 현황과 **실제로 해제된 기기 수**를 함께 돌려준다. */
export const privacyConsentRevokeResponseSchema = z.object({
  overview: privacyOverviewSchema,
  revokedDeviceCount: z.number().int(),
});
export type PrivacyConsentRevokeResponse = z.infer<
  typeof privacyConsentRevokeResponseSchema
>;
