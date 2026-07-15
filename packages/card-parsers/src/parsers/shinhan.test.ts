import { formatInTimeZone } from 'date-fns-tz';
import { describe, expect, it } from 'vitest';

import { ShinhanCardParser } from './shinhan.parser.js';

const parser = new ShinhanCardParser();
const seoul = (date: Date): string => formatInTimeZone(date, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');

describe('ShinhanCardParser', () => {
  it('supports Shinhan messages only', () => {
    expect(
      parser.supports({ sender: '15447200', content: '신한카드 승인', receivedAt: new Date() }),
    ).toBe(true);
    expect(
      parser.supports({ sender: '15881688', content: 'KB국민카드 승인', receivedAt: new Date() }),
    ).toBe(false);
  });

  it('parses an approval with comma amount, timestamp and merchant', () => {
    const content = ['[Web발신]', '신한카드(1234)승인', '12,500원 일시불', '07/15 09:30', '스타벅스강남점'].join('\n');
    const receivedAt = new Date('2026-07-15T09:31:00+09:00');
    const result = parser.parse({ sender: '15447200', content, receivedAt });

    expect(result.issuer).toBe('신한카드');
    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(12500);
    expect(Number.isInteger(result.amount)).toBe(true);
    expect(result.currency).toBe('KRW');
    expect(result.merchantRaw).toBe('스타벅스강남점');
    expect(result.maskedCardNumber).toBe('****1234');
    expect(result.installmentMonths).toBe(1);
    expect(result.occurredAt).toBeInstanceOf(Date);
    expect(seoul(result.occurredAt as Date)).toBe('2026-07-15 09:30');
    expect(result.confidence).toBeGreaterThanOrEqual(90);
    expect(Number.isInteger(result.confidence)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('parses a cancellation (승인취소)', () => {
    const content = ['[Web발신]', '신한카드(1234)승인취소', '30,000원', '07/15 10:00', '이마트성수점'].join('\n');
    const receivedAt = new Date('2026-07-15T10:01:00+09:00');
    const result = parser.parse({ sender: '15447200', content, receivedAt });

    expect(result.transactionType).toBe('cancellation');
    expect(result.amount).toBe(30000);
    expect(Number.isInteger(result.amount)).toBe(true);
    expect(result.merchantRaw).toBe('이마트성수점');
  });

  it('parses an N-month installment', () => {
    const content = ['신한카드(5678)승인', '600,000원 6개월', '07/15 14:20', '하이마트'].join('\n');
    const receivedAt = new Date('2026-07-15T14:21:00+09:00');
    const result = parser.parse({ sender: '15447200', content, receivedAt });

    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(600000);
    expect(result.installmentMonths).toBe(6);
    expect(result.maskedCardNumber).toBe('****5678');
  });

  it('parses large comma-separated amounts as integers', () => {
    const content = ['신한카드(1234)승인', '1,234,500원 일시불', '07/15 09:30', '가전마트'].join('\n');
    const receivedAt = new Date('2026-07-15T09:31:00+09:00');
    const result = parser.parse({ sender: '15447200', content, receivedAt });

    expect(result.amount).toBe(1234500);
    expect(Number.isInteger(result.amount)).toBe(true);
  });

  it('defends against the December -> January year rollover', () => {
    const content = ['신한카드(1234)승인', '9,900원 일시불', '12/31 23:50', '편의점'].join('\n');
    const receivedAt = new Date('2027-01-01T00:05:00+09:00');
    const result = parser.parse({ sender: '15447200', content, receivedAt });

    // Received in 2027 but the transaction wall-clock is Dec 31 -> previous year.
    expect(seoul(result.occurredAt as Date)).toBe('2026-12-31 23:50');
  });
});
