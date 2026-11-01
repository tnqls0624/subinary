import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable,
  InternalServerErrorException, NotFoundException, Optional, UnauthorizedException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  financialOverviewQuerySchema, loanImportCommitRequestSchema, loanImportDeleteRequestSchema,
  loanImportPreviewRequestSchema, loanImportUpdateRequestSchema,
  type FinancialOverviewQuery, type FinancialOverviewResponse, type ImportedLoanRecord,
  type LoanImportCommitRequest, type LoanImportDeleteRequest, type LoanImportPreviewRequest,
  type LoanImportPreviewResponse, type LoanImportRecordListResponse, type LoanImportRecordResponse,
  type LoanImportUpdateRequest, type ManualAsset, type ManualFinanceScope,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { composeFinancialOverview } from '@family/shared';
import { DB } from '../database/database.constants';
import { RealtimePublisherService } from '../realtime/realtime-publisher.service';
import { assertLoanCaptureTime, loanCommitHash } from './loan-import.policy';

type Executor = Pick<Db, 'select' | 'insert' | 'update'>;
type LoanRow = typeof schema.loanRecords.$inferSelect;
type SnapshotRow = typeof schema.loanSnapshots.$inferSelect;
type AssetRow = typeof schema.manualAssets.$inferSelect;
type Member = { id: string; canWrite: boolean };
type Review = Pick<LoanImportUpdateRequest, 'label' | 'visibility' | 'totalMode' | 'replacesManualAssetId' | 'manualExpectedVersion'>;
const writerRoles = new Set(['owner', 'admin', 'member']);
const querySchema = z.object({ householdId: z.string().uuid(), id: z.string().uuid().optional() }).strict();
const stale = () => new ConflictException({ code: 'loan_import_conflict', message: '기록이나 연결 대상이 변경됐어요. 최신 내용을 다시 확인해 주세요.' });
const missing = () => new NotFoundException('가져온 대출 기록을 찾을 수 없습니다.');

