import { createHash } from 'node:crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Inject,
  Injectable, InternalServerErrorException, NotFoundException, Optional, UnauthorizedException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  manualAssetCreateRequestSchema, manualAssetUpdateRequestSchema,
  manualFinanceDeleteRequestSchema, manualFinanceListQuerySchema,
  manualHousingPlanCreateRequestSchema, manualHousingPlanUpdateRequestSchema,
  type ManualAsset, type ManualAssetCreateRequest, type ManualAssetListResponse,
  type ManualAssetResponse, type ManualAssetUpdateRequest, type ManualFinanceDeleteRequest,
  type ManualFinanceDeleteResponse, type ManualFinanceListQuery, type ManualFinanceScope,
  type ManualHousingPayment, type ManualHousingPaymentInput, type ManualHousingPlan,
  type ManualHousingPlanCreateRequest, type ManualHousingPlanListResponse,
  type ManualHousingPlanResponse, type ManualHousingPlanUpdateRequest, type ManualSavingsPlan,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { manualFinanceSeoulDate, manualSavingsView, summarizeManualAssets, summarizeManualHousingPlans } from '@family/shared';
import { DB } from '../database/database.constants';
import { RealtimePublisherService } from '../realtime/realtime-publisher.service';

type Executor = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;
type AssetRow = typeof schema.manualAssets.$inferSelect;
type PlanRow = typeof schema.manualHousingPlans.$inferSelect;
type PaymentRow = typeof schema.manualHousingPayments.$inferSelect;
type FinanceTable = typeof schema.manualAssets | typeof schema.manualHousingPlans;
type AuditType = 'asset' | 'housing_plan';
const WRITER_ROLES = new Set<schema.HouseholdMember['role']>(['owner', 'admin', 'member']);

const householdQuery = z.object({ householdId: z.string().uuid(), id: z.string().uuid() }).strict();
const stale = () => new ConflictException({ code: 'manual_finance_stale',
  message: '기록이 변경됐어요. 최신 내용을 다시 확인해 주세요.' });
const notFound = () => new NotFoundException('수동 기록을 찾을 수 없습니다.');
const createConflict = () => new ConflictException({ code: 'manual_finance_create_conflict',
  message: '이 작성 요청을 적용할 수 없어요. 목록에서 저장 결과를 확인해 주세요.' });

function parse<T>(contract: z.ZodType<T>, input: unknown): T {
  const result = contract.safeParse(input);
  if (!result.success) throw new BadRequestException('입력한 값과 미입력 항목을 확인해 주세요.');
  return result.data;
}

function actorId(value: string): string {
  if (!z.string().uuid().safeParse(value).success) throw new UnauthorizedException('unauthorized');
  return value.toLowerCase();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + stableJson(item)).join(',') + '}';
  return JSON.stringify(value);
}

/** Stored only on the entity; never returned, logged or copied to the audit table. */
function creationHash(userId: string, input: unknown): string {
  return createHash('sha256').update(stableJson({ userId, input })).digest('hex');
}

function paymentInputs(payments: ManualHousingPaymentInput[]): ManualHousingPaymentInput[] {
  return payments.map(payment => ({ ...payment, id: payment.id.toLowerCase() }));
}

function assetFields(input: ManualAssetCreateRequest | ManualAssetUpdateRequest) {
  return { kind: input.kind, label: input.label, visibility: input.visibility, amount: input.amount,
    asOfDate: input.asOfDate, source: input.source, legalOwnerLabel: input.legalOwnerLabel, note: input.note };
}

/** 적금 자동 납입 열. 계획이 없으면 셋 다 null(DB manual_assets_contribution_check). */
function savingsColumns(plan: ManualSavingsPlan | null) {
  return { contributionAmount: plan?.monthlyAmount ?? null, contributionDay: plan?.day ?? null,
    contributionEndDate: plan?.endDate ?? null };
}

/**
 * 수정 요청의 자동 납입 열. 키가 없으면(옛 앱) 기존 계획을 두되, 적금이 아니게 바뀌었거나 금액을
 * 지웠으면 계획도 지운다 — 남겨 두면 DB 제약에 걸려 저장 자체가 실패한다.
 */
