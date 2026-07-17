/**
 * Transaction domain service (Phase 4 Build Spec §5.3).
 *
 * Read/write side of the normalized card-transaction model. Authorization and
 * visibility scope are enforced *here* in the service layer against the actor's
 * household membership (`userId` → active `memberId`, PRD §8/§26) — controllers
 * never make trust decisions.
 *
 * Visibility rules (spec §1.4): a listing returns the actor's own transactions
 * ∪ `visibility='household'`; another member's `private` rows are excluded, and
 * another member's `summary_only` rows are included with the merchant/memo
 * masked (`masked: true`). Amounts always count toward summaries.
 *
 * Money invariants (spec §1.2): amounts are KRW integers. For an `approval`
 * row `netAmount = amount - cancelledAmount`; a `cancellation` row keeps
 * `netAmount = 0` and links to its approval via `parentTransactionId`.
 *
 * Logs never carry amounts, merchant names, memos, or other PII.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type {
  HouseholdRole,
  LinkCancellationRequest,
  TransactionListResponse,
  TransactionSummary,
  TransactionSummaryResponse,
  TransactionUpdateRequest,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { assertKrwInteger, DEFAULT_TIMEZONE } from '@family/shared';

import { DB } from '../database/database.constants';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Pagination bounds (default 50, max 100 — mirrors card-sms query). */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Transaction kinds (mirrors DB `txnType`). */
const TXN_TYPES = ['approval', 'cancellation'] as const;
type TxnType = (typeof TXN_TYPES)[number];

/** Transaction statuses (mirrors DB `txnStatus`). */
const TXN_STATUSES = [
  'approved',
  'partially_cancelled',
  'cancelled',
  'pending_review',
  'duplicate_suspected',
] as const;
type TxnStatus = (typeof TXN_STATUSES)[number];

/** Card/transaction visibility (mirrors DB `cardVisibility`). */
type Visibility = 'private' | 'household' | 'summary_only';

/** Roles allowed to mutate any household member's transaction. */
const PRIVILEGED_ROLES: readonly HouseholdRole[] = ['owner', 'admin'];

/* -------------------------------------------------------------------------- */
/* Query shapes                                                               */
/* -------------------------------------------------------------------------- */

/** Raw list query parameters (all strings — parsed/validated in the service). */
export interface TransactionListQuery {
  householdId?: string;
  memberId?: string;
  cardId?: string;
  type?: string;
  status?: string;
  categoryId?: string;
  from?: string;
  to?: string;
  minAmount?: string;
  maxAmount?: string;
  limit?: string;
  cursor?: string;
}

/** Raw summary query parameters. */
export interface TransactionSummaryQuery {
  householdId?: string;
  from?: string;
  to?: string;
}

/** Decoded keyset cursor: order by `(createdAt desc, id desc)`. */
interface Cursor {
  createdAt: Date;
  id: string;
}

/** Actor membership resolved for a household. */
interface ActorMembership {
  memberId: string;
  role: HouseholdRole;
}

