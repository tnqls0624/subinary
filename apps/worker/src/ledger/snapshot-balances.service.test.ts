import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@family/database';

import { SnapshotBalancesService } from './snapshot-balances.service';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-3333-4333-8333-333333333333`;

describe('SnapshotBalancesService', () => {
  function selectChain(rows: unknown[]) {
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.from = self;
    b.where = self;
    (b as { then: unknown }).then = (
      onFulfilled: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(rows).then(onFulfilled, onRejected);
    return b;
  }

  it('열린 계좌가 없으면 삽입하지 않는다', async () => {
    const insert = vi.fn();
    const db = {
      select: () => selectChain([]),
      insert,
    };
    const service = new SnapshotBalancesService(db as unknown as Db);
    const result = await service.run(id(1));
    expect(result.accountCount).toBe(0);
    expect(result.insertedCount).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it('열린 계좌 잔액을 배치로 저장하고 ON CONFLICT DO NOTHING을 쓴다', async () => {
    const returning = vi.fn(async () => [{ id: id(10) }, { id: id(11) }]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    const accounts = [
      {
        id: id(2),
        householdId: id(3),
        balance: '12000',
        currency: 'KRW',
      },
      {
        id: id(4),
        householdId: id(3),
        balance: '500',
        currency: 'KRW',
      },
    ];
    const db = {
      select: () => selectChain(accounts),
      insert,
    };
    const service = new SnapshotBalancesService(db as unknown as Db);
    const batchId = id(9);
    const result = await service.run(batchId);
    expect(result.accountCount).toBe(2);
    expect(result.insertedCount).toBe(2);
    expect(result.batchId).toBe(batchId);
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: expect.any(Array),
    });
    expect(values).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: id(2),
          balance: '12000',
          batchId,
          source: 'scheduled',
        }),
      ]),
    );
  });

  it('재시도에서 충돌하면 insertedCount만 줄고 실패하지 않는다', async () => {
    const returning = vi.fn(async () => []); // 전부 conflict
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    const db = {
      select: () =>
        selectChain([
          {
            id: id(2),
            householdId: id(3),
            balance: '12000',
            currency: 'KRW',
          },
        ]),
      insert,
    };
    const service = new SnapshotBalancesService(db as unknown as Db);
    const result = await service.run(id(9));
    expect(result.accountCount).toBe(1);
    expect(result.insertedCount).toBe(0);
  });
});
