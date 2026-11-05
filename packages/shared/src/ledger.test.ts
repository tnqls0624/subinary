import { describe, expect, it } from 'vitest';

import {
  applyGoalContribution,
  applyRecordTransactionBalance,
  applyTransferBalances,
  bigintToKrwString,
  countsTowardRecentSpend,
  judgeCanSpend,
  remainingForBudgetRule,
  sumSpendableBalances,
  tightestBudgetRemaining,
} from './ledger.js';

describe('applyRecordTransactionBalance', () => {
  it('자산 계좌 지출은 잔액을 줄인다', () => {
    const result = applyRecordTransactionBalance({
      kind: 'expense',
      accountKind: 'checking',
      currentBalance: '10000',
      amount: '3500',
      status: 'open',
    });
    expect(result).toEqual({ ok: true, nextBalance: 6500n });
  });

  it('잔액보다 큰 지출은 거부한다', () => {
    const result = applyRecordTransactionBalance({
      kind: 'expense',
      accountKind: 'cash',
      currentBalance: '1000',
      amount: '1001',
      status: 'open',
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_balance' });
  });

  it('대출 상환(expense)은 남은 원금을 줄인다', () => {
    const result = applyRecordTransactionBalance({
      kind: 'expense',
      accountKind: 'loan',
      currentBalance: '50000',
      amount: '10000',
      status: 'open',
    });
    expect(result).toEqual({ ok: true, nextBalance: 40000n });
  });

  it('닫힌 계좌는 거부한다', () => {
    const result = applyRecordTransactionBalance({
      kind: 'income',
      accountKind: 'savings',
      currentBalance: '0',
      amount: '100',
      status: 'closed',
    });
    expect(result).toEqual({ ok: false, reason: 'closed_account' });
  });
});

describe('applyTransferBalances', () => {
  it('두 자산 계좌 이체를 적용한다', () => {
    const result = applyTransferBalances({
      fromKind: 'checking',
      toKind: 'savings',
      fromBalance: '20000',
      toBalance: '5000',
      amount: '7000',
      fromStatus: 'open',
      toStatus: 'open',
    });
    expect(result).toEqual({ ok: true, nextFrom: 13000n, nextTo: 12000n });
  });

  it('대출 계좌 이체는 지원하지 않는다', () => {
    const result = applyTransferBalances({
      fromKind: 'checking',
      toKind: 'loan',
      fromBalance: '20000',
      toBalance: '5000',
      amount: '1000',
      fromStatus: 'open',
      toStatus: 'open',
    });
    expect(result).toEqual({ ok: false, reason: 'loan_transfer_unsupported' });
  });
});

describe('applyGoalContribution', () => {
  it('열린 목표에 적립액을 더한다', () => {
    expect(
      applyGoalContribution({
        savedAmount: '1000',
        amount: '500',
        status: 'open',
      }),
    ).toEqual({ ok: true, nextSaved: 1500n });
  });
});

describe('judgeCanSpend', () => {
  it('가용·예산이 충분하면 ok', () => {
    expect(
      judgeCanSpend({
        availableKrw: 100_000n,
        recentSpendKrw: 10_000n,
        budgetRemainingKrw: 50_000n,
      }).decision,
    ).toBe('ok');
  });

  it('가용 0이면 no', () => {
    expect(
      judgeCanSpend({
        availableKrw: 0n,
        recentSpendKrw: 0n,
        budgetRemainingKrw: null,
      }),
    ).toMatchObject({ decision: 'no' });
  });

  it('최근 지출이 가용보다 크면 caution', () => {
    expect(
      judgeCanSpend({
        availableKrw: 10_000n,
        recentSpendKrw: 20_000n,
        budgetRemainingKrw: null,
      }).decision,
    ).toBe('caution');
  });
});

describe('집계 헬퍼', () => {
  it('현금성 열린 계좌만 합산한다', () => {
    expect(
      sumSpendableBalances([
        { kind: 'checking', balance: '1000', status: 'open' },
        { kind: 'loan', balance: '9999', status: 'open' },
        { kind: 'cash', balance: '200', status: 'closed' },
        { kind: 'savings', balance: '300', status: 'open' },
      ]),
    ).toBe(1300n);
  });

  it('목표 적립 이체는 최근 지출에서 뺀다', () => {
    expect(countsTowardRecentSpend({ kind: 'expense', goalId: null })).toBe(true);
    expect(
      countsTowardRecentSpend({ kind: 'transfer_out', goalId: null }),
    ).toBe(true);
    expect(
      countsTowardRecentSpend({
        kind: 'transfer_out',
        goalId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toBe(false);
  });

  it('bigint를 KRW 문자열로 바꾼다', () => {
    expect(bigintToKrwString(0n)).toBe('0');
    expect(bigintToKrwString(12345n)).toBe('12345');
  });
});

describe('예산 규칙별 잔여', () => {
  const personA = '00000000-0000-4000-8000-0000000000aa';
  const personB = '00000000-0000-4000-8000-0000000000bb';
  const food = '00000000-0000-4000-8000-0000000000cc';
  const spends = [
    {
      amount: 3000n,
      categoryId: food,
      personId: personA,
      kind: 'expense',
      goalId: null,
    },
    {
      amount: 7000n,
      categoryId: food,
      personId: personB,
      kind: 'expense',
      goalId: null,
    },
    {
      amount: 2000n,
      categoryId: null,
      personId: personA,
      kind: 'expense',
      goalId: null,
    },
  ];

  it('카테고리·person 조건을 각각 적용한다', () => {
    expect(
      remainingForBudgetRule({
        amountLimit: 10_000n,
        categoryId: food,
        personId: personA,
        spends,
      }),
    ).toBe(7000n);
    expect(
      remainingForBudgetRule({
        amountLimit: 10_000n,
        categoryId: food,
        personId: null,
        spends,
      }),
    ).toBe(0n);
  });

  it('규칙별 잔여 중 최솟값을 고른다', () => {
    expect(tightestBudgetRemaining([5000n, 1200n, 8000n])).toBe(1200n);
    expect(tightestBudgetRemaining([])).toBeNull();
  });
});