@Injectable()
export class TransactionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /* ---------------------------------------------------------------------- */
  /* List / read                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Lists transactions for a household the actor belongs to, applying the
   * visibility scope (§1.4) and the optional filters (PRD §17.4). Newest first,
   * keyset-paginated. Another member's `summary_only` rows are masked.
   */
  async list(
    userId: string,
    query: TransactionListQuery,
  ): Promise<TransactionListResponse> {
    const householdId = this.requireHouseholdId(query.householdId);
    const actor = await this.requireMembership(householdId, userId);

    const take = this.parseLimit(query.limit);
    const keyset = this.decodeCursor(query.cursor);

    const conditions: SQL[] = [
      eq(schema.cardTransactions.householdId, householdId),
      this.visibilityScope(actor.memberId),
    ];

    if (query.memberId) {
      conditions.push(eq(schema.cardTransactions.memberId, query.memberId));
    }
    if (query.cardId) {
      conditions.push(eq(schema.cardTransactions.cardId, query.cardId));
    }
    if (query.type !== undefined) {
      conditions.push(
        eq(schema.cardTransactions.transactionType, this.parseType(query.type)),
      );
    }
    if (query.status !== undefined) {
      conditions.push(
        eq(schema.cardTransactions.status, this.parseStatus(query.status)),
      );
    }
    if (query.categoryId) {
      conditions.push(eq(schema.cardTransactions.categoryId, query.categoryId));
    }
    const from = this.parseDate(query.from, 'from');
    if (from) {
      conditions.push(gte(schema.cardTransactions.approvedAt, from));
    }
    const to = this.parseDate(query.to, 'to');
    if (to) {
      conditions.push(lt(schema.cardTransactions.approvedAt, to));
    }
    const minAmount = this.parseAmount(query.minAmount, 'minAmount');
    if (minAmount !== undefined) {
      conditions.push(gte(schema.cardTransactions.amount, minAmount));
    }
    const maxAmount = this.parseAmount(query.maxAmount, 'maxAmount');
    if (maxAmount !== undefined) {
      conditions.push(lte(schema.cardTransactions.amount, maxAmount));
    }
    if (keyset) {
      const after = or(
        lt(schema.cardTransactions.createdAt, keyset.createdAt),
        and(
          eq(schema.cardTransactions.createdAt, keyset.createdAt),
          lt(schema.cardTransactions.id, keyset.id),
        ),
      );
      if (after) {
        conditions.push(after);
      }
    }

    const rows = await this.db
      .select({
        txn: schema.cardTransactions,
        categorySlug: schema.expenseCategories.slug,
      })
      .from(schema.cardTransactions)
      .leftJoin(
        schema.expenseCategories,
        eq(schema.cardTransactions.categoryId, schema.expenseCategories.id),
      )
      .where(and(...conditions))
      .orderBy(
        desc(schema.cardTransactions.createdAt),
        desc(schema.cardTransactions.id),
      )
      .limit(take + 1);

    let nextCursor: string | null = null;
    let page = rows;
    if (rows.length > take) {
      page = rows.slice(0, take);
      const last = page[page.length - 1];
      if (last) {
        nextCursor = this.encodeCursor(last.txn);
      }
    }

    const items = page.map((r) =>
      buildSummary(r.txn, r.categorySlug, maskedFor(r.txn, actor.memberId)),
    );
    return { items, nextCursor };
  }

  /**
   * Returns a single transaction scoped to the actor's household membership.
   * Another member's `private` row is reported as not-found (no disclosure);
   * another member's `summary_only` row is returned masked.
   */
  async get(userId: string, id: string): Promise<TransactionSummary> {
    const row = await this.loadSummaryRow(id);
    const actor = await this.requireMembership(row.txn.householdId, userId);

    if (
      row.txn.memberId !== actor.memberId &&
      row.txn.visibility === 'private'
    ) {
      throw new NotFoundException('transaction not found');
    }

    return buildSummary(
      row.txn,
      row.categorySlug,
      maskedFor(row.txn, actor.memberId),
    );
  }

  /**
   * Verification-oriented month summary (spec §5.3). Sums `netAmount` over
   * `approval` rows whose `approvedAt` falls in `[from, to)`, honouring the
   * actor's visibility scope. `summary_only` amounts are included (only the
   * merchant is masked, elsewhere); another member's `private` rows are excluded.
   */
  async summary(
    userId: string,
    query: TransactionSummaryQuery,
  ): Promise<TransactionSummaryResponse> {
    const householdId = this.requireHouseholdId(query.householdId);
    const actor = await this.requireMembership(householdId, userId);

    const from = this.parseDate(query.from, 'from');
    const to = this.parseDate(query.to, 'to');
    if (!from || !to) {
      throw new BadRequestException('from and to are required (ISO datetime)');
    }

    const conditions: SQL[] = [
      eq(schema.cardTransactions.householdId, householdId),
      eq(schema.cardTransactions.transactionType, 'approval'),
      // '중복이라 제외' 확정 거래는 요약 합계에서도 뺀다(analytics/budgets와 동일).
      isNull(schema.cardTransactions.excludedAt),
      this.visibilityScope(actor.memberId),
      gte(schema.cardTransactions.approvedAt, from),
      lt(schema.cardTransactions.approvedAt, to),
    ];

    const [agg] = await this.db
      .select({
        totalNet: sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`,
        totalApproved: sql<string>`coalesce(sum(${schema.cardTransactions.amount}), 0)`,
        totalCancelled: sql<string>`coalesce(sum(${schema.cardTransactions.cancelledAmount}), 0)`,
        count: sql<string>`count(*)`,
      })
      .from(schema.cardTransactions)
      .where(and(...conditions));

    const totalNet = toInt(agg?.totalNet);
    const totalApproved = toInt(agg?.totalApproved);
    const totalCancelled = toInt(agg?.totalCancelled);
    const count = toInt(agg?.count);
    assertKrwInteger(totalNet);
    assertKrwInteger(totalApproved);
    assertKrwInteger(totalCancelled);

    const memberRows = await this.db
      .selectDistinct({ memberId: schema.cardTransactions.memberId })
      .from(schema.cardTransactions)
      .where(and(...conditions));

    return {
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: DEFAULT_TIMEZONE,
      },
      totalNet,
      totalApproved,
      totalCancelled,
      includedMembers: memberRows.map((r) => r.memberId),
      count,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Updates a transaction (owner/admin, or the member who owns the row).
   * Changing `categoryId` with `applyRule` upserts a `merchant_category_rules`
   * entry `(householdId, merchantNormalized) → categoryId` so *future*
   * promotions/reclassifications pick it up (never retroactive). Changing
   * `cardId` re-inherits the card visibility unless `visibility` is set too.
   */
  async update(
    userId: string,
    id: string,
    input: TransactionUpdateRequest,
  ): Promise<TransactionSummary> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    const updates: Partial<schema.NewCardTransaction> = {
      updatedAt: new Date(),
    };

    if (input.categoryId !== undefined) {
      await this.assertCategoryUsable(input.categoryId, current.householdId);
      updates.categoryId = input.categoryId;
    }
    if (input.merchantNormalized !== undefined) {
      updates.merchantNormalized = input.merchantNormalized;
    }
    if (input.memberId !== undefined) {
      await this.assertMemberInHousehold(input.memberId, current.householdId);
      updates.memberId = input.memberId;
    }
    if (input.cardId !== undefined) {
      if (input.cardId === null) {
        updates.cardId = null;
        if (input.visibility === undefined) {
          updates.visibility = 'household';
        }
      } else {
        const card = await this.loadCard(input.cardId, current.householdId);
        updates.cardId = card.id;
        if (input.visibility === undefined) {
          updates.visibility = card.visibility as Visibility;
        }
      }
    }
    if (input.visibility !== undefined) {
      updates.visibility = input.visibility;
    }
    if (input.memo !== undefined) {
      updates.memo = input.memo;
    }

    // The category change and the (optional) rule upsert are atomic.
    const effectiveMerchant =
      input.merchantNormalized ?? current.merchantNormalized;

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.cardTransactions)
        .set(updates)
        .where(eq(schema.cardTransactions.id, id));

      if (input.applyRule && input.categoryId !== undefined && effectiveMerchant) {
        const now = new Date();
        await tx
          .insert(schema.merchantCategoryRules)
          .values({
            householdId: current.householdId,
            merchantPattern: effectiveMerchant,
            categoryId: input.categoryId,
            createdBy: userId,
          })
          .onConflictDoUpdate({
            target: [
              schema.merchantCategoryRules.householdId,
              schema.merchantCategoryRules.merchantPattern,
            ],
            set: { categoryId: input.categoryId, updatedAt: now },
          });
      }
    });

    const row = await this.loadSummaryRow(id);
    return buildSummary(row.txn, row.categorySlug, false);
  }

  /**
   * Manually links a `cancellation` row to its `approval` (spec §5.3). Validates
   * same household, that the target is an approval and the source a cancellation,
   * and that the cancelled amount does not exceed the remaining approved balance.
   * Accumulates `cancelledAmount`, recomputes `netAmount`/`status` on the
   * approval, and marks the cancellation resolved. Runs in one DB transaction.
   */
  async linkCancellation(
    userId: string,
    cancellationId: string,
    input: LinkCancellationRequest,
  ): Promise<TransactionSummary> {
    const cancellation = await this.loadTransaction(cancellationId);
    const actor = await this.requireMembership(
      cancellation.householdId,
      userId,
    );
    this.assertCanMutate(actor, cancellation.memberId);

    if (cancellation.transactionType !== 'cancellation') {
      throw new BadRequestException('source is not a cancellation transaction');
    }
    if (cancellation.parentTransactionId) {
      throw new ConflictException('cancellation is already linked');
    }

    const approval = await this.loadTransaction(input.approvalTransactionId);
    if (approval.householdId !== cancellation.householdId) {
      throw new BadRequestException('transactions belong to different households');
    }
    if (approval.transactionType !== 'approval') {
      throw new BadRequestException('target is not an approval transaction');
    }

    const remaining = approval.amount - approval.cancelledAmount;
    if (cancellation.amount > remaining) {
      throw new BadRequestException(
        'cancellation amount exceeds remaining approved balance',
      );
    }

    const newCancelled = approval.cancelledAmount + cancellation.amount;
    assertKrwInteger(newCancelled);
    const newNet = approval.amount - newCancelled;
    assertKrwInteger(newNet);
    const newStatus: TxnStatus =
      newCancelled >= approval.amount ? 'cancelled' : 'partially_cancelled';

    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(schema.cardTransactions)
        .set({
          cancelledAmount: newCancelled,
          netAmount: newNet,
          status: newStatus,
          updatedAt: now,
        })
        .where(eq(schema.cardTransactions.id, approval.id));

      await tx
        .update(schema.cardTransactions)
        .set({
          parentTransactionId: approval.id,
          status: 'approved',
          updatedAt: now,
        })
        .where(eq(schema.cardTransactions.id, cancellation.id));
    });

    const row = await this.loadSummaryRow(approval.id);
    return buildSummary(row.txn, row.categorySlug, false);
  }

  /** Flags a transaction as a suspected duplicate (owner/admin or row owner). */
  async markDuplicate(
    userId: string,
    id: string,
  ): Promise<TransactionSummary> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    await this.db
      .update(schema.cardTransactions)
      .set({ status: 'duplicate_suspected', updatedAt: new Date() })
      .where(eq(schema.cardTransactions.id, id));

    const row = await this.loadSummaryRow(id);
    return buildSummary(row.txn, row.categorySlug, false);
  }

  /**
   * Clears a `duplicate_suspected`/`pending_review` flag, recomputing the
   * canonical status and `netAmount` from the row's amounts.
   */
  async markValid(userId: string, id: string): Promise<TransactionSummary> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    if (
      current.status !== 'duplicate_suspected' &&
      current.status !== 'pending_review'
    ) {
      throw new BadRequestException('transaction is not pending review');
    }

    let status: TxnStatus;
    let netAmount: number;
    if (current.transactionType === 'approval') {
      netAmount = current.amount - current.cancelledAmount;
      assertKrwInteger(netAmount);
      status =
        current.cancelledAmount >= current.amount
          ? 'cancelled'
          : current.cancelledAmount > 0
            ? 'partially_cancelled'
            : 'approved';
    } else {
      // A cancellation row carries no net amount of its own.
      netAmount = 0;
      status = 'approved';
    }

    await this.db
      .update(schema.cardTransactions)
      .set({ status, netAmount, updatedAt: new Date() })
      .where(eq(schema.cardTransactions.id, id));

    const row = await this.loadSummaryRow(id);
    return buildSummary(row.txn, row.categorySlug, false);
  }

  /**
   * Excludes a transaction from every total/budget (사용자가 '중복이라 제외' 확정).
   * Sets `excludedAt=now` — a flag orthogonal to `status` so the row keeps its
   * kind/amounts for history while dropping out of aggregations. Idempotent.
   */
  async exclude(userId: string, id: string): Promise<TransactionSummary> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    if (current.excludedAt === null) {
      await this.db
        .update(schema.cardTransactions)
        .set({ excludedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.cardTransactions.id, id));
    }

    const row = await this.loadSummaryRow(id);
    return buildSummary(row.txn, row.categorySlug, false);
  }

  /** Undoes {@link exclude}: `excludedAt=null` so the row counts again. Idempotent. */
  async include(userId: string, id: string): Promise<TransactionSummary> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    if (current.excludedAt !== null) {
      await this.db
        .update(schema.cardTransactions)
        .set({ excludedAt: null, updatedAt: new Date() })
        .where(eq(schema.cardTransactions.id, id));
    }

    const row = await this.loadSummaryRow(id);
    return buildSummary(row.txn, row.categorySlug, false);
  }

  /* ---------------------------------------------------------------------- */
  /* Authorization + loaders                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Enforces that `userId` is an active member of `householdId` and returns the
   * actor's `memberId`/`role`. Non-members get a 403 that does not disclose
   * whether the household exists (PRD §26).
   */
  private async requireMembership(
    householdId: string,
    userId: string,
    roles?: readonly HouseholdRole[],
  ): Promise<ActorMembership> {
    const [member] = await this.db
      .select({
        id: schema.householdMembers.id,
        role: schema.householdMembers.role,
      })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .limit(1);

    if (!member) {
      throw new ForbiddenException('not a household member');
    }
    if (roles && !roles.includes(member.role)) {
      throw new ForbiddenException('insufficient role');
    }
    return { memberId: member.id, role: member.role };
  }

  /** Owner/admin, or the member who owns the row, may mutate it. */
  private assertCanMutate(actor: ActorMembership, rowMemberId: string): void {
    if (PRIVILEGED_ROLES.includes(actor.role)) {
      return;
    }
    if (actor.memberId === rowMemberId) {
      return;
    }
    throw new ForbiddenException('insufficient permission for this transaction');
  }

  /**
   * The visibility WHERE fragment (§1.4): own rows ∪ `household`/`summary_only`.
   * Another member's `private` rows are excluded; `summary_only` rows are kept
   * here and masked at projection time.
   */
  private visibilityScope(actorMemberId: string): SQL {
    const scope = or(
      eq(schema.cardTransactions.memberId, actorMemberId),
      inArray(schema.cardTransactions.visibility, ['household', 'summary_only']),
    );
    // Both operands are defined, so `or` always yields a SQL fragment.
    return scope as SQL;
  }

  /** Loads a raw transaction row or throws 404. */
  private async loadTransaction(id: string): Promise<schema.CardTransaction> {
    const [txn] = await this.db
      .select()
      .from(schema.cardTransactions)
      .where(eq(schema.cardTransactions.id, id))
      .limit(1);
    if (!txn) {
      throw new NotFoundException('transaction not found');
    }
    return txn;
  }

  /** Loads a transaction row joined with its category slug, or throws 404. */
  private async loadSummaryRow(
    id: string,
  ): Promise<{ txn: schema.CardTransaction; categorySlug: string | null }> {
    const [row] = await this.db
      .select({
        txn: schema.cardTransactions,
        categorySlug: schema.expenseCategories.slug,
      })
      .from(schema.cardTransactions)
      .leftJoin(
        schema.expenseCategories,
        eq(schema.cardTransactions.categoryId, schema.expenseCategories.id),
      )
      .where(eq(schema.cardTransactions.id, id))
      .limit(1);
    if (!row) {
      throw new NotFoundException('transaction not found');
    }
    return row;
  }

  /** Validates a category exists and is a system default or the household's own. */
  private async assertCategoryUsable(
    categoryId: string,
    householdId: string,
  ): Promise<void> {
    const [category] = await this.db
      .select({
        id: schema.expenseCategories.id,
        householdId: schema.expenseCategories.householdId,
      })
      .from(schema.expenseCategories)
      .where(eq(schema.expenseCategories.id, categoryId))
      .limit(1);
    if (
      !category ||
      (category.householdId !== null && category.householdId !== householdId)
    ) {
      throw new BadRequestException('invalid category');
    }
  }

  /** Validates a target member belongs to the household. */
  private async assertMemberInHousehold(
    memberId: string,
    householdId: string,
  ): Promise<void> {
    const [member] = await this.db
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.id, memberId),
          eq(schema.householdMembers.householdId, householdId),
        ),
      )
      .limit(1);
    if (!member) {
      throw new BadRequestException('member does not belong to this household');
    }
  }

  /** Loads a card scoped to the household, or throws 400. */
  private async loadCard(
    cardId: string,
    householdId: string,
  ): Promise<schema.PaymentCard> {
    const [card] = await this.db
      .select()
      .from(schema.paymentCards)
      .where(
        and(
          eq(schema.paymentCards.id, cardId),
          eq(schema.paymentCards.householdId, householdId),
        ),
      )
      .limit(1);
    if (!card) {
      throw new BadRequestException('card does not belong to this household');
    }
    return card;
  }

  /* ---------------------------------------------------------------------- */
  /* Input parsing                                                           */
  /* ---------------------------------------------------------------------- */

  private requireHouseholdId(householdId: string | undefined): string {
    if (!householdId) {
      throw new BadRequestException('householdId is required');
    }
    return householdId;
  }

  /** Clamps the requested page size to `[1, MAX_LIMIT]` (default 50). */
  private parseLimit(limit: string | undefined): number {
    if (limit === undefined) {
      return DEFAULT_LIMIT;
    }
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return Math.min(parsed, MAX_LIMIT);
  }

  private parseType(type: string): TxnType {
    if (!TXN_TYPES.includes(type as TxnType)) {
      throw new BadRequestException('invalid transaction type filter');
    }
    return type as TxnType;
  }

  private parseStatus(status: string): TxnStatus {
    if (!TXN_STATUSES.includes(status as TxnStatus)) {
      throw new BadRequestException('invalid status filter');
    }
    return status as TxnStatus;
  }

  private parseDate(value: string | undefined, field: string): Date | undefined {
    if (value === undefined || value === '') {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be an ISO datetime`);
    }
    return parsed;
  }

  private parseAmount(
    value: string | undefined,
    field: string,
  ): number | undefined {
    if (value === undefined || value === '') {
      return undefined;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestException(`${field} must be a non-negative integer`);
    }
    return parsed;
  }

  /** Encodes an opaque `base64url("<epochMs>:<uuid>")` keyset cursor. */
  private encodeCursor(row: { createdAt: Date; id: string }): string {
    return Buffer.from(
      `${row.createdAt.getTime()}:${row.id}`,
      'utf8',
    ).toString('base64url');
  }

  /** Decodes an opaque `base64url("<epochMs>:<uuid>")` keyset cursor. */
  private decodeCursor(cursor: string | undefined): Cursor | undefined {
    if (cursor === undefined || cursor === '') {
      return undefined;
    }
    let decoded: string;
    try {
      decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('invalid cursor');
    }
    const sep = decoded.indexOf(':');
    if (sep <= 0) {
      throw new BadRequestException('invalid cursor');
    }
    const epochMs = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isInteger(epochMs) || id === '') {
      throw new BadRequestException('invalid cursor');
    }
    return { createdAt: new Date(epochMs), id };
  }
}

