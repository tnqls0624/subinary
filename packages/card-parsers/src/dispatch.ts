import { GenericCardParser } from './parsers/generic.parser.js';
import { KookminCardParser } from './parsers/kookmin.parser.js';
import { ShinhanCardParser } from './parsers/shinhan.parser.js';

import type { CardSmsInput, CardSmsParseResult, CardSmsParser } from './types.js';

/**
 * Registered parsers, tried in order. The first whose `supports()` returns true
 * handles the message. Issuer-specific parsers (신한/KB) come first for precise
 * labels; the {@link GenericCardParser} fallback is LAST and catches every other
 * issuer (삼성/현대/롯데/하나/… ) so unknown cards still parse instead of failing.
 */
const PARSERS: readonly CardSmsParser[] = [
  new ShinhanCardParser(),
  new KookminCardParser(),
  new GenericCardParser(),
];

/**
 * Payment aggregators (PRD §15). When one of these is the only identifiable
 * counterparty, the real merchant is unknown — we keep the aggregator name as
 * `merchantRaw` and flag it rather than inventing a merchant.
 */
const AGGREGATORS = ['네이버페이', '카카오페이', '토스페이', 'KG이니시스'] as const;
const AGGREGATOR_WARNING = 'payment aggregator; merchant unconfirmed';

function detectAggregator(content: string): string | undefined {
  return AGGREGATORS.find((name) => content.includes(name));
}

/**
 * When a payment aggregator is present, surface it as `merchantRaw` and add a
 * warning so downstream review (worker -> `pending_review`) knows the real
 * merchant is unconfirmed. Never fabricates a merchant.
 */
function applyAggregatorRule(input: CardSmsInput, result: CardSmsParseResult): CardSmsParseResult {
  const aggregator = detectAggregator(input.content);
  if (!aggregator) return result;

  const warnings = result.warnings.includes(AGGREGATOR_WARNING)
    ? result.warnings
    : [...result.warnings, AGGREGATOR_WARNING];
  return { ...result, merchantRaw: aggregator, warnings };
}

/**
 * Parse a card SMS by dispatching to the first parser that supports it.
 *
 * Returns `{ transactionType: 'unknown', confidence: 0, warnings: ['no matching parser'] }`
 * when no parser matches. Applies the aggregator rule on top of a matched result.
 */
export function parseCardSms(input: CardSmsInput): CardSmsParseResult {
  for (const parser of PARSERS) {
    if (parser.supports(input)) {
      return applyAggregatorRule(input, parser.parse(input));
    }
  }
  return { transactionType: 'unknown', confidence: 0, warnings: ['no matching parser'] };
}
