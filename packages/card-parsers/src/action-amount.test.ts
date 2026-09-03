/**
 * 액션 결박 금액 추출기 단위 테스트 (ADR-0027 §5).
 *
 * 코퍼스 전수 재생은 `action-amount.shadow.test.ts`가 맡는다. 여기서는 **왜 그렇게
 * 판정되는가**(구간 분할·지배 문맥·Tier·span 불변식)를 고정한다.
 */
import { describe, expect, it } from 'vitest';

import { compareAmountEvidence, extractActionGroundedAmount } from './action-amount.js';
import { parseCardSms } from './dispatch.js';

const receivedAt = new Date('2026-08-08T12:00:00+09:00');
const shadow = (content: string) => {
  const input = { sender: '15771234', content, receivedAt };
  // legacy는 게이트를 끈 결과다 — 게이트끼리 비교하면 대조가 무의미해진다.
  return compareAmountEvidence(input, parseCardSms(input, { actionGate: false }));
};

describe('extractActionGroundedAmount — D-4 실패 사례', () => {
  it('판촉 구간의 금액을 거래로 확정하지 않는다 (할인 광고)', () => {
    const result = extractActionGroundedAmount('삼성카드 8/10 온라인 결제 시 5,000원 할인');

    expect(result.status).toBe('rejected_non_transaction');
    expect(result.amount).toBeUndefined();
    expect(result.discarded.map((d) => d.reason)).toEqual(['promotion']);
  });

  it('한도 금액이 앞서도 승인 금액을 고른다 (첫 N원 금지)', () => {
    const content = '삼성카드 이용한도 1,000,000원 / 승인 10,000원';
    const result = extractActionGroundedAmount(content);

    expect(result.status).toBe('resolved');
    expect(result.amount).toBe(10000);
    expect(result.currency).toBe('KRW');
    // 액션과 같은 구간에서 확정됐다(ADR §5의 엄격 해석 그대로).
    expect(result.scope).toBe('action_segment');
    expect(content.slice(result.amountSpan!.start, result.amountSpan!.end)).toBe('10,000원');
    expect(content.slice(result.actionSpan!.start, result.actionSpan!.end)).toBe('승인');
    expect(result.discarded).toHaveLength(1);
    expect(result.discarded[0].reason).toBe('state_amount');
    expect(result.discarded[0].text).toBe('1,000,000원');
    // 탈락 후보의 span도 원문을 그대로 복원해야 한다.
    const { start, end } = result.discarded[0].span;
    expect(content.slice(start, end)).toBe('1,000,000원');
  });

  it('누적 라인은 앞에 있든 뒤에 있든 결제 금액을 이긴다', () => {
    const before = extractActionGroundedAmount(
      '[Web발신]\n네이버 현대카드 승인\n누적 123,456원\n30,000원 일시불\n07/19 15:00\n모바일티머니선불',
    );
    const after = extractActionGroundedAmount(
      '[Web발신]\n네이버 현대카드 승인\n30,000원 일시불\n07/19 15:00\n모바일티머니선불\n누적 123,456원',
    );

    expect(before.amount).toBe(30000);
    expect(after.amount).toBe(30000);
    // 액션이 헤더 줄에만 있는 지배적 레이아웃이라 Tier 2로 확정된다.
    expect(before.scope).toBe('message_block');
    expect(after.scope).toBe('message_block');
  });

  it('유효 후보가 둘이면 첫 값을 고르지 않고 실패한다 (L1→L2로 넘긴다)', () => {
    const result = extractActionGroundedAmount('삼성카드 승인 10,000원 / 삼성카드 승인 20,000원');

    expect(result.status).toBe('ambiguous');
    expect(result.amount).toBeUndefined();
    expect(result.discarded.filter((d) => d.reason === 'ambiguous')).toHaveLength(2);
  });
});