function parse<T>(contract: z.ZodType<T>, value: unknown): T {
  const parsed = contract.safeParse(value);
  if (!parsed.success) throw new BadRequestException('가져온 대출의 값과 확인 항목을 다시 확인해 주세요.');
  return parsed.data;
}
function actor(value: string): string {
  if (!z.string().uuid().safeParse(value).success) throw new UnauthorizedException('unauthorized');
  return value.toLowerCase();
}
function nextVersion(actual: number, expected: number | null): number {
  if (actual !== expected || actual >= 2_147_483_647) throw stale();
  return actual + 1;
}
function checkCaptureTime(value: string): void {
  try { assertLoanCaptureTime(value); }
  catch { throw new BadRequestException('조회 시각을 확인해 주세요. 24시간 이내에 새로 가져온 화면만 저장할 수 있어요.'); }
}
function reviewFields(input: Review, member: Member) {
  return {
    label: input.label, visibility: input.visibility, totalMode: input.totalMode,
    replacesManualAssetId: input.replacesManualAssetId?.toLowerCase() ?? null,
    manualExpectedVersion: input.manualExpectedVersion,
    sharedMemberId: input.visibility === 'household' ? member.id : null,
    // Copy the database value exactly: Date would truncate PostgreSQL microseconds.
    sharedJoinedAt: input.visibility === 'household'
      ? sql`(select ${schema.householdMembers.joinedAt} from ${schema.householdMembers} where ${schema.householdMembers.id} = ${member.id})`
      : null,
  };
}
function manualDto(row: AssetRow, userId: string, canWrite: boolean): ManualAsset {
  return { id: row.id, householdId: row.householdId, ownerUserId: row.ownerUserId, kind: row.kind,
    label: row.label, visibility: row.visibility, amount: row.amount, currency: 'KRW', asOfDate: row.asOfDate,
    source: row.source, legalOwnerLabel: row.legalOwnerLabel, note: row.note, version: row.version,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), canEdit: canWrite && row.ownerUserId === userId };
}
function loanDto(row: LoanRow, snapshot: SnapshotRow, userId: string, canWrite: boolean, sharingValid = true): ImportedLoanRecord {
  return {
    id: row.id, householdId: row.householdId, ownerUserId: row.ownerUserId, version: row.version,
    label: row.label, visibility: row.visibility, totalMode: row.totalMode,
    replacesManualAssetId: row.replacesManualAssetId, manualExpectedVersion: row.manualExpectedVersion,
    accountLast4: row.accountLast4, loanType: row.loanType, outstandingPrincipalKrw: snapshot.outstandingPrincipalKrw,
    maturityDate: snapshot.maturityDate, capturedAt: snapshot.capturedAt.toISOString(), bankAsOfDate: null,
    source: 'shinhan_browser', canEdit: canWrite && row.ownerUserId === userId, includedInTotals: false,
    exclusionReason: !sharingValid ? 'sharing_expired' : row.totalMode === 'reference' ? 'reference' : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/** No provider network/credentials. Captures remain unverified, user-reviewed observations. */
@Injectable()
export class LoanImportService {
  constructor(@Inject(DB) private readonly db: Db,
    @Optional() private readonly realtimePublisher?: RealtimePublisherService) {}

  private async transaction<T>(run: (tx: Executor) => Promise<T>, read = false): Promise<T> {
    try { return await this.db.transaction(run, { isolationLevel: read ? 'repeatable read' : 'read committed' }); }
    catch (error) {
      let cause: unknown = error;
      for (let depth = 0; depth < 4 && cause !== null && typeof cause === 'object'; depth++) {
        const item = cause as { code?: unknown; cause?: unknown };
        if (['23505', '40001', '40P01', '55P03'].includes(String(item.code))) throw stale();
        cause = item.cause;
      }
      if (error instanceof HttpException) throw error;
      // DB errors can contain SQL binds. Neither return nor attach their message/cause.
      throw new InternalServerErrorException('대출 기록을 확인하거나 저장하지 못했어요. 잠시 뒤 다시 확인해 주세요.');
    }
  }

  private publish(householdId: string): void {
    try { void this.realtimePublisher?.publish(householdId, 'manual-finance.changed').catch(() => {}); }
    catch { /* A failed hint must not undo or obscure an already committed write. */ }
  }

  /** Writes serialize per owner, then lock household -> record -> manual replacement. */
  private async member(tx: Executor, householdId: string, userId: string, write = false): Promise<Member> {
    const [membership] = await tx.select({ id: schema.householdMembers.id, role: schema.householdMembers.role }).from(schema.householdMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.householdMembers.userId))
      .where(and(eq(schema.householdMembers.householdId, householdId), eq(schema.householdMembers.userId, userId),
        eq(schema.householdMembers.status, 'active'), isNull(schema.users.deletedAt)))
      .for(write ? 'update' : 'share', { of: schema.householdMembers }).limit(1);
    if (!membership) throw new ForbiddenException('not a household member');
    const canWrite = writerRoles.has(membership.role);
    if (write && !canWrite) throw new ForbiddenException('조회 전용 구성원은 대출 기록을 변경할 수 없습니다.');
    const [household] = await tx.select({ id: schema.households.id }).from(schema.households)
      .where(and(eq(schema.households.id, householdId), isNull(schema.households.deletedAt))).for('share').limit(1);
    if (!household) throw new ForbiddenException('not a household member');
    return { id: membership.id, canWrite };
  }

  private ownerActive(table: typeof schema.manualAssets | typeof schema.loanRecords): SQL {
    return sql`exists (select 1 from ${schema.householdMembers}
      inner join ${schema.users} on ${schema.users.id} = ${schema.householdMembers.userId}
      where ${schema.householdMembers.householdId} = ${table.householdId}
        and ${schema.householdMembers.userId} = ${table.ownerUserId}
        and ${schema.householdMembers.status} = 'active' and ${schema.users.deletedAt} is null)`;
  }

  private sharingActive(): SQL {
    return sql`exists (select 1 from ${schema.householdMembers}
      where ${schema.householdMembers.id} = ${schema.loanRecords.sharedMemberId}
        and ${schema.householdMembers.householdId} = ${schema.loanRecords.householdId}
        and ${schema.householdMembers.userId} = ${schema.loanRecords.ownerUserId}
        and ${schema.householdMembers.joinedAt} = ${schema.loanRecords.sharedJoinedAt}
        and ${schema.householdMembers.status} = 'active')`;
  }

  private async currentlyShared(tx: Executor, row: LoanRow): Promise<boolean> {
    if (row.visibility !== 'household' || row.deletedAt !== null) return false;
    const [visible] = await tx.select({ id: schema.loanRecords.id }).from(schema.loanRecords)
      .where(and(eq(schema.loanRecords.id, row.id), this.ownerActive(schema.loanRecords), this.sharingActive())).limit(1);
    return Boolean(visible);
  }

  private async snapshots(tx: Executor, rows: LoanRow[]): Promise<Map<string, SnapshotRow>> {
    if (!rows.length) return new Map();
    // The (record_id, record_version) index supplies one current observation per
    // authorized record. Do not load the entire immutable history into the API.
    const observations = await tx.select().from(schema.loanSnapshots)
      .where(and(inArray(schema.loanSnapshots.recordId, rows.map(row => row.id)),
        sql`${schema.loanSnapshots.recordVersion} = (select max(latest.record_version) from loan_snapshots latest where latest.record_id = ${schema.loanSnapshots.recordId})`));
    const current = new Map<string, SnapshotRow>();
    for (const snapshot of observations) if (!current.has(snapshot.recordId)) current.set(snapshot.recordId, snapshot);
    for (const row of rows) {
      const snapshot = current.get(row.id);
      if (!snapshot || snapshot.householdId !== row.householdId || snapshot.ownerUserId !== row.ownerUserId
        || snapshot.recordVersion > row.version) throw new Error('loan snapshot unavailable');
    }
    return current;
  }

  private async buildOverview(tx: Executor, userId: string, householdId: string, scope: ManualFinanceScope, member: Member): Promise<FinancialOverviewResponse> {
    const manualRows = await tx.select().from(schema.manualAssets).where(and(
      eq(schema.manualAssets.householdId, householdId), isNull(schema.manualAssets.deletedAt), this.ownerActive(schema.manualAssets),
      scope === 'private' ? and(eq(schema.manualAssets.visibility, 'private'), eq(schema.manualAssets.ownerUserId, userId))
        : eq(schema.manualAssets.visibility, 'household'),
    )).orderBy(asc(schema.manualAssets.createdAt), asc(schema.manualAssets.id));
    const rows = await tx.select().from(schema.loanRecords).where(and(
      eq(schema.loanRecords.householdId, householdId), isNull(schema.loanRecords.deletedAt), this.ownerActive(schema.loanRecords),
      scope === 'private' ? and(eq(schema.loanRecords.visibility, 'private'), eq(schema.loanRecords.ownerUserId, userId))
        : and(eq(schema.loanRecords.visibility, 'household'), this.sharingActive()),
    )).orderBy(asc(schema.loanRecords.createdAt), asc(schema.loanRecords.id));
    const current = await this.snapshots(tx, rows);
    return composeFinancialOverview(manualRows.map(row => manualDto(row, userId, member.canWrite)),
      rows.map(row => ({ item: loanDto(row, current.get(row.id)!, userId, member.canWrite),
        accountFingerprint: row.accountFingerprint, sharingValid: true })));
  }

  private async result(tx: Executor, userId: string, householdId: string, row: LoanRow, member: Member): Promise<LoanImportRecordResponse> {
    const overview = await this.buildOverview(tx, userId, householdId, row.visibility, member);
    const item = overview.loanItems.find(item => item.id === row.id);
    if (item) return { item };
    const current = await this.snapshots(tx, [row]);
    // A shared row missing from the authorized overview has an expired grant.
    // Never substitute a millisecond-rounded JS comparison for the SQL check.
    return { item: loanDto(row, current.get(row.id)!, userId, member.canWrite, row.visibility === 'private') };
  }

  async overview(user: string, request: FinancialOverviewQuery): Promise<FinancialOverviewResponse> {
    const userId = actor(user), input = parse(financialOverviewQuerySchema, request), householdId = input.householdId.toLowerCase();
    return this.transaction(async tx => {
      const member = await this.member(tx, householdId, userId);
      return this.buildOverview(tx, userId, householdId, input.scope, member);
    }, true);
  }

  async records(user: string, household: string): Promise<LoanImportRecordListResponse> {
    const userId = actor(user), input = parse(querySchema, { householdId: household }), householdId = input.householdId.toLowerCase();
    return this.transaction(async tx => {
      const member = await this.member(tx, householdId, userId);
      const rows = await tx.select().from(schema.loanRecords).where(and(eq(schema.loanRecords.householdId, householdId),
        eq(schema.loanRecords.ownerUserId, userId), isNull(schema.loanRecords.deletedAt)))
        .orderBy(asc(schema.loanRecords.createdAt), asc(schema.loanRecords.id));
      const privateView = await this.buildOverview(tx, userId, householdId, 'private', member);
      const sharedView = await this.buildOverview(tx, userId, householdId, 'household', member);
      const visible = new Map([...privateView.loanItems, ...sharedView.loanItems].map(item => [item.id, item]));
      const snapshots = await this.snapshots(tx, rows);
      return { items: rows.map(row => visible.get(row.id)
        ?? loanDto(row, snapshots.get(row.id)!, userId, member.canWrite, row.visibility === 'private')) };
    }, true);
  }

  async preview(user: string, request: LoanImportPreviewRequest): Promise<LoanImportPreviewResponse> {
    const userId = actor(user), input = parse(loanImportPreviewRequestSchema, request), householdId = input.householdId.toLowerCase();
    checkCaptureTime(input.capture.capturedAt);
    return this.transaction(async tx => {
      const member = await this.member(tx, householdId, userId, true);
      const [record] = await tx.select().from(schema.loanRecords).where(and(eq(schema.loanRecords.householdId, householdId),
        eq(schema.loanRecords.ownerUserId, userId), eq(schema.loanRecords.accountFingerprint, input.capture.accountFingerprint),
        isNull(schema.loanRecords.deletedAt))).limit(1);
      const replacementRows = await tx.select().from(schema.manualAssets).where(and(eq(schema.manualAssets.householdId, householdId),
        eq(schema.manualAssets.ownerUserId, userId), eq(schema.manualAssets.kind, 'loan'), isNull(schema.manualAssets.deletedAt)))
        .orderBy(asc(schema.manualAssets.createdAt), asc(schema.manualAssets.id));
      return { capture: input.capture, existing: record ? (await this.result(tx, userId, householdId, record, member)).item : null,
        replacementOptions: replacementRows.map(row => manualDto(row, userId, member.canWrite)) };
    }, true);
  }

  private async checkReplacement(tx: Executor, userId: string, householdId: string, input: Review): Promise<void> {
    if (input.totalMode !== 'replacement') return;
    const [manual] = await tx.select().from(schema.manualAssets).where(and(eq(schema.manualAssets.id, input.replacesManualAssetId!.toLowerCase()),
      eq(schema.manualAssets.householdId, householdId), eq(schema.manualAssets.ownerUserId, userId),
      eq(schema.manualAssets.kind, 'loan'), isNull(schema.manualAssets.deletedAt))).for('update').limit(1);
    if (!manual || manual.visibility !== input.visibility || manual.version !== input.manualExpectedVersion) throw stale();
  }

  async commit(user: string, request: LoanImportCommitRequest): Promise<LoanImportRecordResponse> {
    const userId = actor(user), parsed = parse(loanImportCommitRequestSchema, request);
    const input = { ...parsed, requestId: parsed.requestId.toLowerCase(), recordId: parsed.recordId.toLowerCase(),
      householdId: parsed.householdId.toLowerCase(), replacesManualAssetId: parsed.replacesManualAssetId?.toLowerCase() ?? null };
    const payloadHash = loanCommitHash(userId, input);
    let sharedChange = false;
    const result = await this.transaction(async tx => {
      const member = await this.member(tx, input.householdId, userId, true);
      const [prior] = await tx.select().from(schema.loanSnapshots).where(and(eq(schema.loanSnapshots.id, input.requestId),
        eq(schema.loanSnapshots.householdId, input.householdId), eq(schema.loanSnapshots.ownerUserId, userId))).limit(1);
      const [existing] = await tx.select().from(schema.loanRecords).where(and(eq(schema.loanRecords.id, input.recordId),
        eq(schema.loanRecords.householdId, input.householdId), eq(schema.loanRecords.ownerUserId, userId))).for('update').limit(1);
      if (prior) {
        if (prior.payloadHash !== payloadHash || prior.recordId !== input.recordId || !existing || existing.deletedAt !== null) throw stale();
        // Replay never reapplies old sharing/mapping choices or restores a deleted record.
        return this.result(tx, userId, input.householdId, existing, member);
      }
      checkCaptureTime(input.capture.capturedAt);
      if (existing && existing.deletedAt !== null) throw stale();
      if (existing) {
        if (existing.accountFingerprint !== input.capture.accountFingerprint || existing.accountLast4 !== input.capture.accountLast4
          || existing.loanType !== input.capture.loanType) throw stale();
        const previous = (await this.snapshots(tx, [existing])).get(existing.id)!;
        if (Date.parse(input.capture.capturedAt) < previous.capturedAt.getTime()) throw stale();
      } else if (input.expectedVersion !== null) throw stale();
      const version = existing ? nextVersion(existing.version, input.expectedVersion) : 1;
      await this.checkReplacement(tx, userId, input.householdId, input);
      const wasShared = existing ? await this.currentlyShared(tx, existing) : false;
      const fields = reviewFields(input, member), now = new Date();
      let row: LoanRow | undefined;
      if (existing) {
        [row] = await tx.update(schema.loanRecords).set({ ...fields, version, updatedAt: now })
          .where(and(eq(schema.loanRecords.id, existing.id), eq(schema.loanRecords.version, existing.version),
            eq(schema.loanRecords.ownerUserId, userId), isNull(schema.loanRecords.deletedAt))).returning();
      } else {
        [row] = await tx.insert(schema.loanRecords).values({ id: input.recordId, householdId: input.householdId, ownerUserId: userId,
          accountFingerprint: input.capture.accountFingerprint, accountLast4: input.capture.accountLast4, loanType: input.capture.loanType,
          ...fields, version, createdAt: now, updatedAt: now }).returning();
      }
      if (!row) throw stale();
      await tx.insert(schema.loanSnapshots).values({ id: input.requestId, recordId: row.id, householdId: input.householdId,
        ownerUserId: userId, outstandingPrincipalKrw: input.capture.outstandingPrincipalKrw, maturityDate: input.capture.maturityDate,
        capturedAt: new Date(input.capture.capturedAt), source: 'browser_assisted', formatVersion: 1,
        payloadHash, recordVersion: version });
      sharedChange = wasShared || row.visibility === 'household';
      return this.result(tx, userId, input.householdId, row, member);
    });
    if (sharedChange) this.publish(input.householdId);
    return result;
  }

  async update(user: string, household: string, identifier: string, request: LoanImportUpdateRequest): Promise<LoanImportRecordResponse> {
    const userId = actor(user), query = parse(querySchema, { householdId: household, id: identifier });
    const input = parse(loanImportUpdateRequestSchema, request), householdId = query.householdId.toLowerCase(), id = query.id!.toLowerCase();
    let sharedChange = false;
    const result = await this.transaction(async tx => {
      const member = await this.member(tx, householdId, userId, true);
      const [existing] = await tx.select().from(schema.loanRecords).where(and(eq(schema.loanRecords.id, id),
        eq(schema.loanRecords.householdId, householdId), eq(schema.loanRecords.ownerUserId, userId), isNull(schema.loanRecords.deletedAt)))
        .for('update').limit(1);
      if (!existing) throw missing();
      const version = nextVersion(existing.version, input.expectedVersion);
      await this.checkReplacement(tx, userId, householdId, input);
      const wasShared = await this.currentlyShared(tx, existing);
      const [row] = await tx.update(schema.loanRecords).set({ ...reviewFields(input, member), version, updatedAt: new Date() })
        .where(and(eq(schema.loanRecords.id, id), eq(schema.loanRecords.version, existing.version),
          eq(schema.loanRecords.ownerUserId, userId), isNull(schema.loanRecords.deletedAt))).returning();
      if (!row) throw stale();
      sharedChange = wasShared || row.visibility === 'household';
      return this.result(tx, userId, householdId, row, member);
    });
    if (sharedChange) this.publish(householdId);
    return result;
  }

  async remove(user: string, household: string, identifier: string, request: LoanImportDeleteRequest): Promise<{ deleted: boolean }> {
    const userId = actor(user), query = parse(querySchema, { householdId: household, id: identifier });
    const input = parse(loanImportDeleteRequestSchema, request), householdId = query.householdId.toLowerCase(), id = query.id!.toLowerCase();
    let sharedChange = false;
    const result = await this.transaction(async tx => {
      await this.member(tx, householdId, userId, true);
      const [existing] = await tx.select().from(schema.loanRecords).where(and(eq(schema.loanRecords.id, id),
        eq(schema.loanRecords.householdId, householdId), eq(schema.loanRecords.ownerUserId, userId))).for('update').limit(1);
      if (!existing) throw missing();
      if (existing.deletedAt !== null) {
        if (existing.version !== input.expectedVersion + 1) throw stale();
        return { deleted: true };
      }
      const version = nextVersion(existing.version, input.expectedVersion), now = new Date();
      const wasShared = await this.currentlyShared(tx, existing);
      const [row] = await tx.update(schema.loanRecords).set({ deletedAt: now, updatedAt: now, version,
        visibility: 'private', sharedMemberId: null, sharedJoinedAt: null,
        totalMode: 'reference', replacesManualAssetId: null, manualExpectedVersion: null })
        .where(and(eq(schema.loanRecords.id, id), eq(schema.loanRecords.ownerUserId, userId),
          eq(schema.loanRecords.version, existing.version), isNull(schema.loanRecords.deletedAt))).returning();
      if (!row) throw stale();
      sharedChange = wasShared;
      return { deleted: true };
    });
    if (sharedChange) this.publish(householdId);
    return result;
  }
}
