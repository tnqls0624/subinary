/**
 * 가족 원장 MVP 1차 액션.
 * RecordTransaction / TransferBetweenAccounts / 지금 써도 되나 조회.
 * SnapshotBalances는 worker BullMQ가 소유한다.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  recordTransactionRequestSchema,
  transferBetweenAccountsRequestSchema,
  canSpendQuerySchema,
  type AccountTransactionSummary,
  type CanSpendResponse,
  type RecordTransactionResponse,
  type TransferBetweenAccountsResponse,
} from '@family/contracts';
import { isUniqueViolation, schema, type Db } from '@family/database';
import {
  applyGoalContribution,
  applyRecordTransactionBalance,
  applyTransferBalances,
  bigintToKrwString,
  judgeCanSpend,
  remainingForBudgetRule,
  sumSpendableBalances,
  tightestBudgetRemaining,
} from '@family/shared';

import { DB } from '../database/database.constants';

type Executor = Pick<Db, 'select' | 'insert' | 'update' | 'execute'>;

const RECENT_SPEND_DAYS = 7;

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toSummary(row: typeof schema.accountTransactions.$inferSelect): AccountTransactionSummary {
  return {
    id: row.id,
    householdId: row.householdId,
    accountId: row.accountId,
    personId: row.personId,
    categoryId: row.categoryId,
    kind: row.kind,
    amount: String(row.amount),
    currency: 'KRW',
    memo: row.memo,
    counterpartyAccountId: row.counterpartyAccountId,
    transferGroupId: row.transferGroupId,
    goalId: row.goalId,
    occurredAt: iso(row.occurredAt),
    createdAt: iso(row.createdAt),
  };
}

@Injectable()
export class LedgerService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 쓰기 트랜잭션. HTTP 예외는 그대로, 23505는 호출부가 replay하도록 전파한다.
   * (budget.copy · card-sms ingest와 같은 멱등 경합 패턴)
   */
  private async withTx<T>(run: (tx: Executor) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => run(tx), {
        isolationLevel: 'read committed',
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (isUniqueViolation(error)) throw error;
      throw new InternalServerErrorException(
        '원장 요청을 처리하지 못했어요. 잠시 뒤 다시 확인해 주세요.',
      );
    }
  }

  private async requireMember(
    tx: Executor,
    householdId: string,
    userId: string,
  ): Promise<{ id: string }> {
    const [row] = await tx
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.householdMembers.userId))
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
          isNull(schema.users.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new ForbiddenException('가족 구성원만 쓸 수 있어요.');
    return row;
  }

  private async lockAccount(
    tx: Executor,
    accountId: string,
    householdId: string,
  ): Promise<typeof schema.accounts.$inferSelect> {
    const rows = (await tx.execute(sql`
      select id, household_id, person_id, institution_id, name, kind, currency,
             balance, status, version, created_at, updated_at, closed_at
      from accounts
      where id = ${accountId} and household_id = ${householdId}
      for update
    `)) as unknown as Array<Record<string, unknown>>;
    const raw = rows[0];
    if (!raw) throw new NotFoundException('계좌를 찾을 수 없어요.');
    return {
      id: String(raw.id),
      householdId: String(raw.household_id),
      personId: String(raw.person_id),
      institutionId: raw.institution_id == null ? null : String(raw.institution_id),
      name: String(raw.name),
      kind: raw.kind as typeof schema.accounts.$inferSelect.kind,
      currency: String(raw.currency),
      balance: String(raw.balance),
      status: raw.status as 'open' | 'closed',
      version: Number(raw.version),
      createdAt: new Date(String(raw.created_at)),
      updatedAt: new Date(String(raw.updated_at)),
      closedAt: raw.closed_at == null ? null : new Date(String(raw.closed_at)),
    };
  }

  private async casUpdateAccount(
    tx: Executor,
    account: typeof schema.accounts.$inferSelect,
    nextBalance: bigint,
    now: Date,
  ): Promise<void> {
    const updated = await tx
      .update(schema.accounts)
      .set({
        balance: bigintToKrwString(nextBalance),
        version: account.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.accounts.id, account.id),
          eq(schema.accounts.version, account.version),
        ),
      )
      .returning({ id: schema.accounts.id });
    if (!updated[0]) {
      throw new ConflictException('다른 요청이 잔액을 먼저 바꿨어요. 다시 시도해 주세요.');
    }
  }

  private async loadRecordReplay(
    householdId: string,
    idempotencyKey: string,
  ): Promise<RecordTransactionResponse | null> {
    const [existing] = await this.db
      .select()
      .from(schema.accountTransactions)
      .where(
        and(
          eq(schema.accountTransactions.householdId, householdId),
          eq(schema.accountTransactions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) return null;
    const [account] = await this.db
      .select({ balance: schema.accounts.balance })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, existing.accountId))
      .limit(1);
    return {
      transaction: toSummary(existing),
      accountBalance: String(account?.balance ?? '0'),
      replayed: true,
    };
  }

  private async loadTransferReplay(
    householdId: string,
    idempotencyKey: string,
  ): Promise<TransferBetweenAccountsResponse | null> {
    const [outbound] = await this.db
      .select()
      .from(schema.accountTransactions)
      .where(
        and(
          eq(schema.accountTransactions.householdId, householdId),
          eq(schema.accountTransactions.idempotencyKey, idempotencyKey),
          eq(schema.accountTransactions.kind, 'transfer_out'),
        ),
      )
      .limit(1);
    if (!outbound?.transferGroupId) return null;
    const [inbound] = await this.db
      .select()
      .from(schema.accountTransactions)
      .where(
        and(
          eq(schema.accountTransactions.householdId, householdId),
          eq(schema.accountTransactions.idempotencyKey, `${idempotencyKey}:in`),
          eq(schema.accountTransactions.kind, 'transfer_in'),
        ),
      )
      .limit(1);
    if (!inbound) return null;
    const [fromAcc] = await this.db
      .select({ balance: schema.accounts.balance })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, outbound.accountId))
      .limit(1);
    const [toAcc] = await this.db
      .select({ balance: schema.accounts.balance })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, inbound.accountId))
      .limit(1);
    let goalSaved: string | null = null;
    if (outbound.goalId) {
      const [goal] = await this.db
        .select({ savedAmount: schema.goals.savedAmount })
        .from(schema.goals)
        .where(eq(schema.goals.id, outbound.goalId))
        .limit(1);
      goalSaved = goal ? String(goal.savedAmount) : null;
    }
    return {
      transferGroupId: outbound.transferGroupId,
      outbound: toSummary(outbound),
      inbound: toSummary(inbound),
      fromAccountBalance: String(fromAcc?.balance ?? '0'),
      toAccountBalance: String(toAcc?.balance ?? '0'),
      goalSavedAmount: goalSaved,
      replayed: true,
    };
  }

  /** RecordTransaction — 단일 계좌 지출·수입. */
  async recordTransaction(
    userId: string,
    input: unknown,
  ): Promise<RecordTransactionResponse> {
    const parsed = recordTransactionRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('요청 형식을 확인해 주세요.');
    const body = parsed.data;
    const txnId = body.id ?? randomUUID();

    // 멱등 재생·23505 재생 모두 구성원 확인 뒤에만 요약을 돌려준다(IDOR 방지).
    await this.requireMember(this.db, body.householdId, userId);
    const early = await this.loadRecordReplay(body.householdId, body.idempotencyKey);
    if (early) return early;

    try {
      return await this.withTx(async (tx) => {
        await this.requireMember(tx, body.householdId, userId);

        const [existing] = await tx
          .select()
          .from(schema.accountTransactions)
          .where(
            and(
              eq(schema.accountTransactions.householdId, body.householdId),
              eq(schema.accountTransactions.idempotencyKey, body.idempotencyKey),
            ),
          )
          .limit(1);
        if (existing) {
          const [account] = await tx
            .select({ balance: schema.accounts.balance })
            .from(schema.accounts)
            .where(eq(schema.accounts.id, existing.accountId))
            .limit(1);
          return {
            transaction: toSummary(existing),
            accountBalance: String(account?.balance ?? '0'),
            replayed: true,
          };
        }

        const account = await this.lockAccount(tx, body.accountId, body.householdId);
        const next = applyRecordTransactionBalance({
          kind: body.kind,
          accountKind: account.kind,
          currentBalance: String(account.balance),
          amount: body.amount,
          status: account.status,
        });
        if (!next.ok) {
          if (next.reason === 'closed_account') {
            throw new UnprocessableEntityException('닫힌 계좌에는 거래를 넣을 수 없어요.');
          }
          if (next.reason === 'insufficient_balance' || next.reason === 'loan_overpay') {
            throw new UnprocessableEntityException('잔액이 부족해요.');
          }
          throw new BadRequestException('요청 형식을 확인해 주세요.');
        }

        if (body.categoryId) {
          const [cat] = await tx
            .select({ id: schema.expenseCategories.id })
            .from(schema.expenseCategories)
            .where(
              and(
                eq(schema.expenseCategories.id, body.categoryId),
                sql`(${schema.expenseCategories.householdId} is null or ${schema.expenseCategories.householdId} = ${body.householdId})`,
              ),
            )
            .limit(1);
          if (!cat) throw new BadRequestException('선택한 카테고리를 쓸 수 없어요.');
        }

        const now = new Date();
        const [inserted] = await tx
          .insert(schema.accountTransactions)
          .values({
            id: txnId,
            householdId: body.householdId,
            accountId: account.id,
            personId: account.personId,
            categoryId: body.categoryId ?? null,
            kind: body.kind,
            amount: body.amount,
            currency: 'KRW',
            memo: body.memo ?? null,
            counterpartyAccountId: null,
            transferGroupId: null,
            goalId: null,
            occurredAt: new Date(body.occurredAt),
            createdAt: now,
            createdByUserId: userId,
            idempotencyKey: body.idempotencyKey,
          })
          .returning();

        if (!inserted) throw new ConflictException('같은 요청이 이미 처리 중이에요.');

        await this.casUpdateAccount(tx, account, next.nextBalance, now);

        return {
          transaction: toSummary(inserted),
          accountBalance: bigintToKrwString(next.nextBalance),
          replayed: false,
        };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.requireMember(this.db, body.householdId, userId);
      const replay = await this.loadRecordReplay(body.householdId, body.idempotencyKey);
      if (replay) return replay;
      throw new ConflictException('같은 요청이 이미 처리 중이에요.');
    }
  }

  /**
   * TransferBetweenAccounts — 두 계좌 이체.
   * goalId가 있으면 to 쪽 적립으로 Goal.savedAmount를 올린다.
   */
  async transferBetweenAccounts(
    userId: string,
    input: unknown,
  ): Promise<TransferBetweenAccountsResponse> {
    const parsed = transferBetweenAccountsRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('요청 형식을 확인해 주세요.');
    const body = parsed.data;
    const transferGroupId = body.transferGroupId ?? randomUUID();
    const outId = randomUUID();
    const inId = randomUUID();

    // 멱등 재생·23505 재생 모두 구성원 확인 뒤에만 요약을 돌려준다(IDOR 방지).
    await this.requireMember(this.db, body.householdId, userId);
    const early = await this.loadTransferReplay(body.householdId, body.idempotencyKey);
    if (early) return early;

    try {
      return await this.withTx(async (tx) => {
        await this.requireMember(tx, body.householdId, userId);

        const replayInside = await this.loadTransferReplayInTx(
          tx,
          body.householdId,
          body.idempotencyKey,
        );
        if (replayInside) return replayInside;

        const ordered = [body.fromAccountId, body.toAccountId].sort();
        const first = await this.lockAccount(tx, ordered[0]!, body.householdId);
        const second = await this.lockAccount(tx, ordered[1]!, body.householdId);
        const fromAccount = first.id === body.fromAccountId ? first : second;
        const toAccount = first.id === body.toAccountId ? first : second;

        const next = applyTransferBalances({
          fromKind: fromAccount.kind,
          toKind: toAccount.kind,
          fromBalance: String(fromAccount.balance),
          toBalance: String(toAccount.balance),
          amount: body.amount,
          fromStatus: fromAccount.status,
          toStatus: toAccount.status,
        });
        if (!next.ok) {
          if (next.reason === 'closed_account') {
            throw new UnprocessableEntityException('닫힌 계좌로는 이체할 수 없어요.');
          }
          if (next.reason === 'loan_transfer_unsupported') {
            throw new UnprocessableEntityException('대출 계좌로는 이체할 수 없어요.');
          }
          if (next.reason === 'insufficient_balance') {
            throw new UnprocessableEntityException('잔액이 부족해요.');
          }
          throw new BadRequestException('요청 형식을 확인해 주세요.');
        }

        let goalSavedAmount: string | null = null;
        const goalId = body.goalId ?? null;
        if (goalId) {
          const goalRows = (await tx.execute(sql`
            select id, saved_amount, status
            from goals
            where id = ${goalId} and household_id = ${body.householdId}
            for update
          `)) as unknown as Array<Record<string, unknown>>;
          const goalRaw = goalRows[0];
          if (!goalRaw) throw new NotFoundException('목표를 찾을 수 없어요.');
          const goalStatus = String(goalRaw.status) as 'open' | 'closed';
          const contributed = applyGoalContribution({
            savedAmount: String(goalRaw.saved_amount),
            amount: body.amount,
            status: goalStatus,
          });
          if (!contributed.ok) {
            throw new UnprocessableEntityException('닫힌 목표에는 적립할 수 없어요.');
          }
          goalSavedAmount = bigintToKrwString(contributed.nextSaved);
          await tx
            .update(schema.goals)
            .set({
              savedAmount: goalSavedAmount,
              updatedAt: new Date(),
            })
            .where(eq(schema.goals.id, goalId));
        }

        const now = new Date();
        const occurredAt = new Date(body.occurredAt);
        const [outbound] = await tx
          .insert(schema.accountTransactions)
          .values({
            id: outId,
            householdId: body.householdId,
            accountId: fromAccount.id,
            personId: fromAccount.personId,
            categoryId: null,
            kind: 'transfer_out',
            amount: body.amount,
            currency: 'KRW',
            memo: body.memo ?? null,
            counterpartyAccountId: toAccount.id,
            transferGroupId,
            goalId,
            occurredAt,
            createdAt: now,
            createdByUserId: userId,
            idempotencyKey: body.idempotencyKey,
          })
          .returning();

        const [inbound] = await tx
          .insert(schema.accountTransactions)
          .values({
            id: inId,
            householdId: body.householdId,
            accountId: toAccount.id,
            personId: toAccount.personId,
            categoryId: null,
            kind: 'transfer_in',
            amount: body.amount,
            currency: 'KRW',
            memo: body.memo ?? null,
            counterpartyAccountId: fromAccount.id,
            transferGroupId,
            goalId,
            occurredAt,
            createdAt: now,
            createdByUserId: userId,
            idempotencyKey: `${body.idempotencyKey}:in`,
          })
          .returning();

        if (!outbound || !inbound) {
          throw new ConflictException('같은 요청이 이미 처리 중이에요.');
        }

        await this.casUpdateAccount(tx, fromAccount, next.nextFrom, now);
        await this.casUpdateAccount(tx, toAccount, next.nextTo, now);

        return {
          transferGroupId,
          outbound: toSummary(outbound),
          inbound: toSummary(inbound),
          fromAccountBalance: bigintToKrwString(next.nextFrom),
          toAccountBalance: bigintToKrwString(next.nextTo),
          goalSavedAmount,
          replayed: false,
        };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.requireMember(this.db, body.householdId, userId);
      const replay = await this.loadTransferReplay(body.householdId, body.idempotencyKey);
      if (replay) return replay;
      throw new ConflictException('같은 요청이 이미 처리 중이에요.');
    }
  }

  private async loadTransferReplayInTx(
    tx: Executor,
    householdId: string,
    idempotencyKey: string,
  ): Promise<TransferBetweenAccountsResponse | null> {
    const [outbound] = await tx
      .select()
      .from(schema.accountTransactions)
      .where(
        and(
          eq(schema.accountTransactions.householdId, householdId),
          eq(schema.accountTransactions.idempotencyKey, idempotencyKey),
          eq(schema.accountTransactions.kind, 'transfer_out'),
        ),
      )
      .limit(1);
    if (!outbound?.transferGroupId) return null;
    const [inbound] = await tx
      .select()
      .from(schema.accountTransactions)
      .where(
        and(
          eq(schema.accountTransactions.householdId, householdId),
          eq(schema.accountTransactions.idempotencyKey, `${idempotencyKey}:in`),
          eq(schema.accountTransactions.kind, 'transfer_in'),
        ),
      )
      .limit(1);
    if (!inbound) return null;
    const [fromAcc] = await tx
      .select({ balance: schema.accounts.balance })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, outbound.accountId))
      .limit(1);
    const [toAcc] = await tx
      .select({ balance: schema.accounts.balance })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, inbound.accountId))
      .limit(1);
    let goalSaved: string | null = null;
    if (outbound.goalId) {
      const [goal] = await tx
        .select({ savedAmount: schema.goals.savedAmount })
        .from(schema.goals)
        .where(eq(schema.goals.id, outbound.goalId))
        .limit(1);
      goalSaved = goal ? String(goal.savedAmount) : null;
    }
    return {
      transferGroupId: outbound.transferGroupId,
      outbound: toSummary(outbound),
      inbound: toSummary(inbound),
      fromAccountBalance: String(fromAcc?.balance ?? '0'),
      toAccountBalance: String(toAcc?.balance ?? '0'),
      goalSavedAmount: goalSaved,
      replayed: true,
    };
  }

  /** '지금 써도 되나' — 잔액 + 최근 거래 + 예산 규칙을 통합 판단. */
  async canSpend(userId: string, query: unknown): Promise<CanSpendResponse> {
    const parsed = canSpendQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('요청 형식을 확인해 주세요.');
    const { householdId } = parsed.data;

    try {
      return await this.db.transaction(
        async (tx) => {
          await this.requireMember(tx, householdId, userId);

          const accounts = await tx
            .select({
              kind: schema.accounts.kind,
              balance: schema.accounts.balance,
              status: schema.accounts.status,
            })
            .from(schema.accounts)
            .where(eq(schema.accounts.householdId, householdId));

          const availableKrw = sumSpendableBalances(
            accounts.map((a) => ({
              kind: a.kind,
              balance: String(a.balance),
              status: a.status,
            })),
          );

          const since = new Date(Date.now() - RECENT_SPEND_DAYS * 24 * 60 * 60 * 1000);

          // 7일 전체 지출은 limit(20) 목록과 분리해 SQL SUM으로 집계한다.
          const [spendRow] = (await tx.execute(sql`
            select coalesce(sum(amount), 0) as total
            from account_transactions
            where household_id = ${householdId}
              and occurred_at >= ${since.toISOString()}::timestamptz
              and (
                kind = 'expense'
                or (kind = 'transfer_out' and goal_id is null)
              )
          `)) as unknown as Array<{ total: string | number }>;
          const recentSpend = BigInt(String(spendRow?.total ?? '0'));

          const recent = await tx
            .select()
            .from(schema.accountTransactions)
            .where(
              and(
                eq(schema.accountTransactions.householdId, householdId),
                gte(schema.accountTransactions.occurredAt, since),
              ),
            )
            .orderBy(
              desc(schema.accountTransactions.occurredAt),
              asc(schema.accountTransactions.id),
            )
            .limit(20);

          const monthStart = seoulMonthStart();
          const rules = await tx
            .select()
            .from(schema.budgetRules)
            .where(
              and(
                eq(schema.budgetRules.householdId, householdId),
                eq(schema.budgetRules.effectiveMonth, monthStart),
              ),
            );

          let budgetRemainingKrw: bigint | null = null;
          if (rules.length > 0) {
            const monthTxns = await tx
              .select({
                kind: schema.accountTransactions.kind,
                amount: schema.accountTransactions.amount,
                goalId: schema.accountTransactions.goalId,
                categoryId: schema.accountTransactions.categoryId,
                personId: schema.accountTransactions.personId,
              })
              .from(schema.accountTransactions)
              .where(
                and(
                  eq(schema.accountTransactions.householdId, householdId),
                  gte(
                    schema.accountTransactions.occurredAt,
                    new Date(`${monthStart}T00:00:00+09:00`),
                  ),
                ),
              );

            const spends = monthTxns.map((row) => ({
              amount: BigInt(String(row.amount)),
              categoryId: row.categoryId,
              personId: row.personId,
              kind: row.kind,
              goalId: row.goalId,
            }));

            const perRule = rules.map((rule) =>
              remainingForBudgetRule({
                amountLimit: BigInt(String(rule.amountLimit)),
                categoryId: rule.categoryId,
                personId: rule.personId,
                spends,
              }),
            );
            budgetRemainingKrw = tightestBudgetRemaining(perRule);
          }

          const judgment = judgeCanSpend({
            availableKrw,
            recentSpendKrw: recentSpend,
            budgetRemainingKrw,
          });

          return {
            decision: judgment.decision,
            availableKrw: bigintToKrwString(availableKrw),
            recentSpendKrw: bigintToKrwString(recentSpend),
            budgetRemainingKrw:
              budgetRemainingKrw === null
                ? null
                : bigintToKrwString(budgetRemainingKrw < 0n ? 0n : budgetRemainingKrw),
            reasons: judgment.reasons,
            recentTransactions: recent.map((row) => ({
              id: row.id,
              kind: row.kind,
              amount: String(row.amount),
              accountId: row.accountId,
              memo: row.memo,
              occurredAt: iso(row.occurredAt),
            })),
            asOf: new Date().toISOString(),
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      throw new InternalServerErrorException(
        '지금 써도 되나 조회에 실패했어요. 잠시 뒤 다시 확인해 주세요.',
      );
    }
  }
}

function seoulMonthStart(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  return `${year}-${month}-01`;
}
