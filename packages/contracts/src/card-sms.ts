import { z } from 'zod';

/** Card-SMS parsing lifecycle (PRD §31 Phase 3; mirrors DB `cardSmsParseStatus`). */
export const cardSmsParseStatusSchema = z.enum([
  'pending',
  'parsed',
  'parse_failed',
  'pending_review',
]);
export type CardSmsParseStatus = z.infer<typeof cardSmsParseStatusSchema>;

/** Card transaction kind resolved by the parser (mirrors DB `cardSmsTxnType`). */
export const cardSmsTransactionTypeSchema = z.enum([
  'approval',
  'cancellation',
  'declined',
  'unknown',
]);
export type CardSmsTransactionType = z.infer<typeof cardSmsTransactionTypeSchema>;

/** Ingest disposition — `queued` on first accept, `duplicate` on idempotent replay. */
const cardSmsProcessingStatusSchema = z.enum(['queued', 'duplicate']);

// --- Requests ---

/**
 * `POST /v1/mobile-events/card-sms` — submit a raw card SMS for parsing (PRD §10.3).
 * HMAC-guarded; the device principal supplies household/member scope.
 *
 * `receivedAt` is optional: automation tools that cannot easily format a UTC
 * ISO-8601 timestamp (e.g. Android MacroDroid, whose date variables are local
 * time) may omit it entirely — the server stamps `now()` on ingest. When
 * present it must be UTC (`Z` suffix). The parsed transaction time comes from
 * the SMS body (`MM/DD HH:mm`, no year) with the year resolved *relative to
 * receivedAt* — so a server-stamped `now()` is accurate for live forwarding,
 * but backfilling messages older than ~1 year without an explicit receivedAt
 * will resolve the wrong year. Supply receivedAt when replaying old archives.
 */
export const cardSmsIngestRequestSchema = z.object({
  // 멱등 키. 비었거나 없으면 서버가 sha256(sender+content[+receivedAt])로 파생한다
  // (card-sms-text와 동일 규칙) — 단축어/MacroDroid가 고유값을 만들기 어려운 저마찰
  // 경로를 위해. 명시하면 그 값이 우선(호출자가 멱등을 직접 제어).
  eventId: z.string().max(200).optional(),
  sender: z.string().min(1).max(100),
  content: z.string().min(1).max(4000),
  receivedAt: z.string().datetime().optional(),
});
export type CardSmsIngestRequest = z.infer<typeof cardSmsIngestRequestSchema>;

// --- Responses ---

/**
 * Ingest acknowledgement. `accepted` is always `true`; `duplicate` distinguishes
 * a fresh enqueue (`processingStatus: 'queued'`) from an idempotent replay.
 */
export const cardSmsIngestResponseSchema = z.object({
  accepted: z.literal(true),
  eventId: z.string(),
  processingStatus: cardSmsProcessingStatusSchema,
  duplicate: z.boolean(),
});
export type CardSmsIngestResponse = z.infer<typeof cardSmsIngestResponseSchema>;

/**
 * List projection for `GET /v1/card-sms-events`. Excludes the raw content —
 * that is only surfaced in the detail view. `amount` is in `currency`'s minor
 * units (KRW/JPY exponent 0, USD/EUR exponent 2); when `currency` is null treat
 * it as `KRW`. Clients format per `currency`.
 */
export const cardSmsEventSummarySchema = z.object({
  id: z.string(),
  eventId: z.string(),
  sender: z.string(),
  receivedAt: z.string(),
  parseStatus: cardSmsParseStatusSchema,
  issuer: z.string().nullable(),
  transactionType: cardSmsTransactionTypeSchema.nullable(),
  amount: z.number().int().nullable(),
  currency: z.string().nullable(),
  merchantRaw: z.string().nullable(),
  occurredAt: z.string().nullable(),
  installmentMonths: z.number().int().nullable(),
  confidence: z.number().int().nullable(),
  parseError: z.string().nullable(),
  createdAt: z.string(),
});
export type CardSmsEventSummary = z.infer<typeof cardSmsEventSummarySchema>;

/**
 * Detail projection for `GET /v1/card-sms-events/:id` — summary plus the raw
 * content (parse-failure review) and the masked card number.
 */
