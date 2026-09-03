import { describe, expect, it } from 'vitest';

import { v2ConstraintViolations } from '@family/database';

import type { MoneyColumns } from './plan.js';
import {
  MONEY_REPAIR_AUTO_VERDICTS,
  TransactionMoneyRepairManifestSink,
  classifyRepairEligibility,
  planKeepsMoneyIdentity,
  repairAction,
} from './repair.js';
import type { MoneyShadowActual, MoneyShadowRecord, MoneyShadowVerdict } from './shadow.js';

const ALL_VERDICTS: readonly MoneyShadowVerdict[] = [
  'match',
  'krw_amount_delta',
  'fx_amount_delta',
  'plan_failed',
  'link_target_differs',
  'link_manual_only',
];

const actual: MoneyShadowActual = {
  amount: 10_000,
  currency: 'KRW',
  originalAmount: null,
  originalCurrency: null,
  cancelledAmount: 0,
  originalCancelledAmount: null,
  netAmount: 10_000,
  parentTransactionId: 'parent-chosen-by-human',
  status: 'approved',
  moneyContractVersion: 1,
};

const row = {
  id: 'txn-1',
  amount: 10_000,
  currency: 'KRW',
  originalAmount: null,
  originalCurrency: null,
  exchangeRate: null,
  fxRateSnapshotId: null,
  cancelledAmount: 0,
  originalCancelledAmount: null,
  netAmount: 10_000,
  parentTransactionId: 'parent-chosen-by-human',
  status: 'approved',
  moneyContractVersion: 1,
  approvedAt: new Date('2026-05-01T00:00:00Z'),
};

function record(overrides: Partial<MoneyShadowRecord> = {}): MoneyShadowRecord {
  return {
    path: 'worker_promotion_approval',
    verdict: 'match',
    householdId: 'household-1',
    transactionId: 'txn-1',
    sourceEventId: 'event-1',
    transactionType: 'approval',
    foreign: false,
    actual,
    planned: null,
    failureReason: null,
    netAmountDelta: null,
    plannedParentTransactionId: null,
    ...overrides,
  };
}

/** insert된 값만 모으는 최소 fake. 판정 로직은 순수하므로 DB가 필요 없다. */
function fakeDb() {
  const captured: Record<string, unknown>[] = [];
  return {
    captured,
    db: {
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          captured.push(value);
        },
      }),
    } as never,
  };
}

describe('classifyRepairEligibility', () => {
  it('자동 적용은 금액과 체인이 그대로인 두 판정뿐이다', () => {
    const auto = ALL_VERDICTS.filter((v) => classifyRepairEligibility(v) === 'auto');
    expect(auto).toEqual(['match', 'link_manual_only']);
    expect(MONEY_REPAIR_AUTO_VERDICTS).toEqual(auto);
  });

  it('금액이나 체인이 바뀌는 판정은 하나도 자동으로 넘기지 않는다', () => {
    for (const verdict of ['krw_amount_delta', 'fx_amount_delta', 'plan_failed', 'link_target_differs'] as const) {
      expect(classifyRepairEligibility(verdict)).toBe('review');
    }
  });
});

describe('classifyRepairEligibility — v2 제약 관문', () => {
  it('금액이 같아도 v2 제약을 어기면 자동으로 넘기지 않는다', () => {
    // 2026-09-03 실행에서 배운 것: match는 "금액이 같다"이지 "v2로 올려도 된다"가 아니다.
    expect(classifyRepairEligibility('match', ['v2_fx_snapshot'])).toBe('review');
    expect(classifyRepairEligibility('link_manual_only', ['v2_currency_krw'])).toBe('review');
  });

  it('위반이 없으면 기존 판정 그대로다', () => {
    expect(classifyRepairEligibility('match', [])).toBe('auto');
  });
});