/* -------------------------------------------------------------------------- */
/* Row → contract projection                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether a row must be masked for the actor: another member's `summary_only`
 * row hides its merchant/memo but still reports its amounts.
 */
function maskedFor(txn: schema.CardTransaction, actorMemberId: string): boolean {
  return txn.memberId !== actorMemberId && txn.visibility === 'summary_only';
}

/** Projects a transaction row (+ category slug) to its contract summary. */
function buildSummary(
  txn: schema.CardTransaction,
  categorySlug: string | null,
  masked: boolean,
): TransactionSummary {
  return {
    id: txn.id,
    householdId: txn.householdId,
    memberId: txn.memberId,
    cardId: txn.cardId,
    transactionType: txn.transactionType,
    status: txn.status,
    amount: txn.amount,
    cancelledAmount: txn.cancelledAmount,
    netAmount: txn.netAmount,
    currency: txn.currency,
    merchantRaw: masked ? null : txn.merchantRaw,
    merchantNormalized: masked ? null : txn.merchantNormalized,
    categoryId: txn.categoryId,
    categorySlug,
    approvedAt: txn.approvedAt ? txn.approvedAt.toISOString() : null,
    cancelledAt: txn.cancelledAt ? txn.cancelledAt.toISOString() : null,
    installmentMonths: txn.installmentMonths,
    parentTransactionId: txn.parentTransactionId,
    visibility: txn.visibility,
    memo: masked ? null : txn.memo,
    masked,
    excludedAt: txn.excludedAt ? txn.excludedAt.toISOString() : null,
    createdAt: txn.createdAt.toISOString(),
  };
}

/** Coerces a driver-returned numeric aggregate (string | number) to an int. */
function toInt(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}
