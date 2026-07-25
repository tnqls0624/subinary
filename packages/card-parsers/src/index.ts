export type { CardSmsInput, CardSmsParseResult, CardSmsParser } from './types.js';
export { parseCardSms } from './dispatch.js';
export { BaseCardParser } from './parsers/base.parser.js';
export { ShinhanCardParser } from './parsers/shinhan.parser.js';
export { KookminCardParser } from './parsers/kookmin.parser.js';
export { TossBankCardParser } from './parsers/toss.parser.js';

/**
 * 결정적 추출 원시 함수 (ADR-0023).
 *
 * LLM span 경로는 값을 스스로 만들지 않고 **원문 slice를 이 함수들에 통과**시켜야
 * 하므로, 워커가 직접 호출할 수 있도록 공개한다. 파서 내부 전용이던 것을 노출하는
 * 것이라 시그니처 변경 시 worker 경로까지 함께 확인할 것.
 */
export {
  computeConfidence,
  detectTransactionType,
  extractMerchant,
  parseAmount,
  parseInstallmentMonths,
  parseMaskedCardNumber,
  parseOccurredAt,
} from './parsers/base.parser.js';

export { maskForLlm } from './mask.js';
export { templateFingerprint, templateSkeleton } from './template.js';
export {
  assertParseInvariants,
  buildResultFromSpans,
  resolveQuote,
} from './spans.js';
export type {
  CardSmsQuote,
  InvariantViolation,
  Span,
  SpanExtraction,
  SpanField,
} from './spans.js';
