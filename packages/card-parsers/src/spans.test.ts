import { describe, expect, it } from 'vitest';

import { assertParseInvariants, buildResultFromSpans, resolveQuote } from './spans.js';

import type { CardSmsInput } from './types.js';

const RECEIVED_AT = new Date('2026-07-20T14:33:00+09:00');

const samsung: CardSmsInput = {
  sender: '15881688',
  content: '[Web발신]\n삼성2승인 이*빈\n1,169원 일시불\n07/20 14:32 영등포구청',
  receivedAt: RECEIVED_AT,
};

const foreign: CardSmsInput = {
  sender: '15776000',
  content: '[Web발신]\n네이버 현대카드 해외승인\n김*진님\n07/20 19:31\nUSD 22.00\nANTHROPIC*CLAUDESUB',
  receivedAt: new Date('2026-07-20T19:32:00+09:00'),
};

describe('resolveQuote', () => {
  it('첫 출현 위치를 확정한다', () => {
    const span = resolveQuote(samsung.content, {
      field: 'amount',
      quote: '1,169원',
      occurrence: 1,
    });
    expect(span).toBeDefined();
    expect(samsung.content.slice(span!.start, span!.end)).toBe('1,169원');
  });

  it('n번째 출현을 지목할 수 있다', () => {
    const text = 'a 100원 b 100원 c';
    const span = resolveQuote(text, { field: 'amount', quote: '100원', occurrence: 2 });
    expect(span?.start).toBe(text.indexOf('100원', text.indexOf('100원') + 1));
  });

  it('원문에 없는 인용구는 폐기한다 (환각 차단)', () => {
    expect(
      resolveQuote(samsung.content, { field: 'amount', quote: '99,999원', occurrence: 1 }),
    ).toBeUndefined();
  });

  it('출현 횟수가 모자라면 폐기한다', () => {
    expect(
      resolveQuote(samsung.content, { field: 'amount', quote: '1,169원', occurrence: 2 }),
    ).toBeUndefined();
  });

  it('부정한 occurrence를 거부한다', () => {
    for (const occurrence of [0, -1, 1.5, Number.NaN]) {
      expect(
        resolveQuote(samsung.content, { field: 'amount', quote: '1,169원', occurrence }),
      ).toBeUndefined();
    }
  });

  it('빈 인용구와 과도하게 긴 인용구를 거부한다', () => {
    expect(
      resolveQuote(samsung.content, { field: 'merchant', quote: '', occurrence: 1 }),
    ).toBeUndefined();
    expect(
      resolveQuote('x'.repeat(200), { field: 'merchant', quote: 'x'.repeat(100), occurrence: 1 }),
    ).toBeUndefined();
  });
});

