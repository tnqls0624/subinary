/**
 * 템플릿 추출 레시피 (ADR-0023 S4).
 *
 * 같은 지문({@link templateFingerprint})의 문자는 **레이아웃이 동일**하다. 그래서
 * "금액은 몇 번째 금액 후보인가, 가맹점은 몇 번째 자유 토큰 덩어리인가"만 알면
 * 이후 같은 템플릿의 문자를 LLM 없이 결정적으로 추출할 수 있다.
 *
 * 이것이 이 설계가 신경망 없이 성립하는 이유다 — 필드당 수천 개의 라벨이 필요한
 * 시퀀스 라벨링과 달리, **템플릿당 사람이 확정한 1건**이면 레시피가 유도된다.
 *
 * 레시피 유도(`deriveRecipe`)와 적용(`applyRecipe`)은 **같은 후보 열거 함수**를 쓴다.
 * 둘이 갈리면 인덱스가 어긋나 조용히 엉뚱한 값을 뽑으므로, 후보 생성은 이 파일
 * 하나에만 둔다.
 */
import { KNOWN_CURRENCY_CODES } from './currency.js';
import { TEMPLATE_KEYWORDS } from './template.js';
import { computeConfidence } from './parsers/base.parser.js';
import { buildResultFromSpans } from './spans.js';

import type { CardSmsInput, CardSmsParseResult } from './types.js';
import type { CardSmsQuote, Span, SpanExtraction, SpanField } from './spans.js';

const FX_CODE_ALT = KNOWN_CURRENCY_CODES.filter((code) => code !== 'KRW').join('|');

/**
 * 금액 후보 — 단위(`원`/ISO 코드)를 **포함**해야 한다. 통화를 확정할 수 없는 조각은
 * 거부되므로(spans.ts), 후보 자체에 단위를 넣어야 정규화가 성립한다.
 */
const AMOUNT_CANDIDATE_RE = new RegExp(
  `[\\d,]+\\s*원|(?:${FX_CODE_ALT})[ \\t]*[\\d,]+(?:\\.\\d+)?|(?<![:.\\d])[\\d,]+(?:\\.\\d+)?[ \\t]*(?:${FX_CODE_ALT})\\b`,
  'g',
);
/** 시각 후보 — base.parser의 DATETIME_RE와 같은 형태(전역). */
const DATETIME_CANDIDATE_RE = /\d{1,2}[./-]\d{1,2}[\s./-]+\d{1,2}:\d{2}/g;
/** 할부 후보. */
const INSTALLMENT_CANDIDATE_RE = /일시불|\d{1,2}\s*개월/g;

/**
 * 가맹점 후보 = 고정 어휘 밖 자유 토큰의 연속 덩어리.
 *
 * {@link templateSkeleton}이 `@`로 접는 것과 **같은 개념**이어야 슬롯 번호가 일치한다.
 * 다만 여기서는 접는 대신 원문 span을 돌려준다.
 */
const TOKEN_RE = /[0-9A-Za-z가-힣]+/g;

