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

/** `POST /v1/household-invitations/:token/accept` — accept an invitation (consent required). */
export const acceptInvitationRequestSchema = z.object({
  consent: z.literal(true),
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

// --- Responses ---

/** Household summary as seen by the requesting member. */
export const householdSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  myRole: householdRoleSchema,
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