function nextSavingsColumns(input: ManualAssetUpdateRequest, current: AssetRow) {
  if (input.savingsPlan !== undefined) return savingsColumns(input.savingsPlan);
  if (input.kind !== 'saving' || input.amount === null) return savingsColumns(null);
  return { contributionAmount: current.contributionAmount, contributionDay: current.contributionDay,
    contributionEndDate: current.contributionEndDate };
}

function planFields(input: ManualHousingPlanCreateRequest | ManualHousingPlanUpdateRequest) {
  return { label: input.label, visibility: input.visibility, occupancyYear: input.occupancyYear,
    contractStage: input.contractStage, fundingNote: input.fundingNote };
}

/** amount·asOfDate는 적금 자동 납입을 더한 현재 값이다(manualSavingsView). */
function toAsset(row: AssetRow, userId: string, canWrite: boolean, today = manualFinanceSeoulDate()): ManualAsset {
  return { id: row.id, householdId: row.householdId, ownerUserId: row.ownerUserId,
    kind: row.kind, label: row.label, visibility: row.visibility,
    currency: 'KRW', source: row.source, legalOwnerLabel: row.legalOwnerLabel,
    note: row.note, version: row.version, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(), canEdit: canWrite && row.ownerUserId === userId,
    ...manualSavingsView(row, today) };
}

function toPlan(row: PlanRow, userId: string, canWrite: boolean): ManualHousingPlan {
  return { id: row.id, householdId: row.householdId, ownerUserId: row.ownerUserId,
    label: row.label, visibility: row.visibility, occupancyYear: row.occupancyYear,
    contractStage: row.contractStage, fundingNote: row.fundingNote, version: row.version,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    canEdit: canWrite && row.ownerUserId === userId };
}

