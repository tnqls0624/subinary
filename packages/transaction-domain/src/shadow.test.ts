import { describe, expect, it } from 'vitest';

import type { MoneyColumns } from './plan.js';
import {
  classifyMoneyShadow,
  summarizeMoneyShadow,
  type ClassifyMoneyShadowInput,
  type MoneyShadowActual,
} from './shadow.js';

const actualKrw: MoneyShadowActual = {
  amount: 10_000,
  currency: 'KRW',
  originalAmount: null,
  originalCurrency: null,
  cancelledAmount: 0,
  originalCancelledAmount: null,
  netAmount: 10_000,
  parentTransactionId: null,
  status: 'approved',
  moneyContractVersion: 1,
};

const plannedKrw: MoneyColumns = {
  amount: 10_000,
  currency: 'KRW',
  originalAmount: null,
  originalCurrency: null,
  exchangeRate: null,
  fxRateSnapshotId: null,
  cancelledAmount: 0,
  originalCancelledAmount: null,
  netAmount: 10_000,
  parentTransactionId: null,
  status: 'approved',
  moneyContractVersion: 2,
};

function input(overrides: Partial<ClassifyMoneyShadowInput> = {}): ClassifyMoneyShadowInput {
  return {
    path: 'worker_promotion_approval',
    householdId: 'h1',
    transactionId: 't1',
    sourceEventId: 'e1',
    transactionType: 'approval',
    actual: actualKrw,
    planned: plannedKrw,
    failureReason: null,
    ...overrides,
  };
}

describe('shadow 분류', () => {
  it('금액·통화가 같으면 일치다 (계약 버전 차이는 delta가 아니다)', () => {
    const record = classifyMoneyShadow(input());
    expect(record.verdict).toBe('match');
    expect(record.netAmountDelta).toBe(0);
    expect(record.foreign).toBe(false);
  });

  it('KRW 금액이 갈리면 krw_amount_delta — 전환 조건이 0건을 요구하는 항목', () => {
    const record = classifyMoneyShadow(
      input({ planned: { ...plannedKrw, netAmount: 7_000, cancelledAmount: 3_000 } }),
    );
    expect(record.verdict).toBe('krw_amount_delta');
    expect(record.netAmountDelta).toBe(-3_000);
  });

  it('원통화가 외화면 외화 delta로 분류한다', () => {
    const record = classifyMoneyShadow(
      input({
        actual: { ...actualKrw, originalCurrency: 'USD', originalAmount: 10_000, amount: 140_000, netAmount: 140_000 },
        planned: { ...plannedKrw, originalCurrency: 'USD', originalAmount: 10_000, amount: 130_000, netAmount: 130_000 },
      }),
    );
    expect(record.foreign).toBe(true);
    expect(record.verdict).toBe('fx_amount_delta');
    expect(record.netAmountDelta).toBe(-10_000);
  });

  it('계획이 없으면 plan_failed이고 delta는 0이 아니라 null이다', () => {
    // 0으로 두면 "delta 없음"과 "비교 못 함"이 한 값에 섞여 게이트가 거짓 통과한다.
    const record = classifyMoneyShadow(
      input({ planned: null, failureReason: 'fx_snapshot_missing' }),
    );
    expect(record.verdict).toBe('plan_failed');
    expect(record.netAmountDelta).toBeNull();
    expect(record.failureReason).toBe('fx_snapshot_missing');
  });

  it('연결 대상이 갈리면 금액 차이보다 먼저 link_target_differs로 센다', () => {
    const record = classifyMoneyShadow(
      input({
        transactionType: 'cancellation',
        actual: { ...actualKrw, parentTransactionId: null, netAmount: 0 },
        planned: { ...plannedKrw, netAmount: 0 },
        plannedParentTransactionId: 'a9',
      }),
    );
    expect(record.verdict).toBe('link_target_differs');
    expect(record.plannedParentTransactionId).toBe('a9');
  });

  it('연결 판정을 하지 않은 경우(undefined)는 link 비교를 하지 않는다', () => {
    const record = classifyMoneyShadow(input({ plannedParentTransactionId: undefined }));
    expect(record.verdict).toBe('match');
  });

  it('저장 통화가 KRW가 아닌 D-3 행은 외화로 본다', () => {
    const record = classifyMoneyShadow(
      input({
        actual: { ...actualKrw, currency: 'USD', amount: 1_000, netAmount: 1_000 },
        planned: null,
        failureReason: 'fx_snapshot_missing',
      }),
    );
    expect(record.foreign).toBe(true);
    expect(record.verdict).toBe('plan_failed');
  });
});

describe('shadow 요약', () => {
  it('KRW delta 절대합만 게이트 지표로 센다', () => {
    const records = [
      classifyMoneyShadow(input()),
      classifyMoneyShadow(input({ planned: { ...plannedKrw, netAmount: 9_000 } })),
      classifyMoneyShadow(input({ planned: null, failureReason: 'fx_snapshot_missing' })),
    ];
    const summary = summarizeMoneyShadow(records);
    expect(summary.total).toBe(3);
    expect(summary.byVerdict.match).toBe(1);
    expect(summary.byVerdict.krw_amount_delta).toBe(1);
    expect(summary.byVerdict.plan_failed).toBe(1);
    expect(summary.krwAbsoluteDelta).toBe(1_000);
  });
});
