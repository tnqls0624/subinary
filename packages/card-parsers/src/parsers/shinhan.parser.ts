import { BaseCardParser } from './base.parser.js';
import { isNonCardNotice } from './non-card.js';

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

  /**
   * `신한` 키워드 + 비카드 문자 배제. 키워드만 보면 `신한은행 자동이체 출금`처럼
   * 카드 결제가 아닌 문자를 이 파서가 선점하고, 금액과 액션이 있으면 approval로
   * 승격된다(ADR-0026). 거절 통지는 배제하지 않는다(declined로 판정되고 승격되지
   * 않으므로 오탐 대가가 작다).
   */
  supports(input: CardSmsInput): boolean {
    if (!input.content.includes('신한')) return false;
    return !isNonCardNotice(input.content);
  }
}
