/**
 * Shared card-SMS extraction primitives and the {@link BaseCardParser} Strategy
 * base class. Issuer-specific parsers (`shinhan`, `kookmin`) only differ in
 * their `issuer` label and `supports()` predicate; field extraction is common
 * (Phase 3 spec §3: "동일 필드 추출"). All helpers here are order-independent
 * regex probes so they tolerate per-issuer layout differences.
 *
 * Rules enforced here:
 * - Amounts are KRW integers only (no floating point) — {@link parseAmount}.
 * - Timestamps resolve against the `Asia/Seoul` wall-clock — {@link parseOccurredAt}.
 * - `confidence` is an integer in `[0, 100]`.
 * - Merchant strings are copied raw; never invented.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

import { KNOWN_CURRENCY_CODES, toMinorUnits } from '../currency.js';

import type { CardSmsInput, CardSmsParseResult, CardSmsParser } from '../types.js';

const TIMEZONE = 'Asia/Seoul';
/** Occurred-at may legitimately trail receivedAt by clock skew; beyond this it rolled a year. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** First `12,500원` style token. Card number in parens has no `원`, so it is ignored. */
const AMOUNT_RE = /([\d,]+)\s*원/;
/** 외화 통화 코드(KRW 제외) — '원' 대신 코드로 표기되는 해외승인/해외이용 문자용. */
const FX_CODES = KNOWN_CURRENCY_CODES.filter((code) => code !== 'KRW');
const FX_CODE_ALT = FX_CODES.join('|');
/**
 * 외화 금액 — **선행 형식(`USD 22.00`) 우선**. 한국 해외승인 문자는 통화 코드가
 * 금액 앞에 오는 것이 지배적이다. 코드와 금액 사이는 같은 줄 공백(`[ \t]`)만 허용해
 * "19:31\nUSD"처럼 시각 숫자가 다음 줄 코드에 결합되는 오탐을 막는다.
 */
const FX_AMOUNT_LEADING_RE = new RegExp(`\\b(${FX_CODE_ALT})[ \\t]*([\\d,]+(?:\\.\\d+)?)`);
/**
 * 외화 금액 후행 형식(`22.00 USD`) 폴백. 시각(`19:31 USD`)·소수 뒷자리·앞 숫자에
 * 코드가 잘못 붙는 것을 lookbehind(`:`·`.`·숫자 배제)로 방어한다.
 */
const FX_AMOUNT_TRAILING_RE = new RegExp(
  `(?<![:.\\d])([\\d,]+(?:\\.\\d+)?)[ \\t]*(${FX_CODE_ALT})\\b`,
);
/** 라인 전체가 외화 금액뿐인지(가맹점 후보에서 제외). */
const FX_AMOUNT_LINE_RE = new RegExp(
  `^(?:(?:${FX_CODE_ALT})[ \\t]*[\\d,]+(?:\\.\\d+)?|[\\d,]+(?:\\.\\d+)?[ \\t]*(?:${FX_CODE_ALT}))$`,
);
/** 가맹점 앞에 붙은 선행 외화 토큰(`USD 22.00 버핏서울`)을 잘라내기 위한 패턴. */
const FX_LEADING_RE = new RegExp(`^\\s*(?:${FX_CODE_ALT})[ \\t]*[\\d,]+(?:\\.\\d+)?\\s+`);
/**
 * `MM/DD HH:mm`. 날짜 구분자는 `/`·`.`·`-`, 날짜와 시각 사이는 공백뿐 아니라
 * 구분자(공백 없는 `07/19/15:00`)도 허용한다 — 일부 발급사/중계 문자가 날짜와
 * 시각을 `/`로 이어 붙인다. 시각의 `:MM`이 시각 경계를 확정하므로 오탐이 낮다.
 */
const DATETIME_RE = /(\d{1,2})[./-](\d{1,2})[\s./-]+(\d{1,2}):(\d{2})/;
/** A line that is only a date/time, used to reject it as a merchant candidate. */
const DATE_ONLY_RE = /^\s*\d{1,2}[./-]\d{1,2}(?:\s+\d{1,2}:\d{2})?\s*$/;
/**
 * Masked card-tail probes, in priority order. Korean issuers place the trailing
 * 4 digits differently — Shinhan parenthesizes `(1234)`, others asterisk-mask
 * (`****1234`) or drop the tail onto its own line. Only explicit-masking or
 * line-isolated forms are matched; a bare 4-digit run embedded in an amount,
 * time, or date is never treated as a card number (avoids false links).
 */
