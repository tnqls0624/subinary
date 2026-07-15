import { BaseCardParser } from './base.parser.js';

import type { CardSmsInput } from '../types.js';

/**
 * 신한카드 (Shinhan Card) SMS parser.
 *
 * Recognizes messages containing `신한`. Typical layout:
 *
 * ```
 * [Web발신]
 * 신한카드(1234)승인
 * 12,500원 일시불
 * 07/15 09:30
 * 스타벅스강남점
 * ```
 */
export class ShinhanCardParser extends BaseCardParser {
  readonly issuer = '신한카드';

  supports(input: CardSmsInput): boolean {
    return input.content.includes('신한');
  }
}
