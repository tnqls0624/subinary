import { z } from 'zod';

/**
 * Payment-card visibility (PRD §8, §26; mirrors DB `cardVisibility`).
 * A transaction inherits its card's visibility (`household` when unlinked).
 */
export const cardVisibilitySchema = z.enum(['private', 'household', 'summary_only']);
export type CardVisibility = z.infer<typeof cardVisibilitySchema>;

/** Card lifecycle status (mirrors DB `cardStatus`). Inactive cards stop auto-linking. */
const cardStatusSchema = z.enum(['active', 'inactive']);

// --- Requests ---

/**
 * `POST /v1/cards` — register a payment card under a household (PRD §31 Phase 4).
 * `maskedNumber` carries **only the last 4 digits** (auto-linking matches on them);
 * the `^\d{4}$` guard rejects a full PAN or any masked/formatted value server-side.
 */
export const cardCreateRequestSchema = z.object({
  householdId: z.string().uuid(),
  issuer: z.string().min(1).max(50),
  alias: z.string().min(1).max(100),
  maskedNumber: z
    .string()
    .regex(/^\d{4}$/, 'maskedNumber must be exactly the last 4 digits')
    .optional(),
  visibility: cardVisibilitySchema.default('household'),
});
export type CardCreateRequest = z.infer<typeof cardCreateRequestSchema>;

/** `PATCH /v1/cards/:id` — update a card's alias, visibility, or status. */
export const cardUpdateRequestSchema = z.object({
  alias: z.string().min(1).max(100).optional(),
  visibility: cardVisibilitySchema.optional(),
  status: cardStatusSchema.optional(),
});
export type CardUpdateRequest = z.infer<typeof cardUpdateRequestSchema>;

// --- Responses ---

/** Public-safe card projection. Never carries the card fingerprint. */
export const cardSummarySchema = z.object({
  id: z.string(),
  householdId: z.string(),
  ownerMemberId: z.string(),
  issuer: z.string(),
  alias: z.string(),
  maskedNumber: z.string().nullable(),
  visibility: cardVisibilitySchema,
  status: cardStatusSchema,
  createdAt: z.string(),
});
export type CardSummary = z.infer<typeof cardSummarySchema>;
