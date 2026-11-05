import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Db } from '@family/database';

import { LedgerService } from './ledger.service';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

const home = id(1);
const user = id(2);
const member = id(3);
const accountA = id(4);
const accountB = id(5);
const goal = id(6);
const key = id(7);

function accountRaw(over: Record<string, unknown> = {}) {
  return {
    id: accountA,
    household_id: home,
    person_id: member,
    institution_id: null,
    name: '급여통장',
    kind: 'checking',
    currency: 'KRW',
    balance: '100000',
    status: 'open',
    version: 1,
    created_at: '2026-11-05T00:00:00.000Z',
    updated_at: '2026-11-05T00:00:00.000Z',
    closed_at: null,
    ...over,
  };
}

type SelectResult = unknown[] | (() => unknown[]);

/** 호출 순서대로 select().limit() / thenable 결과를 돌려준다. */
function makeTx(opts: {
  executeImpl: (sqlText: string) => unknown[];
  selectResults: SelectResult[];
  insertRows: unknown[][];
}) {
  let selectIdx = 0;
  let insertIdx = 0;
  const execute = vi.fn(async (query: unknown) => {
    const sqlText =
      typeof query === 'object' && query && 'sql' in query
        ? String((query as { sql: string }).sql)
        : JSON.stringify(query);
    return opts.executeImpl(sqlText);
  });

  return {
    execute,
    select: () => {
      const idx = selectIdx;
      selectIdx += 1;
      const resolveRows = () => {
        const entry = opts.selectResults[idx] ?? [];
        return typeof entry === 'function' ? entry() : entry;
      };
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.from = self;
      b.innerJoin = self;
      b.where = self;
      b.orderBy = self;
      b.limit = async () => resolveRows();
      // drizzle list queries are thenable without limit()
      (b as { then?: unknown }).then = (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(resolveRows()).then(onFulfilled, onRejected);
      return b;
    },
    insert: () => {
      const b: Record<string, unknown> = {};
      b.values = () => b;
      b.returning = async () => {
        const rows = opts.insertRows[insertIdx] ?? [];
        insertIdx += 1;
        return rows;
      };
      return b;
    },
    update: () => {
      const b: Record<string, unknown> = {};
      b.set = () => b;
      b.where = async () => [];
      return b;
    },
  };
}

describe('LedgerService.recordTransaction', () => {
  it('가족 구성원이 아니면 거부한다', async () => {
    const tx = makeTx({
      executeImpl: () => [],
      selectResults: [[]],
      insertRows: [],
    });
    const db = { transaction: async (work: (t: typeof tx) => Promise<unknown>) => work(tx) };
    const service = new LedgerService(db as unknown as Db);
    await expect(
      service.recordTransaction(user, {
        householdId: home,
        accountId: accountA,
        kind: 'expense',
        amount: '1000',
        occurredAt: '2026-11-05T01:00:00.000Z',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('잘못된 요청 형식은 400', async () => {
    const tx = makeTx({ executeImpl: () => [], selectResults: [], insertRows: [] });
    const db = { transaction: async (work: (t: typeof tx) => Promise<unknown>) => work(tx) };
    const service = new LedgerService(db as unknown as Db);
    await expect(
      service.recordTransaction(user, { householdId: home }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('지출을 기록하고 잔액을 줄인다', async () => {
    const now = new Date('2026-11-05T01:00:00.000Z');
    const inserted = {
      id: id(8),
      householdId: home,
      accountId: accountA,
      personId: member,
      categoryId: null,
      kind: 'expense' as const,
      amount: '35000',
      currency: 'KRW' as const,
      memo: null,
      counterpartyAccountId: null,
      transferGroupId: null,
      goalId: null,
      occurredAt: now,
      createdAt: now,
      createdByUserId: user,
      idempotencyKey: key,
    };
    const tx = makeTx({
      executeImpl: () => [accountRaw({ balance: '100000' })],
      selectResults: [[{ id: member }], []],
      insertRows: [[inserted]],
    });
    const db = { transaction: async (work: (t: typeof tx) => Promise<unknown>) => work(tx) };
    const service = new LedgerService(db as unknown as Db);

    const result = await service.recordTransaction(user, {
      householdId: home,
      accountId: accountA,
      kind: 'expense',
      amount: '35000',
      occurredAt: '2026-11-05T01:00:00.000Z',
      idempotencyKey: key,
      id: id(8),
    });

    expect(result.replayed).toBe(false);
    expect(result.accountBalance).toBe('65000');
    expect(result.transaction.kind).toBe('expense');
    expect(result.transaction.amount).toBe('35000');
  });

  it('잔액 부족이면 422', async () => {
    const tx = makeTx({
      executeImpl: () => [accountRaw({ balance: '1000' })],
      selectResults: [[{ id: member }], []],
      insertRows: [],
    });
    const db = { transaction: async (work: (t: typeof tx) => Promise<unknown>) => work(tx) };
    const service = new LedgerService(db as unknown as Db);
    await expect(
      service.recordTransaction(user, {
        householdId: home,
        accountId: accountA,
        kind: 'expense',
        amount: '1001',
        occurredAt: '2026-11-05T01:00:00.000Z',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('같은 멱등 키면 재생한다', async () => {
    const now = new Date('2026-11-05T01:00:00.000Z');
    const existing = {
      id: id(8),
      householdId: home,
      accountId: accountA,
      personId: member,
      categoryId: null,
      kind: 'expense' as const,
      amount: '35000',
      currency: 'KRW' as const,
      memo: null,
      counterpartyAccountId: null,
      transferGroupId: null,
      goalId: null,
      occurredAt: now,
      createdAt: now,
      createdByUserId: user,
      idempotencyKey: key,
    };
    const tx = makeTx({
      executeImpl: () => [],
      selectResults: [[{ id: member }], [existing], [{ balance: '65000' }]],
      insertRows: [],
    });
    const db = { transaction: async (work: (t: typeof tx) => Promise<unknown>) => work(tx) };
    const service = new LedgerService(db as unknown as Db);
    const result = await service.recordTransaction(user, {
      householdId: home,
      accountId: accountA,
      kind: 'expense',
      amount: '35000',
      occurredAt: '2026-11-05T01:00:00.000Z',
      idempotencyKey: key,
    });
    expect(result.replayed).toBe(true);
    expect(result.accountBalance).toBe('65000');
  });
});

describe('LedgerService.transferBetweenAccounts', () => {
  it('goalId 이체로 잔액·목표 적립을 갱신한다', async () => {
    const now = new Date('2026-11-05T02:00:00.000Z');
    const outbound = {
      id: id(10),
      householdId: home,
      accountId: accountA,
      personId: member,
      categoryId: null,
      kind: 'transfer_out' as const,
      amount: '20000',
      currency: 'KRW' as const,
      memo: '적금',
      counterpartyAccountId: accountB,
      transferGroupId: id(12),
      goalId: goal,
      occurredAt: now,
      createdAt: now,
      createdByUserId: user,
      idempotencyKey: key,
    };
    const inbound = {
      ...outbound,
      id: id(11),
      accountId: accountB,
      kind: 'transfer_in' as const,
      counterpartyAccountId: accountA,
      idempotencyKey: `${key}:in`,
    };

    let lockCount = 0;
    const ordered = [accountA, accountB].sort();
    const byId: Record<string, Record<string, unknown>> = {
      [accountA]: accountRaw({ id: accountA, balance: '100000' }),
      [accountB]: accountRaw({
        id: accountB,
        balance: '5000',
        kind: 'savings',
        name: '목표통장',
      }),
    };

    const tx = makeTx({
      executeImpl: (sqlText) => {
        if (/from goals/i.test(sqlText)) {
          return [{ id: goal, saved_amount: '10000', status: 'open' }];
        }
        const accountId = ordered[lockCount] ?? accountA;
        lockCount += 1;
        return [byId[accountId]!];
      },
      selectResults: [[{ id: member }], []],
      insertRows: [[outbound], [inbound]],
    });
    const db = { transaction: async (work: (t: typeof tx) => Promise<unknown>) => work(tx) };
    const service = new LedgerService(db as unknown as Db);

    const result = await service.transferBetweenAccounts(user, {
      householdId: home,
      fromAccountId: accountA,
      toAccountId: accountB,
      amount: '20000',
      goalId: goal,
      memo: '적금',
      occurredAt: '2026-11-05T02:00:00.000Z',
      idempotencyKey: key,
      transferGroupId: id(12),
    });

    expect(result.replayed).toBe(false);
    expect(result.fromAccountBalance).toBe('80000');
    expect(result.toAccountBalance).toBe('25000');
    expect(result.goalSavedAmount).toBe('30000');
    expect(result.outbound.goalId).toBe(goal);
  });
});

describe('LedgerService.canSpend', () => {
  it('가용 잔액과 최근 지출로 ok 판단을 반환한다', async () => {
    const recent = {
      id: id(20),
      householdId: home,
      accountId: accountA,
      personId: member,
      categoryId: null,
      kind: 'expense' as const,
      amount: '5000',
      currency: 'KRW',
      memo: '커피',
      counterpartyAccountId: null,
      transferGroupId: null,
      goalId: null,
      occurredAt: new Date('2026-11-04T10:00:00.000Z'),
      createdAt: new Date('2026-11-04T10:00:00.000Z'),
      createdByUserId: user,
      idempotencyKey: id(21),
    };

    const tx = makeTx({
      executeImpl: () => [],
      selectResults: [
        [{ id: member }],
        [{ kind: 'checking', balance: '100000', status: 'open' }],
        [recent],
        [],
      ],
      insertRows: [],
    });
    const db = {
      transaction: async (
        work: (t: typeof tx) => Promise<unknown>,
        _opts?: unknown,
      ) => work(tx),
    };
    const service = new LedgerService(db as unknown as Db);
    const result = await service.canSpend(user, { householdId: home });
    expect(result.decision).toBe('ok');
    expect(result.availableKrw).toBe('100000');
    expect(result.recentSpendKrw).toBe('5000');
    expect(result.budgetRemainingKrw).toBeNull();
    expect(result.recentTransactions).toHaveLength(1);
  });
});