/** `신한카드(1234)` -> `1234`. */
const MASKED_PAREN_RE = /\((\d{4})\)/;
/** Asterisk-masked tail anywhere: `****1234`, `*1234`, `1234**`. */
const MASKED_STAR_RE = /\*+\s*(\d{4})(?!\d)|(?<!\d)(\d{4})(?!\d)\s*\*+/;
/** A line that is *only* an (optionally asterisk-masked) 4-digit tail. */
const MASKED_LINE_RE = /^[ \t]*\*{0,4}(\d{4})[ \t]*$/m;
/** Installment term, e.g. `3개월`. */
const INSTALLMENT_MONTHS_RE = /(\d{1,2})\s*개월/;
/** Cancellation keywords are checked before approval (`승인취소` contains both). */
const CANCEL_RE = /(취소|환불)/;
/**
 * 승인거절/거부/실패 통지. `승인거절`은 `승인`도 포함하므로 approval보다 **먼저**
 * 판정해야 한다. 실제 체결이 아니므로 거래로 승격하지 않는다(processor에서 스킵).
 */
const DECLINE_RE = /(거절|거부|승인\s*실패|결제\s*실패|한도\s*초과|승인불가)/;
const APPROVE_RE = /(승인|매출|결제)/;
/** Cumulative-spend footer lines (`누적…`, `누계…`). */
const CUMULATIVE_RE = /^\s*누[적계]/;
/** Bracketed carrier headers such as `[Web발신]`. */
const BRACKET_RE = /\[[^\]]*\]/g;
const ACTION_RE = /(승인|취소|정정|매입|환불|매출)/;
const ISSUER_RE = /(신한|국민|KB|카드|하나|삼성|현대|롯데|우리|비씨|BC|씨티|농협|NH)/;

function pad2(value: string | number): string {
  return String(value).padStart(2, '0');
}

function pad4(value: number): string {
  return String(value).padStart(4, '0');
}

/**
 * Determine the transaction type. Priority matters because the keywords overlap:
 * `승인취소`(취소+승인)→cancellation, `승인거절`(거절+승인)→declined. So we test
 * cancellation, then declined, then plain approval.
 */
export function detectTransactionType(content: string): CardSmsParseResult['transactionType'] {
  if (CANCEL_RE.test(content)) return 'cancellation';
  if (DECLINE_RE.test(content)) return 'declined';
  if (APPROVE_RE.test(content)) return 'approval';
  return 'unknown';
}

/**
 * 금액을 해당 통화의 minor units 정수로 추출한다.
 *
 * 원화(`N원`)를 **우선** 시도해 기존 KRW 문자의 동작을 100% 보존하고(KRW 지수 0이라
 * minor==major), 원화 토큰이 없으면 외화(`USD 22.00` / `22.00 USD`)로 폴백해
 * ISO4217 지수만큼 스케일한 minor units + 통화 코드를 돌려준다. 부동소수는 저장하지
 * 않는다({@link toMinorUnits}가 반올림해 정수로 확정).
 */
export function parseAmount(content: string): {
  amount?: number;
  currency?: string;
  warning?: string;
} {
  const krw = content.match(AMOUNT_RE);
  if (krw) {
    const digits = krw[1].replace(/[,\s]/g, '');
    if (digits.length === 0) return { warning: 'amount not found' };
    const amount = Number(digits);
    if (!Number.isInteger(amount) || amount < 0) {
      return { warning: `amount not an integer: ${krw[1]}` };
    }
    return { amount, currency: 'KRW' };
  }

  // 선행(`USD 22.00`) 우선, 없으면 후행(`22.00 USD`).
  const lead = content.match(FX_AMOUNT_LEADING_RE);
  if (lead) {
    const { minor, warning } = toMinorUnits(lead[2], lead[1].toUpperCase());
    if (minor === undefined) return { warning: warning ?? 'amount not found' };
    return { amount: minor, currency: lead[1].toUpperCase(), warning };
  }
  const trail = content.match(FX_AMOUNT_TRAILING_RE);
  if (trail) {
    const { minor, warning } = toMinorUnits(trail[1], trail[2].toUpperCase());
    if (minor === undefined) return { warning: warning ?? 'amount not found' };
    return { amount: minor, currency: trail[2].toUpperCase(), warning };
  }

  return { warning: 'amount not found' };
}

