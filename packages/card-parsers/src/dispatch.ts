import { extractActionGroundedAmount } from './action-amount.js';
import { GenericCardParser } from './parsers/generic.parser.js';
import { KookminCardParser } from './parsers/kookmin.parser.js';
import { ShinhanCardParser } from './parsers/shinhan.parser.js';
import { TossBankCardParser } from './parsers/toss.parser.js';

import type { CardSmsInput, CardSmsParseResult, CardSmsParser } from './types.js';

/**
 * Registered parsers, tried in order. The first whose `supports()` returns true
 * handles the message.
 *
 * 토스뱅크가 맨 앞: supports()가 리터럴 '토스뱅크'를 요구해 가장 특이적이고,
 * 신한/KB 파서는 발신사 무관 키워드('신한'/'KB'/'국민')만 보므로 가맹점명에 그
 * 키워드가 든 토스뱅크 알림톡(예: `… | 신한서적`)을 선점해 버린다. 또한 토스뱅크
 * 알림톡은 잔액 라인 때문에 generic 파서의 은행 문자 배제 규칙에 걸리므로 반드시
 * generic 보다 앞이어야 한다. The {@link GenericCardParser} fallback is LAST and
 * catches every other issuer (삼성/현대/롯데/하나/… ) so unknown cards still
 * parse instead of failing.
 */
const PARSERS: readonly CardSmsParser[] = [
  new TossBankCardParser(),
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

/** 액션 게이트가 금액을 무효화했을 때 남기는 warning 접두. */
export const ACTION_GATE_WARNING_PREFIX = 'action gate: ';

export interface ParseCardSmsOptions {
  /**
   * 액션 결박 금액 게이트(ADR-0027 6단계). 기본 **on**.
   *
   * 끄는 것은 사고 대응 수단이다 — ADR이 "enforce 이후 금액 불변식 위반·설명되지 않은
   * delta·기존 정상 승인의 신규 격리가 한 건이라도 발생하면 shadow로 되돌린다"고 정했다.
   * 파서 패키지는 env를 읽지 않는다(순수 모듈). 호출부가 설정을 읽어 넘긴다.
   */
  readonly actionGate?: boolean;
}

/**
 * 액션 결박 금액만 L0 성공으로 인정한다 (ADR-0027 롤아웃 6단계).
 *
 * ## 왜 dispatch에서 하는가
 *
 * `base.parser.ts`의 `buildResult`가 금액을 뽑지만 그쪽에서 게이트를 걸면 순환
 * 의존이 된다(`action-amount.ts` → `base.parser.ts`). 게이트를 여기 두면 전용 파서와
 * 범용 파서가 **같은 판정**을 거치므로 ADR §5-1의 "전용 규칙 파서와 L1 레시피도
 * 최종적으로 같은 span 불변식을 반환한다"에 맞고, 판정 지점이 하나로 남는다.
 *
 * ## 세 갈래
 *
 * 1. **확정 + 기존과 같음** → 그대로 통과. 운영 문자 264건 전수 재생에서 전부 이 경우였다.
 * 2. **확정 + 기존과 다름** → 게이트 값을 채택한다. D-4 교정이 일어나는 지점이다
 *    (`이용한도 1,000,000원 / 승인 10,000원` → 10,000원).
 * 3. **미확정** → 금액을 **무효화**한다. 임의로 첫 값을 고르지 않는다. 금액이 없으면
 *    거래로 승격되지 않고, worker가 L1(레시피)→L2(LLM)로 내려보낸다. 어느 계층도
 *    유효 증거를 못 만들면 그때 `quarantined`/사람 검토다.
 *
 * 금액이 애초에 없는 결과는 건드리지 않는다 — 게이트는 "있는 금액이 옳은가"를 보는
 * 것이고, 없는 금액을 만들어내는 것은 L1·L2의 일이다.
 */
function applyActionGate(input: CardSmsInput, result: CardSmsParseResult): CardSmsParseResult {
  if (result.amount === undefined) return result;

  const candidate = extractActionGroundedAmount(input.content);

  if (candidate.status === 'resolved') {
    const sameAmount = candidate.amount === result.amount;
    const sameCurrency =
      result.currency === undefined || candidate.currency === result.currency;
    if (sameAmount && sameCurrency) return result;
    // 게이트가 다른 값을 확정했다 — 액션에 결박된 쪽이 옳다(D-4 교정).
    return {
      ...result,
      amount: candidate.amount,
      currency: candidate.currency ?? result.currency,
      warnings: [...result.warnings, `${ACTION_GATE_WARNING_PREFIX}corrected (${candidate.scope})`],
    };
  }

  // 확정 실패 — 금액을 지운다. confidence도 함께 내린다(금액 없는 결과가 높은
  // 신뢰도를 들고 다니면 `pending_review` 분기가 그것을 승격 가능으로 오독한다).
  return {
    ...result,
    amount: undefined,
    currency: undefined,
    confidence: Math.min(result.confidence, 40),
    warnings: [...result.warnings, `${ACTION_GATE_WARNING_PREFIX}${candidate.status}`],
  };
}

/**
 * Parse a card SMS by dispatching to the first parser that supports it.
 *
 * Returns `{ transactionType: 'unknown', confidence: 0, warnings: ['no matching parser'] }`
 * when no parser matches. Applies the aggregator rule and the action-grounded
 * amount gate (ADR-0027 6단계) on top of a matched result.
 */
export function parseCardSms(
  input: CardSmsInput,
  options: ParseCardSmsOptions = {},
): CardSmsParseResult {
  const actionGate = options.actionGate ?? true;
  for (const parser of PARSERS) {
    if (parser.supports(input)) {
      const parsed = applyAggregatorRule(input, parser.parse(input));
      return actionGate ? applyActionGate(input, parsed) : parsed;
    }
  }
  return { transactionType: 'unknown', confidence: 0, warnings: ['no matching parser'] };
}