describe('extractActionGroundedAmount — 정상 승인 보존', () => {
  it('액션과 금액이 다른 줄인 지배적 레이아웃을 확정한다', () => {
    const result = extractActionGroundedAmount(
      '[Web발신]\n신한카드(1234)승인\n12,500원 일시불\n07/15 09:30\n스타벅스강남점',
    );

    expect(result.status).toBe('resolved');
    expect(result.amount).toBe(12500);
    expect(result.scope).toBe('message_block');
  });

  it('잔액 라인이 함께 와도 결제 금액만 고른다', () => {
    const result = extractActionGroundedAmount(
      '신한카드(1234)승인\n12,500원 일시불\n08/03 09:30\n스타벅스강남점\n잔액 340,000원',
    );

    expect(result.amount).toBe(12500);
    expect(result.discarded).toHaveLength(1);
    expect(result.discarded[0]).toMatchObject({ text: '340,000원', reason: 'state_amount' });
  });

  it("'잔액'이 금액 **뒤**에 오면 거절 사유이므로 배제하지 않는다", () => {
    // 배제하면 ADR-0024의 거절 가시성(금액 표시)이 조용히 죽는다.
    const result = extractActionGroundedAmount(
      '신한카드(1234) 승인거절 08/03 09:30 스타벅스 12,500원 잔액부족',
    );

    expect(result.status).toBe('resolved');
    expect(result.amount).toBe(12500);
  });

  it('외화 승인은 minor units와 통화를 보존한다', () => {
    const result = extractActionGroundedAmount(
      '[Web발신]\n네이버 현대카드 해외승인\n김*진님\n07/20 19:31\nUSD 22.00\nANTHROPIC*CLAUDESUB',
    );

    expect(result.amount).toBe(2200);
    expect(result.currency).toBe('USD');
  });

  it('날짜의 슬래시로는 구간을 자르지 않는다', () => {
    const content =
      '[Web발신]\n네이버 현대카드 뒷자리(6*0*) 분실카드 승인거절 07/19/15:00 버핏서울 106,000원';
    const result = extractActionGroundedAmount(content);

    expect(result.status).toBe('resolved');
    expect(result.amount).toBe(106000);
    expect(result.scope).toBe('action_segment');
  });
});

describe('extractActionGroundedAmount — 증거가 없을 때', () => {
  it('거래 액션이 없으면 금액이 있어도 확정하지 않는다', () => {
    const result = extractActionGroundedAmount(
      '토스뱅크 [출금 안내] \n공룡통장 모임통장에서 50,000원이 출금됐어요.',
    );

    expect(result.status).toBe('no_action');
    expect(result.amount).toBeUndefined();
  });

  it('금액 후보 자체가 없으면 no_candidate', () => {
    expect(extractActionGroundedAmount('[안내] 이번 주 마트 세일 정보를 확인하세요.').status).toBe(
      'no_candidate',
    );
  });

  it('잔액뿐인 접힌 알림은 잔액을 결제 금액으로 삼지 않는다', () => {
    const result = extractActionGroundedAmount('공룡통장 카드 | 쿠팡(쿠페이)\n잔액 126,713원');

    expect(result.status).toBe('rejected_non_transaction');
    expect(result.amount).toBeUndefined();
  });
});

describe('compareAmountEvidence — shadow 분류', () => {
  it('정상 승인은 동일로 분류한다', () => {
    const record = shadow('신한카드(1234)승인\n5,000원 일시불\n07/15 09:30\n투썸플레이스');

    expect(record.routed).toBe(true);
    expect(record.verdict).toBe('same');
  });

  it('광고 문자는 신규가 비승격 판정으로 분류한다 (오탐 후보 제거)', () => {
    const record = shadow('삼성카드 8/10 온라인 결제 시 5,000원 할인');

    expect(record.routed).toBe(true);
    expect(record.legacyAmount).toBe(5000); // 기존은 5,000원 승인으로 승격한다
    expect(record.verdict).toBe('new_rejects_legacy');
  });

  it('한도 오선택은 금액 다름으로 분류한다', () => {
    const record = shadow('삼성카드 이용한도 1,000,000원 / 승인 10,000원');

    expect(record.legacyAmount).toBe(1000000);
    expect(record.candidate.amount).toBe(10000);
    expect(record.verdict).toBe('amount_differs');
  });

  it('후보가 모호하면 신규 추출 실패로 분류한다 (비승격 판정과 구분)', () => {
    const record = shadow('삼성카드 승인 10,000원 / 삼성카드 승인 20,000원');

    expect(record.verdict).toBe('new_missing');
    expect(record.candidate.status).toBe('ambiguous');
  });

  it('파서가 잡지 않은 문자는 routed=false로 표시해 게이트 지표와 섞이지 않게 한다', () => {
    // 이 모듈은 금액 **선택**만 한다 — 비카드 배제는 파서 게이트의 책임이다.
    const record = shadow('우리은행 자동이체 결제 50,000원 정상 처리되었습니다.');

    expect(record.routed).toBe(false);
    expect(record.candidate.status).toBe('resolved');
  });
});