/**
 * Resolve `MM/DD HH:mm` (no year) into an absolute instant using the Seoul-local
 * year of `receivedAt`. If the naive result lands meaningfully in the future
 * relative to `receivedAt` (December transaction received in January), roll back
 * one year (spec §3: "12->1월 롤오버 방어").
 */
export function parseOccurredAt(
  content: string,
  receivedAt: Date,
): { occurredAt?: Date; warning?: string } {
  const match = content.match(DATETIME_RE);
  if (!match) return { warning: 'timestamp not found' };
  if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
    return { warning: 'invalid receivedAt' };
  }

  const [, month, day, hour, minute] = match;
  const seoulYear = Number(formatInTimeZone(receivedAt, TIMEZONE, 'yyyy'));
  const build = (year: number): Date => {
    const wall = `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00`;
    return fromZonedTime(wall, TIMEZONE);
  };

  let occurredAt = build(seoulYear);
  if (occurredAt.getTime() > receivedAt.getTime() + FUTURE_TOLERANCE_MS) {
    occurredAt = build(seoulYear - 1);
  }
  if (Number.isNaN(occurredAt.getTime())) return { warning: 'timestamp parse failed' };
  return { occurredAt };
}

/**
 * Masked card number as `****NNNN`, or undefined when the message carries no
 * recoverable tail (e.g. the KB standard layout omits the card number entirely —
 * such transactions promote unlinked and are resolved via manual card
 * assignment). Probes parenthesized, asterisk-masked, then line-isolated forms.
 */
export function parseMaskedCardNumber(content: string): string | undefined {
  const paren = content.match(MASKED_PAREN_RE);
  if (paren) return `****${paren[1]}`;
  const star = content.match(MASKED_STAR_RE);
  if (star) return `****${star[1] ?? star[2]}`;
  const line = content.match(MASKED_LINE_RE);
  if (line) return `****${line[1]}`;
  return undefined;
}

/** Installment months: `1` for `일시불`, `N` for `N개월`, undefined otherwise. */
export function parseInstallmentMonths(content: string): number | undefined {
  if (/일시불/.test(content)) return 1;
  const match = content.match(INSTALLMENT_MONTHS_RE);
  if (!match) return undefined;
  const months = Number(match[1]);
  return Number.isInteger(months) && months > 0 ? months : undefined;
}

/** Lines that can never be a merchant (headers, amounts, dates, footers). */
function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (/^\[.*\]$/.test(trimmed)) return true;
  if (CUMULATIVE_RE.test(trimmed)) return true;
  if (/^[\d,]+\s*원/.test(trimmed)) return true;
  if (FX_AMOUNT_LINE_RE.test(trimmed)) return true;
  if (DATE_ONLY_RE.test(trimmed)) return true;
  if (/^(일시불|\d{1,2}\s*개월)$/.test(trimmed)) return true;
  if (/^\*+\d{3,4}$/.test(trimmed) || /^\d{4}$/.test(trimmed)) return true;
  // Issuer + action header line (e.g. `신한카드(1234)승인`); requires both so a
  // merchant that merely contains an issuer word (e.g. `신한서적`) is kept.
  if (ACTION_RE.test(trimmed) && ISSUER_RE.test(trimmed)) return true;
  return false;
}

function firstMerchant(text: string): string | undefined {
  for (const line of text.split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (!isNoiseLine(trimmed)) return trimmed;
  }
  return undefined;
}

function lastMerchant(text: string): string | undefined {
  let candidate: string | undefined;
  for (const line of text.split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (!isNoiseLine(trimmed)) candidate = trimmed;
  }
  return candidate;
}

