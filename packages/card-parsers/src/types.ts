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
/**
 * 승인거절 사유. **사유마다 사용자가 할 일이 다르기 때문에** 별도 필드로 남긴다 —
 * `lost_or_stolen`은 정기결제 수단을 갱신해야 하고, `insufficient_balance`는 입금하면
 * 되고, `limit_exceeded`는 한도를 올리거나 다른 카드를 써야 한다. "거절됨"만 알려주면
 * 사용자는 카드사 앱을 따로 열어봐야 한다.
 *
 * 실측 계기(2026-07): `분실카드 승인거절 ... OO피트니스 99,000원`이 7일 연속(매일 15:00)
 * 발생했다 — 분실 신고한 카드로 정기결제가 계속 시도되다 가맹점이 포기한 것인데,
 * 앱은 이 사실을 한 번도 보여주지 못했다.
 */
export type CardSmsDeclineReason =
  | 'lost_or_stolen'
  | 'limit_exceeded'
  | 'insufficient_balance'
  | 'expired_card'
  | 'suspended'
  | 'invalid_credential'
  | 'unknown';

export interface CardSmsParseResult {
  /** Card issuer label, e.g. `신한카드` / `KB국민카드`. */
  issuer?: string;
  /**
   * Approval vs cancellation vs declined vs undetermined. `declined`는 승인거절/
   * 거부/승인실패처럼 실제 체결되지 않은 통지 — 거래로 승격하지 않는다(소비 아님).
   */
  transactionType: 'approval' | 'cancellation' | 'declined' | 'unknown';
  /**
   * `transactionType === 'declined'`일 때의 사유. 문구를 못 알아보면 `'unknown'`이고,
   * 거절이 아닌 문자에서는 `undefined`다(둘을 구분해야 "사유 파싱 실패"를 셀 수 있다).
   */
  declineReason?: CardSmsDeclineReason;
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
