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
  // 카드 소유자(가족 구성원). 생략하면 서버가 등록자 본인으로 설정한다. 지정 시
  // 같은 household의 활성 구성원이어야 한다(서버 검증). 아이콘 색은 소유자를 따른다.
  ownerMemberId: z.string().uuid().optional(),
});
export type CardCreateRequest = z.infer<typeof cardCreateRequestSchema>;

/** `PATCH /v1/cards/:id` — update a card's alias, visibility, status, or owner. */
export const cardUpdateRequestSchema = z.object({
  alias: z.string().min(1).max(100).optional(),
  visibility: cardVisibilitySchema.optional(),
  status: cardStatusSchema.optional(),
  // 소유자 재지정. 같은 household의 활성 구성원이어야 한다(서버 검증). 아이콘 색이
  // 새 소유자 색으로 바뀐다.
  ownerMemberId: z.string().uuid().optional(),
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