describe('buildResultFromSpans', () => {
  it('원화 인용구를 결정적 함수로 정규화한다', () => {
    const { result, rejected } = buildResultFromSpans(
      samsung,
      [
        { field: 'amount', quote: '1,169원', occurrence: 1 },
        { field: 'occurredAt', quote: '07/20 14:32', occurrence: 1 },
        { field: 'merchant', quote: '영등포구청', occurrence: 1 },
        { field: 'installment', quote: '일시불', occurrence: 1 },
      ],
      'approval',
      '삼성카드',
    );

    expect(rejected).toEqual([]);
    expect(result.amount).toBe(1169);
    expect(result.currency).toBe('KRW');
    expect(result.merchantRaw).toBe('영등포구청');
    expect(result.installmentMonths).toBe(1);
    expect(result.occurredAt?.toISOString()).toBe('2026-07-20T05:32:00.000Z');
    expect(result.confidence).toBe(100);
  });

  it('외화를 minor units로 정규화하고 통화를 보존한다', () => {
    const { result, rejected } = buildResultFromSpans(
      foreign,
      [
        { field: 'amount', quote: 'USD 22.00', occurrence: 1 },
        { field: 'merchant', quote: 'ANTHROPIC*CLAUDESUB', occurrence: 1 },
      ],
      'approval',
      '현대카드',
    );

    expect(rejected).toEqual([]);
    expect(result.amount).toBe(2200);
    expect(result.currency).toBe('USD');
  });

  it('통화를 확정할 수 없는 금액 인용구를 거부한다 (100배 오류 차단)', () => {
    const { result, rejected } = buildResultFromSpans(
      foreign,
      [{ field: 'amount', quote: '22.00', occurrence: 1 }],
      'approval',
      '현대카드',
    );

    expect(result.amount).toBeUndefined();
    expect(result.currency).toBeUndefined();
    expect(rejected.join(';')).toContain('amount');
  });

  it('환각된 금액은 결과에 반영되지 않는다', () => {
    const { result, rejected } = buildResultFromSpans(
      samsung,
      [{ field: 'amount', quote: '9,999,999원', occurrence: 1 }],
      'approval',
      '삼성카드',
    );

    expect(result.amount).toBeUndefined();
    expect(rejected.join(';')).toContain('not found in raw content');
  });

  it('겹치는 span은 양쪽 다 폐기한다', () => {
    const { result, rejected } = buildResultFromSpans(
      samsung,
      [
        { field: 'amount', quote: '1,169원', occurrence: 1 },
        { field: 'merchant', quote: '1,169원 일시불', occurrence: 1 },
      ],
      'approval',
      '삼성카드',
    );

    expect(result.amount).toBeUndefined();
    expect(result.merchantRaw).toBeUndefined();
    expect(rejected.filter((r) => r.includes('overlaps'))).toHaveLength(2);
  });

  it('같은 필드를 두 번 인용하면 모호하므로 버린다', () => {
    const { result, rejected } = buildResultFromSpans(
      samsung,
      [
        { field: 'amount', quote: '1,169원', occurrence: 1 },
        { field: 'amount', quote: '1,169원', occurrence: 1 },
      ],
      'approval',
      '삼성카드',
    );

    expect(result.amount).toBeUndefined();
    expect(rejected.join(';')).toContain('more than once');
  });

  it('카드 뒷자리는 인용 없이 원문에서 직접 얻는다', () => {
    const shinhan: CardSmsInput = {
      sender: '15447200',
      content: '신한카드(1234)승인\n5,000원 일시불\n07/15 09:30\n투썸플레이스',
      receivedAt: new Date('2026-07-15T09:31:00+09:00'),
    };
    const { result } = buildResultFromSpans(
      shinhan,
      [{ field: 'amount', quote: '5,000원', occurrence: 1 }],
      'approval',
      '신한카드',
    );
    expect(result.maskedCardNumber).toBe('****1234');
  });

  it('알 수 없는 거래유형과 필드는 강등·거부한다', () => {
    const { result, rejected } = buildResultFromSpans(
      samsung,
      [{ field: 'bogus' as never, quote: '영등포구청', occurrence: 1 }],
      'refund' as never,
      '삼성카드',
    );

    expect(result.transactionType).toBe('unknown');
    expect(rejected.join(';')).toContain('unknown field');
    expect(rejected.join(';')).toContain('invalid transactionType');
  });
});

describe('assertParseInvariants', () => {
  const base = {
    transactionType: 'approval' as const,
    confidence: 100,
    warnings: [],
  };

  it('정상 결과는 위반이 없다', () => {
    expect(
      assertParseInvariants({ ...base, amount: 1169, currency: 'KRW' }, RECEIVED_AT),
    ).toEqual([]);
  });

  it('통화 없는 금액을 잡는다', () => {
    expect(assertParseInvariants({ ...base, amount: 1169 }, RECEIVED_AT)).toContain(
      'amount without currency',
    );
  });

  it('정수가 아닌 금액과 음수 금액을 잡는다', () => {
    expect(
      assertParseInvariants({ ...base, amount: 11.69, currency: 'KRW' }, RECEIVED_AT),
    ).toContain('amount is not a minor-units integer');
    expect(assertParseInvariants({ ...base, amount: -1, currency: 'KRW' }, RECEIVED_AT)).toContain(
      'amount is negative',
    );
  });

  it('미래 시각과 지나치게 오래된 시각을 잡는다', () => {
    expect(
      assertParseInvariants(
        { ...base, occurredAt: new Date(RECEIVED_AT.getTime() + 8 * 24 * 3600_000) },
        RECEIVED_AT,
      ),
    ).toContain('occurredAt is in the future');
    expect(
      assertParseInvariants(
        { ...base, occurredAt: new Date(RECEIVED_AT.getTime() - 900 * 24 * 3600_000) },
        RECEIVED_AT,
      ),
    ).toContain('occurredAt is implausibly old');
  });

  it('범위를 벗어난 confidence를 잡는다', () => {
    expect(assertParseInvariants({ ...base, confidence: 120 }, RECEIVED_AT)).toContain(
      'confidence is out of range',
    );
  });
});
