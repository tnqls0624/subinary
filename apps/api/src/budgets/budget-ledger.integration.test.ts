/**
 * C-4 예산 월 원장 실제 Postgres 회귀 테스트.
 *
 * 격리 DB를 새로 준비한 경우에만 실행한다. 운영 DB에서는 절대 실행하지
 * 않는다. 이 테스트는 순수 헬퍼 테스트가 증명하지 못하는 다음 계약을 실제
 * 트랜잭션과 유니크 제약 위에서 확인한다.
 *
 * 1. 8월 계획을 바꿔도 7월 목록의 계획 금액은 바뀌지 않는다.
 * 2. 같은 멱등 키 재시도는 첫 ID 집합을 돌려주고, 다른 키로 같은 target을
 *    다시 복사하면 409이며 일부 행을 남기지 않는다.
 *
 * 실행 예:
 * `BUDGET_LEDGER_TEST_DATABASE_URL=postgres://... pnpm --filter @family/api test -- budget-ledger.integration.test.ts`
 */
import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { schema, type Db } from '@family/database';

import { BudgetService } from './budget.service';
import {
  addBudgetMonths,
  currentBudgetMonth,
  toEffectiveMonth,
} from './budget-month';

const DATABASE_URL = process.env.BUDGET_LEDGER_TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)('예산 월 원장 — 실제 Postgres', () => {
  const userId = randomUUID();
  const householdId = randomUUID();
  const memberId = randomUUID();
  const copyHouseholdId = randomUUID();
  const copyMemberId = randomUUID();
  const julyBudgetId = randomUUID();
  const augustBudgetId = randomUUID();
  const copyBudgetId = randomUUID();
  const copySourceMonth = currentBudgetMonth();
  const copyTargetMonth = addBudgetMonths(copySourceMonth, 1);
  let sqlClient: postgres.Sql;
  let db: Db;
  let service: BudgetService;

  beforeAll(async () => {
    sqlClient = postgres(DATABASE_URL as string, { max: 2 });
    db = drizzle(sqlClient, { schema });
    service = new BudgetService(db);

    await db.insert(schema.users).values({
      id: userId,
      email: `budget-ledger-${userId}@test.invalid`,
      passwordHash: 'not-a-real-password-hash',
      name: '예산 원장 테스트',
    });
    await db.insert(schema.households).values({
      id: householdId,
      name: '예산 원장 가구',
      createdBy: userId,
    });
    await db.insert(schema.households).values({
      id: copyHouseholdId,
      name: '예산 복사 가구',
      createdBy: userId,
    });
    await db.insert(schema.householdMembers).values([
      {
        id: memberId,
        householdId,
        userId,
        role: 'owner',
        status: 'active',
      },
      {
        id: copyMemberId,
        householdId: copyHouseholdId,
        userId,
        role: 'owner',
        status: 'active',
      },
    ]);
    await db.insert(schema.budgets).values([
      {
        id: julyBudgetId,
        householdId,
        scopeType: 'household',
        amount: 100_000,
        effectiveMonth: '2026-07-01',
        createdBy: userId,
      },
      {
        id: augustBudgetId,
        householdId,
        scopeType: 'household',
        amount: 200_000,
        effectiveMonth: '2026-08-01',
        createdBy: userId,
      },
    ]);
    await db.insert(schema.budgets).values({
      id: copyBudgetId,
      householdId: copyHouseholdId,
      scopeType: 'household',
      amount: 350_000,
      effectiveMonth: toEffectiveMonth(copySourceMonth),
      createdBy: userId,
    });
  }, 30_000);

  afterAll(async () => {
    if (!sqlClient) return;
    await db
      .delete(schema.budgetCopyOperations)
      .where(
        inArray(schema.budgetCopyOperations.householdId, [
          householdId,
          copyHouseholdId,
        ]),
      );
    await db
      .delete(schema.budgets)
      .where(
        inArray(schema.budgets.householdId, [householdId, copyHouseholdId]),
      );
    await db
      .delete(schema.householdMembers)
      .where(
        inArray(schema.householdMembers.householdId, [
          householdId,
          copyHouseholdId,
        ]),
      );
    await db
      .delete(schema.households)
      .where(inArray(schema.households.id, [householdId, copyHouseholdId]));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await sqlClient.end({ timeout: 5 });
  });

  it('8월 계획 금액을 변경해도 7월 응답은 그대로다', async () => {
    const before = await service.list(userId, {
      householdId,
      month: '2026-07',
    });

    await db
      .update(schema.budgets)
      .set({ amount: 350_000 })
      .where(eq(schema.budgets.id, augustBudgetId));

    const [july, august] = await Promise.all([
      service.list(userId, { householdId, month: '2026-07' }),
      service.list(userId, { householdId, month: '2026-08' }),
    ]);
    expect(before.items).toHaveLength(1);
    expect(before.items[0]?.amount).toBe(100_000);
    expect(july.items[0]?.id).toBe(julyBudgetId);
    expect(july.items[0]?.amount).toBe(100_000);
    expect(august.items[0]?.id).toBe(augustBudgetId);
    expect(august.items[0]?.amount).toBe(350_000);
  });

  it('복사 재시도는 멱등하고 실제 충돌은 409와 원자성을 지킨다', async () => {
    const idempotencyKey = randomUUID();
    const first = await service.copy(userId, {
      householdId: copyHouseholdId,
      sourceMonth: copySourceMonth,
      targetMonth: copyTargetMonth,
      idempotencyKey,
    });
    const replay = await service.copy(userId, {
      householdId: copyHouseholdId,
      sourceMonth: copySourceMonth,
      targetMonth: copyTargetMonth,
      idempotencyKey,
    });

    expect(first.copiedCount).toBe(1);
    expect(replay).toEqual(first);

    const conflictingCopy = service.copy(userId, {
      householdId: copyHouseholdId,
      sourceMonth: copySourceMonth,
      targetMonth: copyTargetMonth,
      idempotencyKey: randomUUID(),
    });
    await expect(conflictingCopy).rejects.toBeInstanceOf(ConflictException);

    const targetRows = await db
      .select({ id: schema.budgets.id })
      .from(schema.budgets)
      .where(
        and(
          eq(schema.budgets.householdId, copyHouseholdId),
          eq(schema.budgets.effectiveMonth, toEffectiveMonth(copyTargetMonth)),
        ),
      );
    expect(targetRows.map((row) => row.id)).toEqual(first.copiedBudgetIds);

    const operations = await db
      .select({ id: schema.budgetCopyOperations.id })
      .from(schema.budgetCopyOperations)
      .where(eq(schema.budgetCopyOperations.householdId, copyHouseholdId));
    expect(operations).toHaveLength(1);
  });
});
