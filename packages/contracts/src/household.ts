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