function matchSpans(content: string, pattern: RegExp): Span[] {
  const spans: Span[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null = re.exec(content);
  while (match !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    match = re.exec(content);
  }
  return spans;
}

/** 자유 토큰 덩어리(가맹점 후보)의 span 목록. 인접 자유 토큰은 하나로 병합한다. */
export function merchantCandidates(content: string): Span[] {
  const spans: Span[] = [];
  let current: { start: number; end: number } | null = null;
  const re = new RegExp(TOKEN_RE.source, 'g');
  let match: RegExpExecArray | null = re.exec(content);
  while (match !== null) {
    const token = match[0];
    const isFree = !TEMPLATE_KEYWORDS.has(token) && !/^\d+$/.test(token);
    if (isFree) {
      const between = current ? content.slice(current.end, match.index) : '';
      // 같은 줄에서 공백/괄호 정도로만 떨어져 있으면 한 가맹점으로 본다.
      if (current && !between.includes('\n') && /^[\s()[\]._-]*$/.test(between)) {
        current.end = match.index + token.length;
      } else {
        if (current) spans.push({ ...current });
        current = { start: match.index, end: match.index + token.length };
      }
    }
    match = re.exec(content);
  }
  if (current) spans.push({ ...current });
  return spans;
}

/** 필드별 후보 span을 결정적 순서로 돌려준다. */
export function fieldCandidates(content: string, field: SpanField): Span[] {
  switch (field) {
    case 'amount':
      return matchSpans(content, AMOUNT_CANDIDATE_RE);
    case 'occurredAt':
      return matchSpans(content, DATETIME_CANDIDATE_RE);
    case 'installment':
      return matchSpans(content, INSTALLMENT_CANDIDATE_RE);
    case 'merchant':
      return merchantCandidates(content);
  }
}

/** 한 필드의 추출 규칙 — "몇 번째 후보인가"(0-based). */
export interface FieldRecipe {
  readonly candidateIndex: number;
}

/** 템플릿 하나의 추출 레시피. */
export interface TemplateRecipe {
  readonly schemaVersion: 'card-sms-recipe-v1';
  readonly fingerprint: string;
  readonly transactionType: CardSmsParseResult['transactionType'];
  readonly issuer: string | null;
  readonly fields: Partial<Record<SpanField, FieldRecipe>>;
}

/** 사람이 확정한 값 — 레시피 유도의 정답지. */
export interface ConfirmedFields {
  readonly transactionType: CardSmsParseResult['transactionType'];
  readonly issuer?: string | null;
  readonly amount?: number;
  readonly currency?: string;
  readonly merchantRaw?: string;
  readonly occurredAt?: Date;
  readonly installmentMonths?: number;
}

/** span → 인용구. `resolveQuote`가 같은 위치를 되찾도록 occurrence까지 센다. */
function spanToQuote(content: string, field: SpanField, span: Span): CardSmsQuote {
  const quote = content.slice(span.start, span.end);
  let occurrence = 0;
  let index = content.indexOf(quote);
  while (index >= 0 && index <= span.start) {
    occurrence += 1;
    if (index === span.start) break;
    index = content.indexOf(quote, index + 1);
  }
  return { field, quote, occurrence: Math.max(1, occurrence) };
}

/**
 * 확정된 값과 원문을 대조해 "몇 번째 후보였는지"를 알아낸다.
 *
 * 값 비교는 **결정적 정규화를 거친 뒤** 수행한다 — 사람은 `1169`를 입력하지만 원문은
 * `1,169원`이므로 문자열 비교로는 못 맞춘다.
 */
export function deriveRecipe(
  input: CardSmsInput,
  confirmed: ConfirmedFields,
  fingerprint: string,
): TemplateRecipe {
  const fields: Partial<Record<SpanField, FieldRecipe>> = {};
  const content = input.content;

  const findIndex = (field: SpanField, matches: (span: Span) => boolean): void => {
    const index = fieldCandidates(content, field).findIndex(matches);
    if (index >= 0) fields[field] = { candidateIndex: index };
  };

  if (confirmed.amount !== undefined) {
    findIndex('amount', (span) => {
      const { result } = buildResultFromSpans(
        input,
        [spanToQuote(content, 'amount', span)],
        confirmed.transactionType,
        '',
      );
      return (
        result.amount === confirmed.amount &&
        (confirmed.currency === undefined || result.currency === confirmed.currency)
      );
    });
  }
  if (confirmed.occurredAt !== undefined) {
    const target = confirmed.occurredAt.getTime();
    findIndex('occurredAt', (span) => {
      const { result } = buildResultFromSpans(
        input,
        [spanToQuote(content, 'occurredAt', span)],
        confirmed.transactionType,
        '',
      );
      return result.occurredAt?.getTime() === target;
    });
  }
  if (confirmed.merchantRaw !== undefined) {
    const target = confirmed.merchantRaw.trim();
    findIndex('merchant', (span) => content.slice(span.start, span.end).trim() === target);
  }
  if (confirmed.installmentMonths !== undefined) {
    findIndex('installment', (span) => {
      const { result } = buildResultFromSpans(
        input,
        [spanToQuote(content, 'installment', span)],
        confirmed.transactionType,
        '',
      );
      return result.installmentMonths === confirmed.installmentMonths;
    });
  }

  return {
    schemaVersion: 'card-sms-recipe-v1',
    fingerprint,
    transactionType: confirmed.transactionType,
    issuer: confirmed.issuer ?? null,
    fields,
  };
}

/**
 * 레시피로 새 문자를 추출한다. 후보 개수가 모자라면 그 필드는 조용히 비고
 * `rejected`에 사유가 남는다 — 레이아웃이 미묘하게 다른 변종을 승격시키지 않기 위해서다.
 */
export function applyRecipe(input: CardSmsInput, recipe: TemplateRecipe): SpanExtraction {
  const content = input.content;
  const quotes: CardSmsQuote[] = [];
  const missing: string[] = [];

  for (const [field, rule] of Object.entries(recipe.fields) as [SpanField, FieldRecipe][]) {
    const candidates = fieldCandidates(content, field);
    const span = candidates[rule.candidateIndex];
    if (!span) {
      missing.push(`${field} candidate #${rule.candidateIndex} not present`);
      continue;
    }
    quotes.push(spanToQuote(content, field, span));
  }

  const extraction = buildResultFromSpans(
    input,
    quotes,
    recipe.transactionType,
    recipe.issuer ?? '카드',
  );

  // 본문에 시각이 아예 없는 레이아웃(토스뱅크 알림톡 등)은 규칙 파서와 동일하게
  // receivedAt으로 근사한다 — 알림은 결제 직후 실시간 수신된다. 이 폴백이 없으면
  // occurredAt이 비어 취소↔승인 연결·유사중복 판정이 통째로 비활성화된다
  // (toss.parser.ts와 같은 규약).
  const warnings = [...missing, ...extraction.result.warnings];
  let occurredAt = extraction.result.occurredAt;
  if (
    occurredAt === undefined &&
    recipe.fields.occurredAt === undefined &&
    fieldCandidates(content, 'occurredAt').length === 0
  ) {
    occurredAt = input.receivedAt;
    warnings.push('occurredAt approximated from receivedAt');
  }

  const result = { ...extraction.result, occurredAt, warnings };
  return {
    ...extraction,
    result: { ...result, confidence: computeConfidence(result) },
    rejected: [...missing, ...extraction.rejected],
  };
}
