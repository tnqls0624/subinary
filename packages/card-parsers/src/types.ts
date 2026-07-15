/**
 * Public types for `@family/card-parsers`.
 *
 * This package is intentionally free of any dependency on `@family/contracts`
 * or `@family/shared` (Phase 3 spec §1.3): parsers are pure `string -> result`
 * functions, so they own their own input/output shapes to avoid import cycles
 * and to keep the worker's dependency graph small (no pino, no zod).
 */

/** Raw inbound card SMS as forwarded by a registered device. */
export interface CardSmsInput {
  /** Originating sender id (carrier number / short code). Not PII-sensitive. */
  sender: string;
  /** Raw message body, exactly as received. */
  content: string;
  /**
   * Absolute instant the SMS was received (UTC internally). Used to resolve the
   * year for `MM/DD HH:mm` timestamps that carry no year.
   */
  receivedAt: Date;
}

/**
 * Structured result of parsing a single card SMS.
 *
 * Monetary values are KRW integers (no floating point). `occurredAt` is an
 * absolute instant resolved against the `Asia/Seoul` wall-clock in the message.
 * `confidence` is an integer in `[0, 100]`.
 */
export interface CardSmsParseResult {
  /** Card issuer label, e.g. `신한카드` / `KB국민카드`. */
  issuer?: string;
  /** Approval vs cancellation vs undetermined. */
  transactionType: 'approval' | 'cancellation' | 'unknown';
  /** Transaction amount as a KRW integer. */
  amount?: number;
  /** ISO 4217 currency code; always `KRW` when an amount was parsed. */
  currency?: string;
  /** Raw merchant / aggregator string exactly as it appeared (never invented). */
  merchantRaw?: string;
  /** Transaction instant, resolved from the `Asia/Seoul` wall-clock time. */
  occurredAt?: Date;
  /** Masked card number derived from the message, e.g. `****1234`. */
  maskedCardNumber?: string;
  /** Installment months; `1` for lump-sum (`일시불`), `N` for `N개월`. */
  installmentMonths?: number;
  /** Extraction confidence, integer `[0, 100]`. */
  confidence: number;
  /** Non-fatal notes (missing fields, aggregator ambiguity, ...). */
  warnings: string[];
}

/** Strategy interface implemented by every issuer-specific parser. */
export interface CardSmsParser {
  /** Human-readable issuer label used when this parser matches. */
  readonly issuer: string;
  /** Whether this parser recognizes the given message. */
  supports(input: CardSmsInput): boolean;
  /** Parse the message into a structured result. */
  parse(input: CardSmsInput): CardSmsParseResult;
}
