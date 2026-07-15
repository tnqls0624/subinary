import { BaseCardParser } from './base.parser.js';

import type { CardSmsInput } from '../types.js';

/**
 * KB국민카드 (KB Kookmin Card) SMS parser.
 *
 * Recognizes messages containing `KB` or `국민`. Typical layout (the action
 * keyword and amount often share a line, which the order-independent extraction
 * in {@link BaseCardParser} handles):
 *
 * ```
 * [Web발신]
 * KB국민카드
 * 승인 8,900원 일시불
 * 07/15 12:05
 * GS25역삼
 * ```
 */
export class KookminCardParser extends BaseCardParser {
  readonly issuer = 'KB국민카드';

  supports(input: CardSmsInput): boolean {
    return input.content.includes('KB') || input.content.includes('국민');
  }
}