/**
 * 가맹점 뒤에 이어 붙은 금액 토큰(및 그 이후)을 제거한다. 모든 필드가 한 줄인
 * 레이아웃(`… 버핏서울 106,000원`)에서 가맹점 라인이 금액까지 삼키는 것을 막는다.
 * 가맹점이 별도 줄인 정상 케이스에는 금액이 없어 영향이 없다.
 */
function stripTrailingAmount(merchant: string): string {
  return merchant.replace(/\s*[\d,]+\s*원.*$/, '').trim();
}

/**
 * 가맹점 앞에 선행하는 외화 금액 토큰(`USD 22.00 ANTHROPIC*CLAUDESUB`)을 제거한다.
 * 외화는 원화(후행 `N원`)와 달리 코드가 가맹점 앞에 오는 레이아웃이 흔하므로,
 * 후행 제거({@link stripTrailingAmount})와 별개로 선행 제거가 필요하다.
 */
function stripLeadingForeignAmount(merchant: string): string {
  return merchant.replace(FX_LEADING_RE, '').trim();
}

/**
 * Extract the raw merchant token. Card SMS place the merchant right after the
 * timestamp (same line or the following line), so the primary strategy is "first
 * meaningful token after the datetime". Falls back to the last meaningful line
 * when no timestamp is present. Never fabricates a merchant.
 */
export function extractMerchant(content: string): string | undefined {
  // 선행 외화 토큰 → 후행 원화 토큰 순으로 제거(외화=선행, 원화=후행 레이아웃 차이).
  const strip = (s: string): string => stripTrailingAmount(stripLeadingForeignAmount(s));
  const cleaned = content.replace(BRACKET_RE, '\n');
  const match = cleaned.match(DATETIME_RE);
  if (match && match.index !== undefined) {
    const tail = cleaned.slice(match.index + match[0].length);
    const merchant = firstMerchant(tail);
    if (merchant) {
      const stripped = strip(merchant);
      if (stripped) return stripped;
    }
  }
  const last = lastMerchant(cleaned);
  if (last) {
    const stripped = strip(last);
    if (stripped) return stripped;
  }
  return undefined;
}

/**
 * Confidence heuristic (spec §3): all required fields present -> 100; each
 * missing field deducts; an unrecognized transaction type is heavily penalized.
 * Always returns an integer in `[0, 100]`.
 */
export function computeConfidence(result: CardSmsParseResult): number {
  let confidence = 100;
  if (result.transactionType === 'unknown') confidence -= 45;
  if (result.amount === undefined) confidence -= 25;
  if (result.occurredAt === undefined) confidence -= 20;
  if (result.merchantRaw === undefined) confidence -= 15;
  return Math.max(0, Math.min(100, Math.round(confidence)));
}

/** Assemble a full parse result for a matched issuer. */
export function buildResult(issuer: string, input: CardSmsInput): CardSmsParseResult {
  const warnings: string[] = [];

  const transactionType = detectTransactionType(input.content);
  if (transactionType === 'unknown') warnings.push('transaction type not recognized');

  const { amount, currency, warning: amountWarning } = parseAmount(input.content);
  if (amountWarning) warnings.push(amountWarning);

  const { occurredAt, warning: timeWarning } = parseOccurredAt(input.content, input.receivedAt);
  if (timeWarning) warnings.push(timeWarning);

  const merchantRaw = extractMerchant(input.content);
  if (merchantRaw === undefined) warnings.push('merchant not found');

  const result: CardSmsParseResult = {
    issuer,
    transactionType,
    amount,
    currency: amount !== undefined ? (currency ?? 'KRW') : undefined,
    merchantRaw,
    occurredAt,
    maskedCardNumber: parseMaskedCardNumber(input.content),
    installmentMonths: parseInstallmentMonths(input.content),
    confidence: 0,
    warnings,
  };
  result.confidence = computeConfidence(result);
  return result;
}

/**
 * Strategy base class. Subclasses declare their `issuer` label and `supports()`
 * predicate; the common {@link buildResult} pipeline does the field extraction.
 */
export abstract class BaseCardParser implements CardSmsParser {
  abstract readonly issuer: string;

  abstract supports(input: CardSmsInput): boolean;

  parse(input: CardSmsInput): CardSmsParseResult {
    return buildResult(this.issuer, input);
  }
}
