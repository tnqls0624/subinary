import { describe, expect, it } from 'vitest';
import { matchFetchedItems, parseSujainRows } from './sujain-parse';

describe('sujain parse (synthetic only)', () => {
  it('reads payment and option rows together without inventing missing numbers', () => {
    const result = parseSujainRows([
      {
        sourcePage: 'payment',
        headers: ['구분', '회차', '예정금액', '납부예정일', '납부액', '수납일'],
        cells: ['중도금', '2회', '10,000,000', '2026-12-01', '0', ''],
      },
      {
        sourcePage: 'payment',
        headers: ['구분', '회차', '예정금액', '납부예정일', '납부액', '수납일'],
        cells: ['잔금', '', '50,000,000', '2028-03-01', '', ''],
      },
      {
        sourcePage: 'unit-items',
        headers: ['품목', '금액'],
        cells: ['합성 옵션 A', '1,200,000'],
      },
    ]);
    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => item.kind)).toEqual(['interim', 'balance', 'option']);
    expect(result.items[0]).toMatchObject({
      installment: 2,
      scheduledAmount: '10000000',
      dueDate: '2026-12-01',
      paidAmount: '0',
    });
    expect(result.items[1]?.paidAmount).toBeNull();
    expect(result.items[1]?.dueDate).toBe('2028-03-01');
    expect(result.items[2]).toMatchObject({
      label: '합성 옵션 A',
      scheduledAmount: '1200000',
    });
    expect(JSON.stringify(result)).not.toMatch(/password|비밀번호|SYNTHETIC_SECRET/i);
  });

  it('leaves unknown payment columns empty with a reason', () => {
    const result = parseSujainRows([
      {
        sourcePage: 'payment',
        headers: ['항목'],
        cells: ['계약금'],
      },
    ]);
    expect(result.items[0]?.scheduledAmount).toBeNull();
    expect(result.unreadCount).toBeGreaterThan(0);
    expect(result.unreadReasons[0]).toMatch(/예정 금액|칸/);
  });

  it('does not invent a scheduled amount from a numeric-looking cell when headers are missing', () => {
    const result = parseSujainRows([
      {
        sourcePage: 'payment',
        cells: ['계약금', '12,000,000', '2026-05-01'],
      },
    ]);
    expect(result.items[0]?.scheduledAmount).toBeNull();
    expect(result.items[0]?.dueDate).toBeNull();
    expect(result.items[0]?.unreadFields.some((field) => field.field === 'scheduledAmount')).toBe(true);
  });

  it('does not invent an option label from the first non-numeric cell when name headers are missing', () => {
    const result = parseSujainRows([
      {
        sourcePage: 'unit-items',
        headers: ['비고', '금액'],
        cells: ['합성 추정 금지 품목', '900,000'],
      },
    ]);
    expect(result.items[0]?.label).toBeNull();
    expect(result.items[0]?.scheduledAmount).toBe('900000');
    expect(result.items[0]?.unreadFields.some((field) => field.field === 'label')).toBe(true);
    expect(result.unreadReasons.some((reason) => /옵션 이름/.test(reason))).toBe(true);
  });

  it('prefers the more specific amount header when several synthetic headers match', () => {
    const result = parseSujainRows([
      {
        sourcePage: 'payment',
        headers: ['구분', '금액', '예정금액', '납부예정일'],
        cells: ['계약금', '1', '12,000,000', '2026-06-01'],
      },
    ]);
    expect(result.items[0]?.scheduledAmount).toBe('12000000');
  });

  it('does not treat a date header as the amount column when a synthetic amount header follows', () => {
    const result = parseSujainRows([
      {
        sourcePage: 'payment',
        headers: ['구분', '납부예정일', '예정금액'],
        cells: ['계약금', '2026-06-01', '12,000,000'],
      },
    ]);
    expect(result.items[0]?.scheduledAmount).toBe('12000000');
    expect(result.items[0]?.dueDate).toBe('2026-06-01');
  });

  it('shows only changed fields for an existing matched record', () => {
    const parsed = parseSujainRows([
      {
        sourcePage: 'payment',
        headers: ['구분', '회차', '예정금액', '납부예정일', '납부액'],
        cells: ['중도금', '1회', '20,000,000', '2027-01-15', '5,000,000'],
      },
    ]);
    const matched = matchFetchedItems(parsed.items, [
      {
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'interim',
        installment: 1,
        label: null,
        amount: '20000000',
        dueDate: '2027-01-15',
        paidAmount: '0',
        paidDate: null,
      },
    ]);
    expect(matched).toHaveLength(1);
    expect(matched[0]?.matchedPaymentId).toBe('11111111-1111-4111-8111-111111111111');
    expect(matched[0]?.changedFields).toEqual(['paidAmount']);
  });

  it('drops unchanged existing rows from the confirmation list', () => {
    const parsed = parseSujainRows([
      {
        sourcePage: 'payment',
        headers: ['구분', '예정금액', '납부예정일', '납부액'],
        cells: ['계약금', '1000', '2026-01-01', '1000'],
      },
    ]);
    const matched = matchFetchedItems(parsed.items, [
      {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'contract',
        installment: null,
        label: null,
        amount: '1000',
        dueDate: '2026-01-01',
        paidAmount: '1000',
        paidDate: null,
      },
    ]);
    expect(matched).toEqual([]);
  });
});
