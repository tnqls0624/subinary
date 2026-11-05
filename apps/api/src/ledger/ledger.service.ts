/**
 * 가족 원장 MVP 1차 액션.
 * RecordTransaction / TransferBetweenAccounts / 지금 써도 되나 조회.
 * SnapshotBalances는 worker BullMQ가 소유한다.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { schema, type Db } from '@family/database';
import {
  applyGoalContribution,
  applyRecordTransactionBalance,
  applyTransferBalances,
  bigintToKrwString,
  countsTowardRecentSpend,
  judgeCanSpend,
  sumSpendableBalances,
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

  private async withTx<T>(run: (tx: Executor) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => run(tx), {
        isolationLevel: 'read committed',
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException ||
        error instanceof UnprocessableEntityException
      ) {
        throw error;
      }
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

  /** RecordTransaction — 단일 계좌 지출·수입. */
  async recordTransaction(
    userId: string,
    input: unknown,
  ): Promise<RecordTransactionResponse> {
    const parsed = recordTransactionRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('요청 형식을 확인해 주세요.');
    const body = parsed.data;
    const txnId = body.id ?? randomUUID();

    return this.withTx(async (tx) => {
      const me = await this.requireMember(tx, body.householdId, userId);

      const existing = await tx
        .select()
        .from(schema.accountTransactions)
        .where(
          and(
            eq(schema.accountTransactions.householdId, body.householdId),
            eq(schema.accountTransactions.idempotencyKey, body.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        const [account] = await tx
          .select({ balance: schema.accounts.balance })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, existing[0].accountId))
          .limit(1);
        return {
          transaction: toSummary(existing[0]),
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

      await tx
        .update(schema.accounts)
        .set({
          balance: bigintToKrwString(next.nextBalance),
          version: account.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.accounts.id, account.id),
            eq(schema.accounts.version, account.version),
          ),
        );

      // Person은 계좌 소유자(account.personId). 행위자는 createdByUserId만 남긴다.
      if (me.id.length === 0) throw new ForbiddenException('가족 구성원만 쓸 수 있어요.');

      return {
        transaction: toSummary(inserted),
        accountBalance: bigintToKrwString(next.nextBalance),
        replayed: false,
      };
    });
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

    return this.withTx(async (tx) => {
      await this.requireMember(tx, body.householdId, userId);

      const [outboundExisting] = await tx
        .select()
        .from(schema.accountTransactions)
        .where(
          and(
            eq(schema.accountTransactions.householdId, body.householdId),
            eq(schema.accountTransactions.idempotencyKey, body.idempotencyKey),
            eq(schema.accountTransactions.kind, 'transfer_out'),
          ),
        )
        .limit(1);

      if (outboundExisting) {
        const [inboundExisting] = await tx
          .select()
          .from(schema.accountTransactions)
          .where(
            and(
              eq(schema.accountTransactions.householdId, body.householdId),
              eq(
                schema.accountTransactions.idempotencyKey,
                `${body.idempotencyKey}:in`,
              ),
              eq(schema.accountTransactions.kind, 'transfer_in'),
            ),
          )
          .limit(1);
        if (!inboundExisting || !outboundExisting.transferGroupId) {
          throw new ConflictException('이전 이체 요청 상태가 완전하지 않아요.');
        }
        const [fromAcc] = await tx
          .select({ balance: schema.accounts.balance })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, outboundExisting.accountId))
          .limit(1);
        const [toAcc] = await tx
          .select({ balance: schema.accounts.balance })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, inboundExisting.accountId))
          .limit(1);
        let goalSaved: string | null = null;
        if (outboundExisting.goalId) {
          const [goal] = await tx
            .select({ savedAmount: schema.goals.savedAmount })
            .from(schema.goals)
            .where(eq(schema.goals.id, outboundExisting.goalId))
            .limit(1);
          goalSaved = goal ? String(goal.savedAmount) : null;
        }
        return {
          transferGroupId: outboundExisting.transferGroupId,
          outbound: toSummary(outboundExisting),
          inbound: toSummary(inboundExisting),
          fromAccountBalance: String(fromAcc?.balance ?? '0'),
          toAccountBalance: String(toAcc?.balance ?? '0'),
          goalSavedAmount: goalSaved,
          replayed: true,
        };
      }

      // 교착 방지: id 오름차순으로 잠근다.
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
      // 멱등 키는 outbound에만 두고, inbound는 파생 키를 쓴다(유일 제약).
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

      await tx
        .update(schema.accounts)
        .set({
          balance: bigintToKrwString(next.nextFrom),
          version: fromAccount.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.accounts.id, fromAccount.id),
            eq(schema.accounts.version, fromAccount.version),
          ),
        );
      await tx
        .update(schema.accounts)
        .set({
          balance: bigintToKrwString(next.nextTo),
          version: toAccount.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.accounts.id, toAccount.id),
            eq(schema.accounts.version, toAccount.version),
          ),
        );

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
          const recent = await tx
            .select()
            .from(schema.accountTransactions)
            .where(
              and(
                eq(schema.accountTransactions.householdId, householdId),
                gte(schema.accountTransactions.occurredAt, since),
              ),
            )
            .orderBy(desc(schema.accountTransactions.occurredAt), asc(schema.accountTransactions.id))
            .limit(20);

          let recentSpend = 0n;
          for (const row of recent) {
            if (
              countsTowardRecentSpend({
                kind: row.kind,
                goalId: row.goalId,
              })
            ) {
              recentSpend += BigInt(String(row.amount));
            }
          }

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
            const totalLimit = rules.reduce(
              (acc, rule) => acc + BigInt(String(rule.amountLimit)),
              0n,
            );
            const monthTxns = await tx
              .select({
                kind: schema.accountTransactions.kind,
                amount: schema.accountTransactions.amount,
                goalId: schema.accountTransactions.goalId,
                categoryId: schema.accountTransactions.categoryId,
              })
              .from(schema.accountTransactions)
              .where(
                and(
                  eq(schema.accountTransactions.householdId, householdId),
                  gte(schema.accountTransactions.occurredAt, new Date(`${monthStart}T00:00:00+09:00`)),
                ),
              );

            let monthSpend = 0n;
            const categoryIds = new Set(
              rules
                .map((r) => r.categoryId)
                .filter((id): id is string => id !== null),
            );
            const hasHouseholdWide = rules.some((r) => r.categoryId === null);
            for (const row of monthTxns) {
              if (!countsTowardRecentSpend({ kind: row.kind, goalId: row.goalId })) continue;
              if (
                hasHouseholdWide ||
                (row.categoryId !== null && categoryIds.has(row.categoryId))
              ) {
                monthSpend += BigInt(String(row.amount));
              }
            }
            budgetRemainingKrw = totalLimit - monthSpend;
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