function seoulMinute(value: Date | null): string | null {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function paymentStatus(amount: string | null, paidAmount: string | null): ManualHousingPayment['status'] {
  if (amount === null || paidAmount === null) return 'unknown';
  const left = BigInt(amount) - BigInt(paidAmount);
  if (left <= 0n) return 'paid';
  if (BigInt(paidAmount) > 0n) return 'partial';
  return 'unpaid';
}

function toPayment(row: PaymentRow): ManualHousingPayment {
  const remaining = row.amount !== null && row.paidAmount !== null
    ? (BigInt(row.amount) - BigInt(row.paidAmount) < 0n ? '0' : (BigInt(row.amount) - BigInt(row.paidAmount)).toString())
    : null;
  return {
    id: row.id, planId: row.planId, kind: row.kind, installment: row.installment,
    label: row.label ?? null,
    dueDate: row.dueDate, amount: row.amount, paidAmount: row.paidAmount, paidDate: row.paidDate,
    amountSource: row.amountSource ?? null,
    amountAsOfAt: row.amountAsOfAt?.toISOString() ?? null,
    amountAsOfSeoul: seoulMinute(row.amountAsOfAt),
    paidAmountSource: row.paidAmountSource ?? null,
    paidAmountAsOfAt: row.paidAmountAsOfAt?.toISOString() ?? null,
    paidAmountAsOfSeoul: seoulMinute(row.paidAmountAsOfAt),
    remainingAmount: remaining,
    status: paymentStatus(row.amount, row.paidAmount),
  };
}

function toBrandConnection(
  row: typeof schema.housingBrandConnections.$inferSelect,
  userId: string,
): NonNullable<ManualHousingPlanResponse['brandConnection']> {
  return {
    id: row.id,
    planId: row.planId,
    brand: row.brand,
    status: row.status,
    statusMessage: row.statusMessage,
    credentialsStored: row.credentials !== null && row.disconnectedAt === null,
    version: row.version,
    lastFetchAt: row.lastFetchAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    canManage: row.ownerUserId === userId && row.disconnectedAt === null,
  };
}

/**
 * Separate manual records: no card, SMS, balance-transfer or payment execution.
 *
 * Lock order for writes: active actor membership SHARE -> live household SHARE
 * -> owned entity UPDATE -> that plan's children. removeMember locks the target
 * membership first, so it either waits for this write and then revokes sharing,
 * or commits first and prevents the write. Owner/admin roles do not override
 * private records. Read transactions use one repeatable snapshot, preventing
 * a shared plan's old header being combined with newly-private payment values.
 */
@Injectable()
export class ManualFinanceService {
  constructor(@Inject(DB) private readonly db: Db,
    @Optional() private readonly realtimePublisher?: RealtimePublisherService) {}

  /** Only call after commit, and only if the before/after record was shared. */
  private publishShared(householdId: string): void {
    try { void this.realtimePublisher?.publish(householdId, 'manual-finance.changed').catch(() => {}); }
    catch { /* A hint failure must not turn a committed write into an uncertain result. */ }
  }

  private async member(tx: Executor, householdId: string, userId: string, write = false): Promise<{ canWrite: boolean }> {
    const [member] = await tx.select({ id: schema.householdMembers.id, role: schema.householdMembers.role })
      .from(schema.householdMembers).innerJoin(schema.users, eq(schema.users.id, schema.householdMembers.userId))
      .where(and(eq(schema.householdMembers.householdId, householdId),
        eq(schema.householdMembers.userId, userId), eq(schema.householdMembers.status, 'active'),
        isNull(schema.users.deletedAt)))
      .for('share', { of: schema.householdMembers }).limit(1);
    if (!member) throw new ForbiddenException('not a household member');
    const canWrite = WRITER_ROLES.has(member.role);
    if (write && !canWrite) throw new ForbiddenException('조회 전용 구성원은 수동 기록을 변경할 수 없습니다.');
    const [household] = await tx.select({ id: schema.households.id }).from(schema.households)
      .where(and(eq(schema.households.id, householdId), isNull(schema.households.deletedAt)))
      .for('share').limit(1);
    if (!household) throw new ForbiddenException('not a household member');
    return { canWrite };
  }

  private ownerActive(table: FinanceTable): SQL {
    return sql`exists (select 1 from ${schema.householdMembers}
      inner join ${schema.users} on ${schema.users.id} = ${schema.householdMembers.userId}
      where ${schema.householdMembers.householdId} = ${table.householdId}
        and ${schema.householdMembers.userId} = ${table.ownerUserId}
        and ${schema.householdMembers.status} = 'active' and ${schema.users.deletedAt} is null)`;
  }

  private visible(table: FinanceTable, householdId: string, userId: string, scope?: ManualFinanceScope): SQL | undefined {
    return and(eq(table.householdId, householdId), isNull(table.deletedAt), this.ownerActive(table),
      scope === 'private' ? and(eq(table.visibility, 'private'), eq(table.ownerUserId, userId))
        : scope === 'household' ? eq(table.visibility, 'household')
          : or(eq(table.visibility, 'household'), eq(table.ownerUserId, userId)));
  }

  private async transaction<T>(run: (tx: Executor) => Promise<T>, read = false): Promise<T> {
    try {
      return await this.db.transaction(run, { isolationLevel: read ? 'repeatable read' : 'read committed' });
    } catch (error) {
      let cause: unknown = error;
      for (let i = 0; i < 4 && cause !== null && typeof cause === 'object'; i += 1) {
        const detail = cause as { code?: unknown; cause?: unknown };
        if (['23505', '40001', '40P01', '55P03'].includes(String(detail.code))) throw stale();
        cause = detail.cause;
      }
      if (error instanceof HttpException) throw error;
      // Drizzle errors may contain SQL binds with a private label, note or
      // amount. Do not forward those into Nest's exception logger or response.
      throw new InternalServerErrorException('수동 기록을 확인하거나 저장하지 못했어요. 잠시 뒤 다시 확인해 주세요.');
    }
  }

  private async audit(tx: Executor, householdId: string, userId: string, entityType: AuditType,
    entityId: string, action: 'create' | 'update' | 'delete', version: number): Promise<void> {
    await tx.insert(schema.manualFinanceAudit).values({ householdId, actorUserId: userId,
      entityType, entityId, action, version });
  }

  private nextVersion(current: number, expected: number): number {
    if (current !== expected || current >= 2_147_483_647) throw stale();
    return current + 1;
  }

  async listAssets(user: string, query: ManualFinanceListQuery): Promise<ManualAssetListResponse> {
    const userId = actorId(user), input = parse(manualFinanceListQuerySchema, query);
    const householdId = input.householdId.toLowerCase();
    return this.transaction(async tx => {
      const access = await this.member(tx, householdId, userId);
      const rows = await tx.select().from(schema.manualAssets)
        .where(this.visible(schema.manualAssets, householdId, userId, input.scope))
        .orderBy(asc(schema.manualAssets.createdAt), asc(schema.manualAssets.id));
      const today = manualFinanceSeoulDate();
      const items = rows.map(row => toAsset(row, userId, access.canWrite, today));
      return { items, summary: summarizeManualAssets(items) };
    }, true);
  }

  async getAsset(user: string, household: string, identifier: string): Promise<ManualAssetResponse> {
    const userId = actorId(user), query = parse(householdQuery, { householdId: household, id: identifier });
    return this.transaction(async tx => {
      const access = await this.member(tx, query.householdId.toLowerCase(), userId);
      const [row] = await tx.select().from(schema.manualAssets).where(and(
        eq(schema.manualAssets.id, query.id.toLowerCase()), this.visible(schema.manualAssets, query.householdId.toLowerCase(), userId),
      )).limit(1);
      if (!row) throw notFound();
      return { item: toAsset(row, userId, access.canWrite) };
    }, true);
  }

  async createAsset(user: string, request: ManualAssetCreateRequest): Promise<ManualAssetResponse> {
    const userId = actorId(user), parsed = parse(manualAssetCreateRequestSchema, request);
    const input = { ...parsed, id: parsed.id.toLowerCase(), householdId: parsed.householdId.toLowerCase() };
    const hash = creationHash(userId, input);
    let sharedChange = false;
    const result = await this.transaction(async tx => {
      const access = await this.member(tx, input.householdId, userId, true);
      const [created] = await tx.insert(schema.manualAssets).values({ id: input.id,
        householdId: input.householdId, ownerUserId: userId, ...assetFields(input),
        ...savingsColumns(input.savingsPlan ?? null),
        currency: 'KRW', version: 1, creationPayloadHash: hash }).onConflictDoNothing({ target: schema.manualAssets.id }).returning();
      if (created) {
        await this.audit(tx, input.householdId, userId, 'asset', created.id, 'create', created.version);
        sharedChange = created.visibility === 'household';
        return { item: toAsset(created, userId, access.canWrite) };
      }
      const [existing] = await tx.select().from(schema.manualAssets).where(eq(schema.manualAssets.id, input.id)).limit(1);
      if (!existing || existing.householdId !== input.householdId || existing.ownerUserId !== userId
        || existing.deletedAt !== null || existing.creationPayloadHash !== hash) throw createConflict();
      return { item: toAsset(existing, userId, access.canWrite) };
    });
    if (sharedChange) this.publishShared(input.householdId);
    return result;
  }

  async updateAsset(user: string, household: string, identifier: string, request: ManualAssetUpdateRequest): Promise<ManualAssetResponse> {
    const userId = actorId(user), query = parse(householdQuery, { householdId: household, id: identifier });
    const input = parse(manualAssetUpdateRequestSchema, request), householdId = query.householdId.toLowerCase(), id = query.id.toLowerCase();
    let sharedChange = false;
    const result = await this.transaction(async tx => {
      const access = await this.member(tx, householdId, userId, true);
      const [current] = await tx.select().from(schema.manualAssets).where(and(eq(schema.manualAssets.id, id),
        eq(schema.manualAssets.householdId, householdId), eq(schema.manualAssets.ownerUserId, userId), isNull(schema.manualAssets.deletedAt)))
        .for('update').limit(1);
      if (!current) throw notFound();
      const version = this.nextVersion(current.version, input.expectedVersion);
      const [row] = await tx.update(schema.manualAssets).set({ ...assetFields(input), ...nextSavingsColumns(input, current), version, updatedAt: new Date() })
        .where(and(eq(schema.manualAssets.id, id), eq(schema.manualAssets.householdId, householdId),
          eq(schema.manualAssets.ownerUserId, userId), eq(schema.manualAssets.version, input.expectedVersion), isNull(schema.manualAssets.deletedAt))).returning();
      if (!row) throw stale();
      await this.audit(tx, householdId, userId, 'asset', id, 'update', version);
      sharedChange = current.visibility === 'household' || row.visibility === 'household';
      return { item: toAsset(row, userId, access.canWrite) };
    });
    if (sharedChange) this.publishShared(householdId);
    return result;
  }

  async deleteAsset(user: string, household: string, identifier: string, request: ManualFinanceDeleteRequest): Promise<ManualFinanceDeleteResponse> {
    const userId = actorId(user), query = parse(householdQuery, { householdId: household, id: identifier });
    const input = parse(manualFinanceDeleteRequestSchema, request), householdId = query.householdId.toLowerCase(), id = query.id.toLowerCase();
    let sharedChange = false;
    const result = await this.transaction(async tx => {
      const access = await this.member(tx, householdId, userId, true);
      const [current] = await tx.select().from(schema.manualAssets).where(and(eq(schema.manualAssets.id, id),
        eq(schema.manualAssets.householdId, householdId), eq(schema.manualAssets.ownerUserId, userId))).for('update').limit(1);
      if (!current) throw notFound();
      if (current.deletedAt !== null) {
        if (current.version !== input.expectedVersion + 1) throw stale();
        return { deleted: true };
      }
      const version = this.nextVersion(current.version, input.expectedVersion), now = new Date();
      const [row] = await tx.update(schema.manualAssets).set({ deletedAt: now, updatedAt: now, version })
        .where(and(eq(schema.manualAssets.id, id), eq(schema.manualAssets.householdId, householdId),
          eq(schema.manualAssets.ownerUserId, userId), eq(schema.manualAssets.version, input.expectedVersion), isNull(schema.manualAssets.deletedAt))).returning();
      if (!row) throw stale();
      await this.audit(tx, householdId, userId, 'asset', id, 'delete', version);
      sharedChange = current.visibility === 'household';
      return { deleted: true };
    });
    if (sharedChange) this.publishShared(householdId);
    return result;
  }

  private async payments(tx: Executor, planIds: string[]): Promise<PaymentRow[]> {
    if (planIds.length === 0) return [];
    return tx.select().from(schema.manualHousingPayments).where(inArray(schema.manualHousingPayments.planId, planIds))
      .orderBy(asc(schema.manualHousingPayments.planId), asc(schema.manualHousingPayments.position), asc(schema.manualHousingPayments.id));
  }

  async listPlans(user: string, query: ManualFinanceListQuery): Promise<ManualHousingPlanListResponse> {
    const userId = actorId(user), input = parse(manualFinanceListQuerySchema, query), householdId = input.householdId.toLowerCase();
    return this.transaction(async tx => {
      const access = await this.member(tx, householdId, userId);
      const rows = await tx.select().from(schema.manualHousingPlans)
        .where(this.visible(schema.manualHousingPlans, householdId, userId, input.scope))
        .orderBy(asc(schema.manualHousingPlans.createdAt), asc(schema.manualHousingPlans.id));
      const payments = await this.payments(tx, rows.map(row => row.id));
      const items = rows.map(row => toPlan(row, userId, access.canWrite));
      return { items, summary: summarizeManualHousingPlans(items.map(item => ({ ...item,
        payments: payments.filter(payment => payment.planId === item.id).map(toPayment) }))) };
    }, true);
  }

  async getPlan(user: string, household: string, identifier: string): Promise<ManualHousingPlanResponse> {
    const userId = actorId(user), query = parse(householdQuery, { householdId: household, id: identifier });
    return this.transaction(async tx => {
      const householdId = query.householdId.toLowerCase(), id = query.id.toLowerCase();
      const access = await this.member(tx, householdId, userId);
      const [row] = await tx.select().from(schema.manualHousingPlans).where(and(eq(schema.manualHousingPlans.id, id),
        this.visible(schema.manualHousingPlans, householdId, userId))).limit(1);
      if (!row) throw notFound();
      const brandConnection = row.ownerUserId === userId
        ? await this.brandConnection(tx, id, userId)
        : null;
      return {
        item: toPlan(row, userId, access.canWrite),
        payments: (await this.payments(tx, [id])).map(toPayment),
        brandConnection,
      };
    }, true);
  }

  private async brandConnection(tx: Executor, planId: string, userId: string) {
    const [row] = await tx.select().from(schema.housingBrandConnections).where(and(
      eq(schema.housingBrandConnections.planId, planId),
      eq(schema.housingBrandConnections.ownerUserId, userId),
      isNull(schema.housingBrandConnections.disconnectedAt),
    )).limit(1);
    return row ? toBrandConnection(row, userId) : null;
  }

  private paymentInsert(
    payment: ManualHousingPaymentInput,
    planId: string,
    position: number,
    previous: PaymentRow | undefined,
    asOf = new Date(),
  ) {
    const amountUnchanged = previous != null && previous.amount === payment.amount;
    const paidUnchanged = previous != null && previous.paidAmount === payment.paidAmount;
    // 금액이 그대로면 클라이언트가 manual·새 시각을 보내도 이전 출처·기준 시각을 유지한다.
    const amountSource = payment.amount === null
      ? null
      : (amountUnchanged
        ? (previous!.amountSource ?? payment.amountSource ?? 'manual')
        : (payment.amountSource ?? 'manual'));
    const amountAsOfAt = payment.amount === null
      ? null
      : (amountUnchanged && previous!.amountAsOfAt
        ? previous!.amountAsOfAt
        : (payment.amountAsOfAt ? new Date(payment.amountAsOfAt) : asOf));
    const paidAmountSource = payment.paidAmount === null
      ? null
      : (paidUnchanged
        ? (previous!.paidAmountSource ?? payment.paidAmountSource ?? 'manual')
        : (payment.paidAmountSource ?? 'manual'));
    const paidAmountAsOfAt = payment.paidAmount === null
      ? null
      : (paidUnchanged && previous!.paidAmountAsOfAt
        ? previous!.paidAmountAsOfAt
        : (payment.paidAmountAsOfAt ? new Date(payment.paidAmountAsOfAt) : asOf));
    return {
      id: payment.id,
      planId,
      position,
      kind: payment.kind,
      installment: payment.installment,
      label: payment.label ?? previous?.label ?? null,
      dueDate: payment.dueDate,
      amount: payment.amount,
      amountSource,
      amountAsOfAt,
      paidAmount: payment.paidAmount,
      paidAmountSource,
      paidAmountAsOfAt,
      paidDate: payment.paidDate,
    };
  }

  private async replacePayments(tx: Executor, planId: string, payments: ManualHousingPaymentInput[], replacing = false): Promise<ManualHousingPayment[]> {
    const previousRows = replacing
      ? await tx.select().from(schema.manualHousingPayments).where(eq(schema.manualHousingPayments.planId, planId))
      : [];
    const previousById = new Map(previousRows.map((row) => [row.id, row]));
    if (replacing) await tx.delete(schema.manualHousingPayments).where(eq(schema.manualHousingPayments.planId, planId));
    if (payments.length === 0) return [];
    const rows = await tx.insert(schema.manualHousingPayments).values(
      payments.map((payment, position) => this.paymentInsert(payment, planId, position, previousById.get(payment.id))),
    ).returning();
    return rows.sort((a, b) => a.position - b.position).map(toPayment);
  }

  async createPlan(user: string, request: ManualHousingPlanCreateRequest): Promise<ManualHousingPlanResponse> {
    const userId = actorId(user), parsed = parse(manualHousingPlanCreateRequestSchema, request);
    const input = { ...parsed, id: parsed.id.toLowerCase(), householdId: parsed.householdId.toLowerCase(), payments: paymentInputs(parsed.payments) };
    const hash = creationHash(userId, input);
    let sharedChange = false;
    const result = await this.transaction(async tx => {
      const access = await this.member(tx, input.householdId, userId, true);
      const [created] = await tx.insert(schema.manualHousingPlans).values({ id: input.id, householdId: input.householdId,
        ownerUserId: userId, ...planFields(input), version: 1, creationPayloadHash: hash })
        .onConflictDoNothing({ target: schema.manualHousingPlans.id }).returning();
      if (created) {
        const payments = await this.replacePayments(tx, created.id, input.payments);
        await this.audit(tx, input.householdId, userId, 'housing_plan', created.id, 'create', created.version);
        sharedChange = created.visibility === 'household';
        return { item: toPlan(created, userId, access.canWrite), payments, brandConnection: null };
      }
      const [existing] = await tx.select().from(schema.manualHousingPlans).where(eq(schema.manualHousingPlans.id, input.id)).for('share').limit(1);
      if (!existing || existing.householdId !== input.householdId || existing.ownerUserId !== userId
        || existing.deletedAt !== null || existing.creationPayloadHash !== hash) throw createConflict();
      return {
        item: toPlan(existing, userId, access.canWrite),
        payments: (await this.payments(tx, [existing.id])).map(toPayment),
        brandConnection: await this.brandConnection(tx, existing.id, userId),
      };
    });
    if (sharedChange) this.publishShared(input.householdId);
    return result;
  }

  async updatePlan(user: string, household: string, identifier: string, request: ManualHousingPlanUpdateRequest): Promise<ManualHousingPlanResponse> {
    const userId = actorId(user), query = parse(householdQuery, { householdId: household, id: identifier });
    const parsed = parse(manualHousingPlanUpdateRequestSchema, request), input = { ...parsed, payments: paymentInputs(parsed.payments) };
    const householdId = query.householdId.toLowerCase(), id = query.id.toLowerCase();
    let sharedChange = false;
    const result = await this.transaction(async tx => {
      const access = await this.member(tx, householdId, userId, true);
      const [current] = await tx.select().from(schema.manualHousingPlans).where(and(eq(schema.manualHousingPlans.id, id),
        eq(schema.manualHousingPlans.householdId, householdId), eq(schema.manualHousingPlans.ownerUserId, userId), isNull(schema.manualHousingPlans.deletedAt)))
        .for('update').limit(1);
      if (!current) throw notFound();
      const version = this.nextVersion(current.version, input.expectedVersion);
      const [row] = await tx.update(schema.manualHousingPlans).set({ ...planFields(input), version, updatedAt: new Date() })
        .where(and(eq(schema.manualHousingPlans.id, id), eq(schema.manualHousingPlans.householdId, householdId),
          eq(schema.manualHousingPlans.ownerUserId, userId), eq(schema.manualHousingPlans.version, input.expectedVersion), isNull(schema.manualHousingPlans.deletedAt))).returning();
      if (!row) throw stale();
      const payments = await this.replacePayments(tx, id, input.payments, true);
      await this.audit(tx, householdId, userId, 'housing_plan', id, 'update', version);
      sharedChange = current.visibility === 'household' || row.visibility === 'household';
      return {
        item: toPlan(row, userId, access.canWrite),
        payments,
        brandConnection: await this.brandConnection(tx, id, userId),
      };
    });
    if (sharedChange) this.publishShared(householdId);
    return result;
  }

  async deletePlan(user: string, household: string, identifier: string, request: ManualFinanceDeleteRequest): Promise<ManualFinanceDeleteResponse> {
    const userId = actorId(user), query = parse(householdQuery, { householdId: household, id: identifier });
    const input = parse(manualFinanceDeleteRequestSchema, request), householdId = query.householdId.toLowerCase(), id = query.id.toLowerCase();
    let sharedChange = false;
    const result = await this.transaction(async tx => {
      const access = await this.member(tx, householdId, userId, true);
      const [current] = await tx.select().from(schema.manualHousingPlans).where(and(eq(schema.manualHousingPlans.id, id),
        eq(schema.manualHousingPlans.householdId, householdId), eq(schema.manualHousingPlans.ownerUserId, userId))).for('update').limit(1);
      if (!current) throw notFound();
      if (current.deletedAt !== null) {
        if (current.version !== input.expectedVersion + 1) throw stale();
        return { deleted: true };
      }
      const version = this.nextVersion(current.version, input.expectedVersion), now = new Date();
      const [row] = await tx.update(schema.manualHousingPlans).set({ deletedAt: now, updatedAt: now, version })
        .where(and(eq(schema.manualHousingPlans.id, id), eq(schema.manualHousingPlans.householdId, householdId),
          eq(schema.manualHousingPlans.ownerUserId, userId), eq(schema.manualHousingPlans.version, input.expectedVersion), isNull(schema.manualHousingPlans.deletedAt))).returning();
      if (!row) throw stale();
      await this.audit(tx, householdId, userId, 'housing_plan', id, 'delete', version);
      sharedChange = current.visibility === 'household';
      return { deleted: true };
    });
    if (sharedChange) this.publishShared(householdId);
    return result;
  }
}
