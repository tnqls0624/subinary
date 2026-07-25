/**
 * quote-grounded 추출 (ADR-0023 §3) — LLM 환각의 구조적 차단.
 *
 * LLM은 **값을 만들지 않는다.** 원문에 있는 조각을 그대로 인용(`quote`)하고 몇 번째
 * 출현인지만 말한다. 시스템이 `indexOf`로 위치를 확정하고, 그 구간을 잘라
 * **기존 결정적 함수**(`parseAmount`/`parseOccurredAt`/`parseInstallmentMonths`)에만
 * 통과시킨다. 인용구가 원문에 없으면 그 필드는 폐기된다.
 *
 * 따라서:
 * - PRD §3.3 "계산은 LLM이 하지 않는다" — 수치는 전부 결정적 함수 산출물이다.
 * - PRD §3.1 "원문 우선" — 모든 필드가 `(start, end)`로 원문에 역추적된다.
 *
 * LLM에 오프셋을 직접 요구하지 않는 이유: 모델이 문자 인덱스를 세는 것은 신뢰도가
 * 낮다. 인용구는 모델이 잘하는 일(복사)이고, 위치 계산은 기계가 잘하는 일이다.
 *
 * 마스킹된 본문에서 고른 인용구를 **원문**에서 찾는 것이 안전한 이유는
 * {@link maskForLlm}이 길이를 보존하기 때문이다(mask.ts 불변식).
 */
import {
  computeConfidence,
  parseAmount,
  parseInstallmentMonths,
  parseMaskedCardNumber,
  parseOccurredAt,
} from './parsers/base.parser.js';

import type { CardSmsInput, CardSmsParseResult } from './types.js';

/**
 * LLM이 지목할 수 있는 필드.
 *
 * `maskedCard`가 없는 것은 의도적이다 — 카드 뒷자리는 마스킹 대상이라 LLM이 볼 수
 * 없고, 워커가 원문에서 직접 계산한다({@link buildResultFromSpans}).
 */
export type SpanField = 'amount' | 'occurredAt' | 'merchant' | 'installment';

const SPAN_FIELDS: readonly SpanField[] = ['amount', 'occurredAt', 'merchant', 'installment'];

/** 원문 인용. `occurrence`는 1부터 센다. */
export interface CardSmsQuote {
  readonly field: SpanField;
  readonly quote: string;
  readonly occurrence: number;
}

/** 원문 내 반열린 구간 `[start, end)`. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** 인용구 길이 상한. 이보다 길면 LLM이 문장을 통째로 복사한 것이라 슬롯으로 부적합. */
const MAX_QUOTE_LENGTH = 64;

/** 금액 인용구에 허용되는 최대 숫자 개수(카드번호·전화번호 오지목 차단). */
const MAX_AMOUNT_DIGITS = 15;

/**
 * 인용구를 원문 위치로 확정한다.
 *
 * 실패(원문에 없음 / 길이 위반 / occurrence 부정)는 전부 `undefined` — **값을 지어내지
 * 않는다.** 이것이 환각 차단의 마지막 관문이다.
 */
export function resolveQuote(
  text: string,
  quote: CardSmsQuote,
  maxLength: number = MAX_QUOTE_LENGTH,
): Span | undefined {
  const needle = quote?.quote;
  if (typeof needle !== 'string' || needle.length === 0 || needle.length > maxLength) {
    return undefined;
  }
  if (!Number.isInteger(quote.occurrence) || quote.occurrence < 1) return undefined;

  let index = -1;
  for (let seen = 0; seen < quote.occurrence; seen += 1) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) return undefined; // 원문에 없다 → 환각 → 폐기
  }
  return { start: index, end: index + needle.length };
}

function overlaps(left: Span, right: Span): boolean {
  return left.start < right.end && right.start < left.end;
}

function countDigits(value: string): number {
  return value.replace(/\D/g, '').length;
}

/** {@link buildResultFromSpans} 결과. `rejected`는 폐기된 필드와 사유다. */
export interface SpanExtraction {
  readonly result: CardSmsParseResult;
  readonly spans: Partial<Record<SpanField, Span>>;
  readonly rejected: string[];
}

/**
 * 확정된 span으로 파싱 결과를 조립한다.
 *
 * 값은 전부 원문 slice를 결정적 함수에 통과시켜 얻는다. 정규화에 실패한 필드는
 * 조용히 버려지고 `rejected`에 사유가 남는다 — 호출부는 이를 보고 사람 검토로 보낸다.
 *
 * @param transactionType LLM이 닫힌 enum에서 **선택**한 값(생성 아님). 유효하지 않으면
 *   `unknown`으로 강등한다.
 */