describe('v2ConstraintViolations', () => {
  const krwApproval = {
    ...row,
    transactionType: 'approval',
  };

  it('KRW 승인은 위반이 없다', () => {
    expect(v2ConstraintViolations(krwApproval)).toEqual([]);
  });

  it('외화인데 환율 스냅샷이 없으면 잡는다 — 실제로 배치를 멈춘 그 제약', () => {
    expect(
      v2ConstraintViolations({
        ...krwApproval,
        originalAmount: 2_200,
        originalCurrency: 'USD',
        originalCancelledAmount: 0,
        fxRateSnapshotId: null,
      }),
    ).toContain('v2_fx_snapshot');
  });

  it('저장 통화가 KRW가 아니면 잡는다', () => {
    expect(v2ConstraintViolations({ ...krwApproval, currency: 'USD' })).toContain(
      'v2_currency_krw',
    );
  });

  it('원금액과 원통화가 한쪽만 있으면 잡는다', () => {
    expect(
      v2ConstraintViolations({ ...krwApproval, originalAmount: 2_200, originalCurrency: null }),
    ).toContain('v2_original_pair');
  });

  it('승인 순액 항등식이 깨지면 잡는다', () => {
    expect(
      v2ConstraintViolations({ ...krwApproval, cancelledAmount: 500 }),
    ).toContain('v2_approval_sum');
  });

  it('취소 행의 순액이 0이 아니면 잡는다', () => {
    expect(
      v2ConstraintViolations({ ...row, transactionType: 'cancellation', netAmount: 3_000 }),
    ).toContain('v2_cancellation_net_zero');
  });
});

describe('repairAction', () => {
  it('자동 대상은 재계산으로 적는다 — 실제로 재계산했더니 같았다는 뜻이다', () => {
    expect(repairAction(record({ verdict: 'match' }))).toBe('recalculate_chain');
    expect(repairAction(record({ verdict: 'link_manual_only' }))).toBe('recalculate_chain');
  });

  it('연결 대상이 다르면 취소 연결 수리다', () => {
    expect(repairAction(record({ verdict: 'link_target_differs' }))).toBe('link_cancellation');
  });

  it('저장 통화가 KRW가 아닌 검토 대상은 통화 정규화가 먼저다', () => {
    expect(
      repairAction(
        record({
          verdict: 'krw_amount_delta',
          actual: { ...actual, currency: 'USD' },
        }),
      ),
    ).toBe('normalize_currency');
  });
});

describe('planKeepsMoneyIdentity', () => {
  it('증빙만 채우는 계획은 통과한다 — 없던 근거가 생기는 것', () => {
    expect(
      planKeepsMoneyIdentity(
        { ...row, originalCurrency: 'USD', originalAmount: 2_200, fxRateSnapshotId: null },
        {
          ...row,
          originalCurrency: 'USD',
          originalAmount: 2_200,
          fxRateSnapshotId: 'snapshot-1',
          originalCancelledAmount: 0,
        },
      ),
    ).toBe(true);
  });

  it('금액이 움직이면 통과하지 못한다', () => {
    expect(planKeepsMoneyIdentity(row, { ...row, netAmount: 9_500 })).toBe(false);
    expect(planKeepsMoneyIdentity(row, { ...row, currency: 'USD' })).toBe(false);
  });

  it('사람이 고른 연결을 끊는 계획은 통과하지 못한다', () => {
    expect(planKeepsMoneyIdentity(row, { ...row, parentTransactionId: null })).toBe(false);
  });

  it('이미 있는 환율을 다른 값으로 바꾸는 계획은 통과하지 못한다', () => {
    // `값 → 다른 값`을 허용하면 사용자가 본 KRW가 흔들린다.
    expect(
      planKeepsMoneyIdentity(
        { ...row, exchangeRate: 1_486.949463 },
        { ...row, exchangeRate: 1_500 },
      ),
    ).toBe(false);
  });

  it('계획이 없으면 통과하지 못한다', () => {
    expect(planKeepsMoneyIdentity(row, null)).toBe(false);
  });
});

