import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PG_UNIQUE_VIOLATION, type Db } from '@family/database';

import { LedgerService } from './ledger.service';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

const home = id(1);
const otherHome = id(99);
const user = id(2);
const member = id(3);
const accountA = id(4);
const accountB = id(5);
const goal = id(6);
const key = id(7);
const foodCat = id(30);
const personB = id(31);

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

function makeTx(opts: {
  executeImpl?: (sqlText: string) => unknown[];
  selectResults?: SelectResult[];
  insertRows?: unknown[][];
  updateReturning?: unknown[][];
  insertThrows?: unknown;
}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const execute = vi.fn(async (query: unknown) => {
    const sqlText =
      typeof query === 'object' && query && 'sql' in query
        ? String((query as { sql: string }).sql)
        : JSON.stringify(query);
    return (opts.executeImpl ?? (() => []))(sqlText);
  });

  return {
    execute,
    select: () => {
      const idx = selectIdx;
      selectIdx += 1;
      const resolveRows = () => {
        const entry = (opts.selectResults ?? [])[idx] ?? [];
        return typeof entry === 'function' ? entry() : entry;
      };
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.from = self;
      b.innerJoin = self;
      b.where = self;
      b.orderBy = self;
      b.limit = async () => resolveRows();
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
        if (opts.insertThrows) throw opts.insertThrows;
        const rows = (opts.insertRows ?? [])[insertIdx] ?? [];
        insertIdx += 1;
        return rows;
      };
      return b;
    },
    update: () => {
      const b: Record<string, unknown> = {};
      b.set = () => b;
      b.where = () => b;
      b.returning = async () => {
        const rows = (opts.updateReturning ?? [[{ id: accountA }]])[updateIdx] ?? [];
        updateIdx += 1;
        return rows;
      };
      return b;
    },
  };
}

function uniqueError(): Error {
  const err = new Error('duplicate key') as Error & { code: string };
  err.code = PG_UNIQUE_VIOLATION;
  return err;
}

function serviceWithDb(db: unknown): LedgerService {
  return new LedgerService(db as Db);
}

/** 바깥 db.select: requireMember → early replay(및 이후) 순서를 흉내낸다. */
function outerSelectQueue(rowsPerCall: unknown[][]) {
  let selectCalls = 0;
  return () => {
    const call = selectCalls;
    selectCalls += 1;
    const rows = rowsPerCall[call] ?? [];
    const b: Record<string, unknown> = {};
    b.from = () => b;
    b.innerJoin = () => b;
    b.where = () => b;
    b.limit = async () => rows;
    return b;
  };
}