export const cardSmsEventDetailSchema = cardSmsEventSummarySchema.extend({
  rawContent: z.string(),
  maskedCardNumber: z.string().nullable(),
});
export type CardSmsEventDetail = z.infer<typeof cardSmsEventDetailSchema>;

/**
 * `GET /v1/mobile-events/card-sms/:eventId/status` — lightweight status poll for
 * an ingested event (device-facing).
 */
export const mobileEventStatusResponseSchema = z.object({
  eventId: z.string(),
  parseStatus: cardSmsParseStatusSchema,
  processingStatus: z.string(),
});
export type MobileEventStatusResponse = z.infer<typeof mobileEventStatusResponseSchema>;

// --- Manual entry (in-app 문자 붙여넣기 / 직접 입력) --------------------------

/**
 * `POST /v1/card-sms/parse-preview` — 붙여넣은 문자를 **상태 없이** 파싱해 미리보기.
 * DB에 아무것도 쓰지 않는다(등록 전 사용자에게 인식 결과를 보여주기 위한 용도).
 */
export const manualParsePreviewRequestSchema = z.object({
  content: z.string().min(1).max(4000),
  sender: z.string().max(100).optional(),
});
export type ManualParsePreviewRequest = z.infer<typeof manualParsePreviewRequestSchema>;

/** 파서 결과 투영. `parseable`=거래 승격 가능(금액+통화+식별된 유형) 여부. */
export const manualParsePreviewResponseSchema = z.object({
  issuer: z.string().nullable(),
  transactionType: cardSmsTransactionTypeSchema,
  amount: z.number().int().nullable(),
  currency: z.string().nullable(),
  merchantRaw: z.string().nullable(),
  occurredAt: z.string().nullable(),
  installmentMonths: z.number().int().nullable(),
  maskedCardNumber: z.string().nullable(),
  confidence: z.number().int(),
  warnings: z.array(z.string()),
  parseable: z.boolean(),
});
export type ManualParsePreviewResponse = z.infer<typeof manualParsePreviewResponseSchema>;

/**
 * `POST /v1/card-sms/manual-text` — 붙여넣은 문자를 일반 수집 파이프라인(가구별 합성
 * "수동" device 경유)으로 태운다. 워커가 파싱·승격하므로 자동 유입과 동작이 동일하다
 * (카드연결/카테고리/중복판정/예산/알림). 응답의 `cardSmsEventId`로 상태를 폴링한다.
 */
export const manualTextEntryRequestSchema = z.object({
  householdId: z.string().uuid(),
  content: z.string().min(1).max(4000),
  sender: z.string().max(100).optional(),
  receivedAt: z.string().datetime().optional(),
});
export type ManualTextEntryRequest = z.infer<typeof manualTextEntryRequestSchema>;

export const manualTextEntryResponseSchema = z.object({
  /** 멱등 키(sha256 파생). */
  eventId: z.string(),
  /** card_sms_events.id (UUID) — GET /v1/card-sms-events/:id 폴링 대상. */
  cardSmsEventId: z.string(),
  duplicate: z.boolean(),
});
export type ManualTextEntryResponse = z.infer<typeof manualTextEntryResponseSchema>;

/**
 * `POST /v1/card-sms/manual-fields` — 파싱 없이 사용자가 입력한 필드로 거래를 직접
 * 등록한다. 사용자가 카드·카테고리를 명시하므로 자동 해석 없이 그대로 저장한다.
 * v1은 승인(approval)만 지원한다. 응답은 생성된 거래(TransactionSummary).
 */
export const manualFieldsEntryRequestSchema = z.object({
  householdId: z.string().uuid(),
  /** 통화의 minor units 정수(KRW는 원 그대로). */
  amount: z.number().int().positive(),
  currency: z.string().min(3).max(3).default('KRW'),
  merchantRaw: z.string().min(1).max(200),
  occurredAt: z.string().datetime(),
  transactionType: z.literal('approval').default('approval'),
  issuer: z.string().max(50).optional(),
  installmentMonths: z.number().int().positive().max(60).optional(),
  cardId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
});
export type ManualFieldsEntryRequest = z.infer<typeof manualFieldsEntryRequestSchema>;
