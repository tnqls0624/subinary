/**
 * SnapshotBalances — 열린 계좌 잔액을 배치로 저장한다.
 * 원장·잔액을 바꾸지 않고 관측만 남긴다.
 * 같은 (account_id, batch_id) 재시도는 ON CONFLICT DO NOTHING으로 멱등.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { schema, type Db } from '@family/database';
import { createLogger } from '@family/shared';

import { DB } from '../database/database.module';

export interface SnapshotBalancesResult {
  readonly batchId: string;
  readonly capturedAt: string;
  readonly accountCount: number;
  readonly insertedCount: number;
}

@Injectable()
export class SnapshotBalancesService {
  private readonly logger = createLogger('worker:snapshot-balances', {
    pretty: process.env.NODE_ENV !== 'production',
  });

  constructor(@Inject(DB) private readonly db: Db) {}

  async run(batchId: string = randomUUID()): Promise<SnapshotBalancesResult> {
    const capturedAt = new Date();
    const accounts = await this.db
      .select({
        id: schema.accounts.id,
        householdId: schema.accounts.householdId,
        balance: schema.accounts.balance,
        currency: schema.accounts.currency,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.status, 'open'));

    if (accounts.length === 0) {
      this.logger.info({ batchId }, 'snapshot balances: no open accounts');
      return {
        batchId,
        capturedAt: capturedAt.toISOString(),
        accountCount: 0,
        insertedCount: 0,
      };
    }

    const inserted = await this.db
      .insert(schema.accountBalanceSnapshots)
      .values(
        accounts.map((account) => ({
          accountId: account.id,
          householdId: account.householdId,
          balance: String(account.balance),
          currency: account.currency,
          capturedAt,
          source: 'scheduled' as const,
          batchId,
        })),
      )
      .onConflictDoNothing({
        target: [
          schema.accountBalanceSnapshots.accountId,
          schema.accountBalanceSnapshots.batchId,
        ],
      })
      .returning({ id: schema.accountBalanceSnapshots.id });

    this.logger.info(
      {
        batchId,
        accountCount: accounts.length,
        insertedCount: inserted.length,
      },
      'snapshot balances stored',
    );

    return {
      batchId,
      capturedAt: capturedAt.toISOString(),
      accountCount: accounts.length,
      insertedCount: inserted.length,
    };
  }
}