describe('TransactionMoneyRepairManifestSink', () => {
  it('auto 행은 계약 버전만 올린 after를 남기고 delta가 0이다', async () => {
    const { captured, db } = fakeDb();
    const sink = new TransactionMoneyRepairManifestSink(db, 'batch-1');

    await sink.record(record({ verdict: 'match' }), row);

    const [entry] = captured;
    expect(entry.batchId).toBe('batch-1');
    expect(entry.reason).toBe('repair:auto:match');
    expect((entry.beforeMoney as Record<string, unknown>).moneyContractVersion).toBe(1);
    expect((entry.afterMoney as Record<string, unknown>).moneyContractVersion).toBe(2);
    // 금액은 한 원도 움직이지 않는다 — 이것이 auto 경로의 전제다.
    expect(entry.netAmountBefore).toBe(10_000);
    expect(entry.netAmountAfter).toBe(10_000);
    expect(entry.currencyBefore).toBe('KRW');
    expect(entry.currencyAfter).toBe('KRW');
    // 미적용 manifest: lifecycle check의 첫 분기여야 한다.
    expect(entry.appliedAt).toBeUndefined();
    expect(entry.checksumAfter).toBeUndefined();
  });

  it('link_manual_only의 after가 사람이 고른 연결을 끊지 않는다', async () => {
    const { captured, db } = fakeDb();
    const sink = new TransactionMoneyRepairManifestSink(db, 'batch-2');

    // 취소 행의 순액은 0이다(v2-6). 이 값을 틀리게 두면 제약 관문이 먼저 걸러서
    // 정작 보려던 것(연결 보존)을 못 본다 — 실제로 처음 작성했을 때 그렇게 걸렸다.
    const cancellationRow = { ...row, netAmount: 0, parentTransactionId: 'parent-chosen-by-human' };

    // 신규 규칙은 후보가 유일하지 않아 부모를 고르지 못했다(=null).
    await sink.record(
      record({
        verdict: 'link_manual_only',
        transactionType: 'cancellation',
        actual: { ...actual, netAmount: 0 },
        plannedParentTransactionId: null,
        planned: { ...(cancellationRow as unknown as MoneyColumns), parentTransactionId: null },
      }),
      cancellationRow,
    );

    const after = captured[0].afterMoney as Record<string, unknown>;
    // 계획을 그대로 적용했다면 여기가 null이 되어 사람이 한 연결이 끊긴다.
    expect(after.parentTransactionId).toBe('parent-chosen-by-human');
    expect(after.moneyContractVersion).toBe(2);
  });

  it('review 행은 관찰기의 계획을 그대로 담는다', async () => {
    const { captured, db } = fakeDb();
    const sink = new TransactionMoneyRepairManifestSink(db, 'batch-3');

    await sink.record(
      record({
        verdict: 'krw_amount_delta',
        netAmountDelta: -500,
        planned: { ...(row as unknown as MoneyColumns), netAmount: 9_500, cancelledAmount: 500 },
      }),
      row,
    );

    const [entry] = captured;
    expect(entry.reason).toBe('repair:review:krw_amount_delta');
    expect(entry.netAmountBefore).toBe(10_000);
    expect(entry.netAmountAfter).toBe(9_500);
  });

  it('계획이 없으면 net before/after를 둘 다 비운다 — delta 부풀림 방지', async () => {
    const { captured, db } = fakeDb();
    const sink = new TransactionMoneyRepairManifestSink(db, 'batch-4');

    await sink.record(
      record({ verdict: 'plan_failed', failureReason: 'fx_snapshot_missing', planned: null }),
      row,
    );

    const [entry] = captured;
    expect(entry.afterMoney).toBeNull();
    // 한쪽만 채우면 생성 컬럼 net_amount_delta가 `-before`가 되어 합계가 거짓말을 한다.
    expect(entry.netAmountBefore).toBeNull();
    expect(entry.netAmountAfter).toBeNull();
  });

  it('외화·스냅샷 없음은 review로 보내고 무엇이 막았는지 reason에 적는다', async () => {
    const { captured, db } = fakeDb();
    const sink = new TransactionMoneyRepairManifestSink(db, 'batch-7');

    await sink.record(record({ verdict: 'match' }), {
      ...row,
      originalAmount: 2_200,
      originalCurrency: 'USD',
      originalCancelledAmount: 0,
      fxRateSnapshotId: null,
    });

    // `review:match`로 적으면 "일치하는데 왜 검토?"라는 답 없는 줄이 집계에 남는다.
    expect(captured[0].reason).toBe('repair:review:v2_fx_snapshot');
    expect(captured[0].action).toBe('normalize_currency');
    expect(JSON.parse(captured[0].note as string).v2Violations).toContain('v2_fx_snapshot');
  });

  it('스냅샷만 채우면 v2가 되는 행은 auto(증빙 채움)로 간다', async () => {
    const { captured, db } = fakeDb();
    const sink = new TransactionMoneyRepairManifestSink(db, 'batch-8');
    const fxRow = {
      ...row,
      originalAmount: 2_200,
      originalCurrency: 'USD',
      originalCancelledAmount: 0,
      exchangeRate: 1_486.949463,
      fxRateSnapshotId: null,
    };

    await sink.record(
      record({
        verdict: 'match',
        foreign: true,
        // 스냅샷을 고정해 둔 뒤라 계획이 그것을 고른다. 금액은 그대로다.
        planned: { ...(fxRow as unknown as MoneyColumns), fxRateSnapshotId: 'snapshot-1' },
      }),
      fxRow,
    );

    const [entry] = captured;
    expect(entry.reason).toBe('repair:auto:evidence:v2_fx_snapshot');
    const after = entry.afterMoney as Record<string, unknown>;
    expect(after.fxRateSnapshotId).toBe('snapshot-1');
    expect(after.moneyContractVersion).toBe(2);
    // 금액은 한 원도 움직이지 않는다.
    expect(entry.netAmountBefore).toBe(entry.netAmountAfter);
  });

  it('금액을 바꾸는 계획은 증빙 모드로 통과하지 못한다', async () => {
    const { captured, db } = fakeDb();
    const sink = new TransactionMoneyRepairManifestSink(db, 'batch-9');
    const fxRow = {
      ...row,
      originalAmount: 2_200,
      originalCurrency: 'USD',
      originalCancelledAmount: 0,
      fxRateSnapshotId: null,
    };

    await sink.record(
      record({
        verdict: 'match',
        planned: {
          ...(fxRow as unknown as MoneyColumns),
          fxRateSnapshotId: 'snapshot-1',
          netAmount: 30_000, // 금액이 움직인다
        },
      }),
      fxRow,
    );

    expect(captured[0].reason).toBe('repair:review:v2_fx_snapshot');
  });

  it('통계가 auto/review를 나눠 센다', async () => {
    const { db } = fakeDb();
    const sink = new TransactionMoneyRepairManifestSink(db, 'batch-5');

    await sink.record(record({ verdict: 'match' }), row);
    await sink.record(record({ verdict: 'link_manual_only' }), row);
    await sink.record(record({ verdict: 'plan_failed' }), row);

    expect(sink.stats()).toMatchObject({
      batchId: 'batch-5',
      planned: 3,
      auto: 2,
      review: 1,
    });
  });

  it('기록 실패를 삼키지 않는다 — 남지 않은 계획은 되돌릴 수 없다', async () => {
    const db = {
      insert: () => ({
        values: async () => {
          throw new Error('insert failed');
        },
      }),
    } as never;
    const sink = new TransactionMoneyRepairManifestSink(db, 'batch-6');

    await expect(sink.record(record(), row)).rejects.toThrow('insert failed');
  });
});
