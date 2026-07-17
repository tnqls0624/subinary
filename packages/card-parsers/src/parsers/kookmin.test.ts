import { formatInTimeZone } from 'date-fns-tz';
import { describe, expect, it } from 'vitest';

import { KookminCardParser } from './kookmin.parser.js';

const parser = new KookminCardParser();
const seoul = (date: Date): string => formatInTimeZone(date, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');

describe('KookminCardParser', () => {
  it('supports KB and 국민 messages only', () => {
    expect(
      parser.supports({ sender: '15881688', content: 'KB국민카드 승인', receivedAt: new Date() }),
    ).toBe(true);
    expect(
      parser.supports({ sender: '15881688', content: '국민카드 승인', receivedAt: new Date() }),
    ).toBe(true);
    expect(
      parser.supports({ sender: '15447200', content: '신한카드 승인', receivedAt: new Date() }),
    ).toBe(false);
  });

  it('parses an approval', () => {
    const content = ['[Web발신]', 'KB국민카드', '승인 8,900원 일시불', '07/15 12:05', 'GS25역삼'].join('\n');
    const receivedAt = new Date('2026-07-15T12:06:00+09:00');
    const result = parser.parse({ sender: '15881688', content, receivedAt });

    expect(result.issuer).toBe('KB국민카드');
    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(8900);
    expect(Number.isInteger(result.amount)).toBe(true);
    expect(result.currency).toBe('KRW');
    expect(result.merchantRaw).toBe('GS25역삼');
    expect(result.installmentMonths).toBe(1);
    expect(result.occurredAt).toBeInstanceOf(Date);
    expect(seoul(result.occurredAt as Date)).toBe('2026-07-15 12:05');
    expect(result.confidence).toBeGreaterThanOrEqual(90);
    // KB standard layout omits the card number → no tail to recover (unlinked).
    expect(result.maskedCardNumber).toBeUndefined();
  });

  it('recovers an asterisk-masked tail', () => {
    const content = ['[Web발신]', 'KB국민카드', '승인 8,900원 일시불', '****1234', '07/15 12:05', 'GS25역삼'].join('\n');
    const receivedAt = new Date('2026-07-15T12:06:00+09:00');
    const result = parser.parse({ sender: '15881688', content, receivedAt });

    expect(result.maskedCardNumber).toBe('****1234');
    // The masked tail line must not be mistaken for the merchant.
    expect(result.merchantRaw).toBe('GS25역삼');
  });

  it('recovers a line-isolated tail', () => {
    const content = ['국민카드 승인', '9,900원 일시불', '07/15 15:00', '무신사', '1234'].join('\n');
    const receivedAt = new Date('2026-07-15T15:01:00+09:00');
    const result = parser.parse({ sender: '15881688', content, receivedAt });

    expect(result.maskedCardNumber).toBe('****1234');
    expect(result.merchantRaw).toBe('무신사');
  });

  it('parses a cancellation', () => {
    const content = ['KB국민카드', '취소 45,000원', '07/15 18:30', '올리브영'].join('\n');
    const receivedAt = new Date('2026-07-15T18:31:00+09:00');
    const result = parser.parse({ sender: '15881688', content, receivedAt });

    expect(result.transactionType).toBe('cancellation');
    expect(result.amount).toBe(45000);
    expect(Number.isInteger(result.amount)).toBe(true);
    expect(result.merchantRaw).toBe('올리브영');
  });

  it('parses installment months for a 국민 message', () => {
    const content = ['국민카드 승인', '300,000원 3개월', '07/15 15:00', '무신사'].join('\n');
    const receivedAt = new Date('2026-07-15T15:01:00+09:00');
    const result = parser.parse({ sender: '15881688', content, receivedAt });

    expect(result.transactionType).toBe('approval');
    expect(result.amount).toBe(300000);
    expect(result.installmentMonths).toBe(3);
    expect(result.merchantRaw).toBe('무신사');
  });
});
