export type {
  CardSmsDeclineReason,
  CardSmsInput,
  CardSmsParseResult,
  CardSmsParser,
} from './types.js';
export { ACTION_GATE_WARNING_PREFIX, parseCardSms } from './dispatch.js';
export type { ParseCardSmsOptions } from './dispatch.js';
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
  detectDeclineReason,
  detectTransactionType,
  extractMerchant,
  parseAmount,
  parseInstallmentMonths,
  parseMaskedCardNumber,
  parseOccurredAt,
} from './parsers/base.parser.js';

export { maskForLlm } from './mask.js';
export { TEMPLATE_KEYWORDS, templateFingerprint, templateSkeleton } from './template.js';
export {
  applyRecipe,
  deriveRecipe,
  fieldCandidates,
  merchantCandidates,
} from './recipe.js';
export type { ConfirmedFields, FieldRecipe, TemplateRecipe } from './recipe.js';
export {
  assertParseInvariants,
  buildResultFromSpans,
  resolveQuote,
} from './spans.js';

/**
 * 액션 결박 금액 추출 (ADR-0027 §5) — **shadow 전용**.
 *
 * `parseCardSms`는 이 추출기를 쓰지 않는다. 기존 결과와 병행 비교(롤아웃 3단계)만
 * 하기 위한 공개 API이며, L0 성공 조건을 이것으로 바꾸는 것은 롤아웃 6단계다.
 */
export {
  compareAmountEvidence,
  extractActionGroundedAmount,
  summarizeAmountShadow,
} from './action-amount.js';
export type {
  ActionAmountScope,
  ActionAmountStatus,
  ActionGroundedAmount,
  AmountShadowRecord,
  AmountShadowSummary,
  AmountShadowVerdict,
  DiscardReason,
  DiscardedAmountCandidate,
} from './action-amount.js';
export type {
  CardSmsQuote,
  InvariantViolation,
  Span,
  SpanExtraction,
  SpanField,
} from './spans.js';
