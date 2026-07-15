import { describe, expect, it } from 'vitest';

import { parseCardSms } from './dispatch.js';

describe('parseCardSms dispatch', () => {
  it('routes Shinhan messages to the Shinhan parser', () => {
    const content = ['신한카드(1234)승인', '5,000원 일시불', '07/15 09:30', '투썸플레이스'].join('\n');
    const result = parseCardSms({
      sender: '15447200',
      content,
      receivedAt: new Date('2026-07-15T09:31:00+09:00'),
    });

    expect(result.issuer).toBe('신한카드');
    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(5000);
    expect(result.currency).toBe('KRW');
  });

  it('routes KB / 국민 messages to the Kookmin parser', () => {
    const content = ['KB국민카드', '승인 7,700원 일시불', '07/15 11:00', '컴포즈커피'].join('\n');
    const result = parseCardSms({
      sender: '15881688',
      content,
      receivedAt: new Date('2026-07-15T11:01:00+09:00'),
    });

    expect(result.issuer).toBe('KB국민카드');
    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(7700);
  });

  it('flags payment aggregators without inventing a real merchant', () => {
    const content = ['신한카드(1234)승인', '15,000원 일시불', '07/15 20:00', '네이버페이'].join('\n');
    const result = parseCardSms({
      sender: '15447200',
      content,
      receivedAt: new Date('2026-07-15T20:01:00+09:00'),
    });

    expect(result.merchantRaw).toBe('네이버페이');
    expect(result.warnings).toContain('payment aggregator; merchant unconfirmed');
    expect(result.amount).toBe(15000);
  });

  it('returns unknown with confidence 0 when no parser matches', () => {
    const result = parseCardSms({
      sender: '01000000000',
      content: '[안내] 이번 주 마트 세일 정보를 확인하세요.',
      receivedAt: new Date('2026-07-15T09:00:00+09:00'),
    });

    expect(result.transactionType).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.warnings).toContain('no matching parser');
    expect(result.amount).toBeUndefined();
  });

  it('returns unknown when a supported issuer message is not a transaction', () => {
    const content = ['신한은행', '고객님 안녕하세요. 신한 이벤트 안내입니다.'].join('\n');
    const result = parseCardSms({
      sender: '15447200',
      content,
      receivedAt: new Date('2026-07-15T09:00:00+09:00'),
    });

    expect(result.transactionType).toBe('unknown');
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