export function buildResultFromSpans(
  input: CardSmsInput,
  quotes: readonly CardSmsQuote[],
  transactionType: CardSmsParseResult['transactionType'],
  issuer: string,
): SpanExtraction {
  const rejected: string[] = [];
  const spans: Partial<Record<SpanField, Span>> = {};

  // ① 인용구 → span. 같은 필드가 두 번 오면 모호하므로 둘 다 버린다.
  const seenFields = new Set<SpanField>();
  for (const quote of quotes ?? []) {
    const field = quote?.field;
    if (!SPAN_FIELDS.includes(field)) {
      rejected.push(`unknown field: ${String(field)}`);
      continue;
    }
    if (seenFields.has(field)) {
      rejected.push(`${field} quoted more than once`);
      delete spans[field];
      continue;
    }
    seenFields.add(field);

    const span = resolveQuote(input.content, quote);
    if (!span) {
      rejected.push(`${field} quote not found in raw content`);
      continue;
    }
    spans[field] = span;
  }

  // ② span 겹침 금지 — 같은 구간을 두 필드가 가리키면 둘 다 신뢰할 수 없다.
  const entries = Object.entries(spans) as [SpanField, Span][];
  const conflicted = new Set<SpanField>();
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (overlaps(entries[i][1], entries[j][1])) {
        conflicted.add(entries[i][0]);
        conflicted.add(entries[j][0]);
      }
    }
  }
  for (const field of conflicted) {
    rejected.push(`${field} span overlaps another field`);
    delete spans[field];
  }

  const slice = (field: SpanField): string | undefined => {
    const span = spans[field];
    return span ? input.content.slice(span.start, span.end) : undefined;
  };

  // ③ 결정적 정규화. 여기서만 값이 만들어진다.
  let amount: number | undefined;
  let currency: string | undefined;
  const amountText = slice('amount');
  if (amountText !== undefined) {
    if (countDigits(amountText) > MAX_AMOUNT_DIGITS) {
      rejected.push('amount span has too many digits');
      delete spans.amount;
    } else {
      const parsed = parseAmount(amountText);
      // 통화 미확정은 반드시 거부한다. 외화(`USD 22.00`)에 KRW를 기본값으로 찍으면
      // 승격 시 minor-units 환산에서 100배 오류가 조용히 통과한다.
      if (parsed.amount === undefined || parsed.currency === undefined) {
        rejected.push('amount span is not normalizable to an amount + currency');
        delete spans.amount;
      } else {
        amount = parsed.amount;
        currency = parsed.currency;
      }
    }
  }

  let occurredAt: Date | undefined;
  const occurredText = slice('occurredAt');
  if (occurredText !== undefined) {
    const parsed = parseOccurredAt(occurredText, input.receivedAt);
    if (parsed.occurredAt === undefined) {
      rejected.push('occurredAt span is not normalizable to a timestamp');
      delete spans.occurredAt;
    } else {
      occurredAt = parsed.occurredAt;
    }
  }

  const merchantRaw = slice('merchant')?.trim() || undefined;
  if (spans.merchant !== undefined && merchantRaw === undefined) {
    rejected.push('merchant span is blank');
    delete spans.merchant;
  }

  const installmentText = slice('installment');
  const installmentMonths =
    installmentText !== undefined ? parseInstallmentMonths(installmentText) : undefined;
  if (installmentText !== undefined && installmentMonths === undefined) {
    rejected.push('installment span is not normalizable');
    delete spans.installment;
  }

  const normalizedType: CardSmsParseResult['transactionType'] =
    transactionType === 'approval' ||
    transactionType === 'cancellation' ||
    transactionType === 'declined'
      ? transactionType
      : 'unknown';
  if (normalizedType === 'unknown' && transactionType !== 'unknown') {
    rejected.push(`invalid transactionType: ${String(transactionType)}`);
  }

  const result: CardSmsParseResult = {
    issuer,
    transactionType: normalizedType,
    amount,
    currency,
    merchantRaw,
    occurredAt,
    // 카드 뒷자리는 LLM을 거치지 않는다 — 마스킹 대상이므로 원문에서 직접 뽑는다.
    maskedCardNumber: parseMaskedCardNumber(input.content),
    installmentMonths,
    confidence: 0,
    warnings: [...rejected],
  };
  result.confidence = computeConfidence(result);

  return { result, spans, rejected };
}

/** {@link assertParseInvariants} 위반 사유. 비어 있으면 통과. */
export type InvariantViolation = string;

/**
 * 승격 전 마지막 안전망. 파싱 경로(규칙/레시피/LLM)와 무관하게 결과가 도메인 규약을
 * 지키는지 검사한다. 위반은 예외가 아니라 목록으로 돌려주고, 호출부가 사람 검토로 보낸다.
 */
export function assertParseInvariants(
  result: CardSmsParseResult,
  receivedAt: Date,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (result.amount !== undefined) {
    if (!Number.isInteger(result.amount)) violations.push('amount is not a minor-units integer');
    if (result.amount < 0) violations.push('amount is negative');
    if (result.currency === undefined) violations.push('amount without currency');
  }
  if (result.currency !== undefined && result.amount === undefined) {
    violations.push('currency without amount');
  }
  if (result.occurredAt !== undefined) {
    const at = result.occurredAt.getTime();
    if (Number.isNaN(at)) {
      violations.push('occurredAt is not a valid date');
    } else {
      // 승인 시각이 수신보다 하루 넘게 미래이거나 2년 넘게 과거면 파싱 오류로 본다.
      const dayMs = 24 * 60 * 60 * 1000;
      if (at > receivedAt.getTime() + dayMs) violations.push('occurredAt is in the future');
      if (at < receivedAt.getTime() - 730 * dayMs) violations.push('occurredAt is implausibly old');
    }
  }
  if (result.installmentMonths !== undefined) {
    if (!Number.isInteger(result.installmentMonths) || result.installmentMonths < 1) {
      violations.push('installmentMonths is not a positive integer');
    }
  }
  if (!Number.isInteger(result.confidence) || result.confidence < 0 || result.confidence > 100) {
    violations.push('confidence is out of range');
  }

  return violations;
}
