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
 * Monetary values are integer **minor units** of `currency` (no floating point):
 * `major = amount / 10^exponent(currency)`. KRW/JPY have exponent 0 so minor ==
 * major (₩12,500 → 12500); USD/EUR have exponent 2 ($22.00 → 2200). `occurredAt`
 * is an absolute instant resolved against the `Asia/Seoul` wall-clock in the
 * message. `confidence` is an integer in `[0, 100]`.
 */
export interface CardSmsParseResult {
  /** Card issuer label, e.g. `신한카드` / `KB국민카드`. */
  issuer?: string;
  /**
   * Approval vs cancellation vs declined vs undetermined. `declined`는 승인거절/
   * 거부/승인실패처럼 실제 체결되지 않은 통지 — 거래로 승격하지 않는다(소비 아님).
   */
  transactionType: 'approval' | 'cancellation' | 'declined' | 'unknown';
  /** Transaction amount as an integer in `currency`'s minor units (see interface doc). */
  amount?: number;
  /** ISO 4217 currency code of `amount` (e.g. `KRW`, `USD`); set whenever an amount was parsed. */
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