describe('LedgerService.recordTransaction', () => {
  it('가족 구성원이 아니면 거부한다', async () => {
    const service = serviceWithDb({
      select: outerSelectQueue([[]]),
      transaction: async () => {
        throw new Error('비멤버는 쓰기 tx를 열지 않는다');
      },
    });
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
    const service = serviceWithDb({
      select: outerSelectQueue([[]]),
      transaction: async () => {
        throw new Error('should not run');
      },
    });
    await expect(
      service.recordTransaction(user, { householdId: home }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('타 가구 계좌는 잠금 조회에서 차단한다', async () => {
    const service = serviceWithDb({
      // member ok, early miss → tx
      select: outerSelectQueue([[{ id: member }], []]),
      transaction: async (work: (t: ReturnType<typeof makeTx>) => Promise<unknown>) => {
        const tx = makeTx({
          selectResults: [[{ id: member }], []],
          executeImpl: () => [], // household mismatch → empty
        });
        return work(tx);
      },
    });
    await expect(
      service.recordTransaction(user, {
        householdId: home,
        accountId: accountA,
        kind: 'expense',
        amount: '1000',
        occurredAt: '2026-11-05T01:00:00.000Z',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    void otherHome;
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
    const service = serviceWithDb({
      select: outerSelectQueue([[{ id: member }], []]),
      transaction: async (work: (t: ReturnType<typeof makeTx>) => Promise<unknown>) => {
        const tx = makeTx({
          executeImpl: () => [accountRaw({ balance: '100000' })],
          selectResults: [[{ id: member }], []],
          insertRows: [[inserted]],
          updateReturning: [[{ id: accountA }]],
        });
        return work(tx);
      },
    });

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
    expect(result.transaction.amount).toBe('35000');
  });

  it('잔액 부족이면 422', async () => {
    const service = serviceWithDb({
      select: outerSelectQueue([[{ id: member }], []]),
      transaction: async (work: (t: ReturnType<typeof makeTx>) => Promise<unknown>) => {
        const tx = makeTx({
          executeImpl: () => [accountRaw({ balance: '1000' })],
          selectResults: [[{ id: member }], []],
        });
        return work(tx);
      },
    });
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

  it('닫힌 계좌면 422', async () => {
    const service = serviceWithDb({
      select: outerSelectQueue([[{ id: member }], []]),
      transaction: async (work: (t: ReturnType<typeof makeTx>) => Promise<unknown>) => {
        const tx = makeTx({
          executeImpl: () => [
            accountRaw({ status: 'closed', closed_at: '2026-11-01T00:00:00.000Z' }),
          ],
          selectResults: [[{ id: member }], []],
        });
        return work(tx);
      },
    });
    await expect(
      service.recordTransaction(user, {
        householdId: home,
        accountId: accountA,
        kind: 'income',
        amount: '1000',
        occurredAt: '2026-11-05T01:00:00.000Z',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('구성원 확인 뒤 같은 멱등 키면 쓰기 tx 없이 재생한다', async () => {
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
    const service = serviceWithDb({
      select: outerSelectQueue([
        [{ id: member }],
        [existing],
        [{ balance: '65000' }],
      ]),
      transaction: async () => {
        throw new Error('구성원·재생만으로 끝나면 쓰기 tx를 열지 않는다');
      },
    });
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

  it('비멤버는 멱등 키가 있어도 거래 요약을 재생하지 못한다', async () => {
    let selectCalls = 0;
    const service = serviceWithDb({
      select: () => {
        selectCalls += 1;
        const b: Record<string, unknown> = {};
        b.from = () => b;
        b.innerJoin = () => b;
        b.where = () => b;
        b.limit = async () => []; // 비멤버 → requireMember에서 거절
        return b;
      },
      transaction: async () => {
        throw new Error('비멤버는 tx에 들어가지 않는다');
      },
    });
    await expect(
      service.recordTransaction(user, {
        householdId: home,
        accountId: accountA,
        kind: 'expense',
        amount: '35000',
        occurredAt: '2026-11-05T01:00:00.000Z',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // requireMember만 호출되고 loadRecordReplay select는 없어야 함(IDOR 방지)
    expect(selectCalls).toBe(1);
  });

  it('동시 멱등 경합(23505)이면 구성원 재확인 뒤 replayed:true로 반환한다', async () => {
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
    const service = serviceWithDb({
      select: outerSelectQueue([
        [{ id: member }],
        [], // early miss
        [{ id: member }], // after 23505
        [existing],
        [{ balance: '65000' }],
      ]),
      transaction: async () => {
        throw uniqueError();
      },
    });
    const result = await service.recordTransaction(user, {
      householdId: home,
      accountId: accountA,
      kind: 'expense',
      amount: '35000',
      occurredAt: '2026-11-05T01:00:00.000Z',
      idempotencyKey: key,
    });
    expect(result.replayed).toBe(true);
    expect(result.transaction.id).toBe(existing.id);
  });

  it('23505 재생 직전에 비멤버면 거절한다', async () => {
    const service = serviceWithDb({
      select: outerSelectQueue([
        [{ id: member }],
        [], // early miss
        [], // after 23505: no longer a member
      ]),
      transaction: async () => {
        throw uniqueError();
      },
    });
    await expect(
      service.recordTransaction(user, {
        householdId: home,
        accountId: accountA,
        kind: 'expense',
        amount: '35000',
        occurredAt: '2026-11-05T01:00:00.000Z',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('CAS update가 0행이면 충돌 오류', async () => {
    const now = new Date('2026-11-05T01:00:00.000Z');
    const inserted = {
      id: id(8),
      householdId: home,
      accountId: accountA,
      personId: member,
      categoryId: null,
      kind: 'expense' as const,
      amount: '1000',
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
    const service = serviceWithDb({
      select: outerSelectQueue([[{ id: member }], []]),
      transaction: async (work: (t: ReturnType<typeof makeTx>) => Promise<unknown>) => {
        const tx = makeTx({
          executeImpl: () => [accountRaw()],
          selectResults: [[{ id: member }], []],
          insertRows: [[inserted]],
          updateReturning: [[]], // 0 rows
        });
        return work(tx);
      },
    });
    await expect(
      service.recordTransaction(user, {
        householdId: home,
        accountId: accountA,
        kind: 'expense',
        amount: '1000',
        occurredAt: '2026-11-05T01:00:00.000Z',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
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

    const service = serviceWithDb({
      select: outerSelectQueue([[{ id: member }], []]),
      transaction: async (work: (t: ReturnType<typeof makeTx>) => Promise<unknown>) => {
        const tx = makeTx({
          executeImpl: (sqlText) => {
            if (/from goals/i.test(sqlText)) {
              return [{ id: goal, saved_amount: '10000', status: 'open' }];
            }
            const accountId = ordered[lockCount] ?? accountA;
            lockCount += 1;
            return [byId[accountId]!];
          },
          selectResults: [
            [{ id: member }],
            [], // outbound existing miss inside tx
          ],
          insertRows: [[outbound], [inbound]],
          updateReturning: [[{ id: accountA }], [{ id: accountB }]],
        });
        return work(tx);
      },
    });

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
      executeImpl: () => [{ total: '5000' }],
      selectResults: [
        [{ id: member }],
        [{ kind: 'checking', balance: '100000', status: 'open' }],
        [recent],
        [],
      ],
    });
    const service = serviceWithDb({
      transaction: async (
        work: (t: typeof tx) => Promise<unknown>,
        _opts?: unknown,
      ) => work(tx),
    });
    const result = await service.canSpend(user, { householdId: home });
    expect(result.decision).toBe('ok');
    expect(result.availableKrw).toBe('100000');
    expect(result.recentSpendKrw).toBe('5000');
    expect(result.budgetRemainingKrw).toBeNull();
    expect(result.recentTransactions).toHaveLength(1);
  });

  it('recentSpend는 limit(20)과 분리된 SQL SUM을 쓴다', async () => {
    const list = Array.from({ length: 20 }, (_, i) => ({
      id: id(100 + i),
      householdId: home,
      accountId: accountA,
      personId: member,
      categoryId: null,
      kind: 'expense' as const,
      amount: '1000',
      currency: 'KRW',
      memo: null,
      counterpartyAccountId: null,
      transferGroupId: null,
      goalId: null,
      occurredAt: new Date('2026-11-04T10:00:00.000Z'),
      createdAt: new Date('2026-11-04T10:00:00.000Z'),
      createdByUserId: user,
      idempotencyKey: id(200 + i),
    }));

    let sawSum = false;
    const tx = makeTx({
      executeImpl: (sqlText) => {
        if (/sum\(amount\)/i.test(sqlText)) {
          sawSum = true;
          // 25건 × 1000원 — 목록 20건보다 큼
          return [{ total: '25000' }];
        }
        return [];
      },
      selectResults: [
        [{ id: member }],
        [{ kind: 'checking', balance: '100000', status: 'open' }],
        list,
        [],
      ],
    });
    const service = serviceWithDb({
      transaction: async (
        work: (t: typeof tx) => Promise<unknown>,
        _opts?: unknown,
      ) => work(tx),
    });
    const result = await service.canSpend(user, { householdId: home });
    expect(sawSum).toBe(true);
    expect(result.recentSpendKrw).toBe('25000');
    expect(result.recentTransactions).toHaveLength(20);
  });

  it('예산 잔여는 규칙(카테고리·person)별로 계산한 뒤 최솟값을 쓴다', async () => {
    const monthTxns = [
      {
        kind: 'expense',
        amount: '3000',
        goalId: null,
        categoryId: foodCat,
        personId: member,
      },
      {
        kind: 'expense',
        amount: '7000',
        goalId: null,
        categoryId: foodCat,
        personId: personB,
      },
    ];
    const rules = [
      {
        id: id(40),
        householdId: home,
        personId: member,
        categoryId: foodCat,
        period: 'monthly' as const,
        amountLimit: '10000',
        effectiveMonth: '2026-11-01',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: id(41),
        householdId: home,
        personId: null,
        categoryId: foodCat,
        period: 'monthly' as const,
        amountLimit: '10000',
        effectiveMonth: '2026-11-01',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const tx = makeTx({
      executeImpl: () => [{ total: '0' }],
      selectResults: [
        [{ id: member }],
        [{ kind: 'checking', balance: '100000', status: 'open' }],
        [], // recent list
        rules,
        monthTxns,
      ],
    });
    const service = serviceWithDb({
      transaction: async (
        work: (t: typeof tx) => Promise<unknown>,
        _opts?: unknown,
      ) => work(tx),
    });
    const result = await service.canSpend(user, { householdId: home });
    // personA food: 10000-3000=7000, all-food: 10000-10000=0 → tightest 0
    expect(result.budgetRemainingKrw).toBe('0');
    expect(result.decision).toBe('no');
  });
});
