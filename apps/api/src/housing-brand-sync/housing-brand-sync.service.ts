import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Inject,
  Injectable, NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  housingBrandApplyRequestSchema, housingBrandConnectRequestSchema, housingBrandStoredPreviewSchema,
  housingBrandSyncRequestSchema,
  type HousingBrandApplyRequest, type HousingBrandConnectRequest, type HousingBrandConnectResponse,
  type HousingBrandConnection, type HousingBrandFetchedItem, type HousingBrandStoredPreview,
  type HousingBrandSyncPreview, type HousingBrandSyncRequest, type ManualHousingPayment,
  type ManualHousingPlanResponse,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { DB } from '../database/database.constants';
import { FinanceVault, type VaultContext } from '../finance-connections/finance-vault';
import { SujainBrowserClient, SujainBrowserError } from './sujain-browser';
import { matchFetchedItems } from './sujain-parse';

type Executor = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;
type ConnectionRow = typeof schema.housingBrandConnections.$inferSelect;
type PaymentRow = typeof schema.manualHousingPayments.$inferSelect;
type PlanRow = typeof schema.manualHousingPlans.$inferSelect;

const WRITER_ROLES = new Set<schema.HouseholdMember['role']>(['owner', 'admin', 'member']);
const householdPlanQuery = z.object({ householdId: z.string().uuid(), planId: z.string().uuid() }).strict();

const stale = () => new ConflictException({
  code: 'housing_brand_stale',
  message: '기록이 변경됐어요. 최신 내용을 다시 확인해 주세요.',
});
const notFound = () => new NotFoundException('주택 또는 연결을 찾을 수 없습니다.');

function parse<T>(contract: z.ZodType<T>, input: unknown): T {
  const result = contract.safeParse(input);
  if (!result.success) throw new BadRequestException('입력한 값과 미입력 항목을 확인해 주세요.');
  return result.data;
}

function actorId(value: string): string {
  if (!z.string().uuid().safeParse(value).success) throw new UnauthorizedException('unauthorized');
  return value.toLowerCase();
}

function loginFingerprint(loginId: string): string {
  return createHash('sha256').update(`sujain:${loginId.toLowerCase()}`).digest('hex');
}

function vaultContext(ownerUserId: string, connectionId: string): VaultContext {
  return { ownerUserId, provider: 'sujain', connectionId, purpose: 'credentials' };
}

/** Asia/Seoul YYYY-MM-DD HH:mm */
export function formatSeoulMinute(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function paymentStatus(amount: string | null, paidAmount: string | null): ManualHousingPayment['status'] {
  if (amount === null || paidAmount === null) return 'unknown';
  const remaining = BigInt(amount) - BigInt(paidAmount);
  if (remaining <= 0n) return 'paid';
  if (BigInt(paidAmount) > 0n) return 'partial';
  return 'unpaid';
}

function remainingAmount(amount: string | null, paidAmount: string | null): string | null {
  if (amount === null || paidAmount === null) return null;
  const left = BigInt(amount) - BigInt(paidAmount);
  return left < 0n ? '0' : left.toString();
}

function toPayment(row: PaymentRow): ManualHousingPayment {
  return {
    id: row.id,
    planId: row.planId,
    kind: row.kind,
    installment: row.installment,
    label: row.label,
    dueDate: row.dueDate,
    amount: row.amount,
    amountSource: row.amountSource,
    amountAsOfAt: row.amountAsOfAt?.toISOString() ?? null,
    amountAsOfSeoul: row.amountAsOfAt ? formatSeoulMinute(row.amountAsOfAt) : null,
    paidAmount: row.paidAmount,
    paidAmountSource: row.paidAmountSource,
    paidAmountAsOfAt: row.paidAmountAsOfAt?.toISOString() ?? null,
    paidAmountAsOfSeoul: row.paidAmountAsOfAt ? formatSeoulMinute(row.paidAmountAsOfAt) : null,
    paidDate: row.paidDate,
    remainingAmount: remainingAmount(row.amount, row.paidAmount),
    status: paymentStatus(row.amount, row.paidAmount),
  };
}

function toConnection(row: ConnectionRow, viewerUserId: string): HousingBrandConnection {
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
    canManage: row.ownerUserId === viewerUserId && row.disconnectedAt === null,
  };
}

function publicErrorMessage(code: string): string {
  switch (code) {
    case 'credentials_invalid':
      return '수자인 로그인에 실패했어요. 아이디와 비밀번호를 다시 확인해 주세요.';
    case 'authentication_required':
      return '추가 인증이 필요해요. 공식 수자인 페이지에서 이어서 확인해 주세요.';
    case 'network_error':
      return '수자인 페이지에 연결하지 못했어요. 잠시 후 다시 눌러 주세요.';
    case 'unsupported_layout':
      return '수자인 표 구성을 읽지 못했어요. 못 읽은 칸은 비워 두었어요.';
    case 'runtime_unavailable':
      return '신축 조회 실행 환경이 준비되지 않았어요.';
    case 'not_connected':
      return '이 주택에 연결된 수자인 계정이 없어요.';
    default:
      return '수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.';
  }
}

@Injectable()
export class HousingBrandSyncService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vault: FinanceVault,
    private readonly browser: SujainBrowserClient,
  ) {}

  private async transaction<T>(run: (tx: Executor) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(run);
    } catch (error) {
      let cause: unknown = error;
      for (let i = 0; i < 4 && cause !== null && typeof cause === 'object'; i += 1) {
        const detail = cause as { code?: unknown; cause?: unknown };
        if (['23505', '40001', '40P01', '55P03'].includes(String(detail.code))) throw stale();
        cause = detail.cause;
      }
      if (error instanceof HttpException) throw error;
      throw error;
    }
  }

  private async member(tx: Executor, householdId: string, userId: string, write = false) {
    const [member] = await tx.select({
      id: schema.householdMembers.id,
      role: schema.householdMembers.role,
    }).from(schema.householdMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.householdMembers.userId))
      .where(and(
        eq(schema.householdMembers.householdId, householdId),
        eq(schema.householdMembers.userId, userId),
        eq(schema.householdMembers.status, 'active'),
        isNull(schema.users.deletedAt),
      )).limit(1);
    if (!member) throw new ForbiddenException('not a household member');
    if (write && !WRITER_ROLES.has(member.role)) {
      throw new ForbiddenException('조회 전용 구성원은 연결을 변경할 수 없습니다.');
    }
    return member;
  }

  private async ownedPlan(tx: Executor, householdId: string, planId: string, userId: string): Promise<PlanRow> {
    const [plan] = await tx.select().from(schema.manualHousingPlans).where(and(
      eq(schema.manualHousingPlans.id, planId),
      eq(schema.manualHousingPlans.householdId, householdId),
      eq(schema.manualHousingPlans.ownerUserId, userId),
      isNull(schema.manualHousingPlans.deletedAt),
    )).for('update').limit(1);
    if (!plan) throw notFound();
    return plan;
  }

  async connectionForPlan(
    tx: Executor,
    planId: string,
    userId: string,
  ): Promise<HousingBrandConnection | null> {
    const [row] = await tx.select().from(schema.housingBrandConnections).where(and(
      eq(schema.housingBrandConnections.planId, planId),
      eq(schema.housingBrandConnections.ownerUserId, userId),
      isNull(schema.housingBrandConnections.disconnectedAt),
    )).limit(1);
    return row ? toConnection(row, userId) : null;
  }

  /** 연결한 본인에게만 붙인다. */
  async attachConnection(
    plan: ManualHousingPlanResponse,
    userId: string,
  ): Promise<ManualHousingPlanResponse> {
    if (plan.item.ownerUserId !== userId) return { ...plan, brandConnection: null };
    const connection = await this.transaction(async (tx) => this.connectionForPlan(tx, plan.item.id, userId));
    return { ...plan, brandConnection: connection };
  }

  async connect(
    user: string,
    planIdRaw: string,
    request: HousingBrandConnectRequest,
  ): Promise<HousingBrandConnectResponse> {
    const userId = actorId(user);
    const input = parse(housingBrandConnectRequestSchema, request);
    const query = parse(householdPlanQuery, { householdId: input.householdId, planId: planIdRaw });
    const householdId = query.householdId.toLowerCase();
    const planId = query.planId.toLowerCase();
    if (!this.vault.enabled) {
      throw new BadRequestException('신축 조회 금고가 준비되지 않았어요.');
    }

    const fingerprint = loginFingerprint(input.loginId);
    let loginId = input.loginId;
    let password = input.password;
    try {
      return await this.transaction(async (tx) => {
        await this.member(tx, householdId, userId, true);
        const plan = await this.ownedPlan(tx, householdId, planId, userId);
        if (plan.version !== input.expectedPlanVersion) throw stale();

        const [existing] = await tx.select().from(schema.housingBrandConnections).where(and(
          eq(schema.housingBrandConnections.planId, planId),
          isNull(schema.housingBrandConnections.disconnectedAt),
        )).for('update').limit(1);

        const now = new Date();
        const connectionId = existing?.ownerUserId === userId ? existing.id : randomUUID();
        if (existing && existing.ownerUserId !== userId) throw new ForbiddenException('연결한 본인만 볼 수 있어요.');

        const envelope = this.vault.encrypt(
          { loginId, password, brand: 'sujain' as const },
          vaultContext(userId, connectionId),
        );
        // Clear locals before returning; envelope holds ciphertext only.
        loginId = '';
        password = '';

        if (existing) {
          const version = existing.version + 1;
          const [row] = await tx.update(schema.housingBrandConnections).set({
            brand: 'sujain',
            loginFingerprint: fingerprint,
            credentials: envelope,
            status: 'connected',
            statusMessage: null,
            version,
            updatedAt: now,
            disconnectedAt: null,
          }).where(and(
            eq(schema.housingBrandConnections.id, existing.id),
            eq(schema.housingBrandConnections.version, existing.version),
          )).returning();
          if (!row) throw stale();
          return { connection: toConnection(row, userId) };
        }

        const [row] = await tx.insert(schema.housingBrandConnections).values({
          id: connectionId,
          planId,
          householdId,
          ownerUserId: userId,
          brand: 'sujain',
          loginFingerprint: fingerprint,
          credentials: envelope,
          status: 'connected',
          statusMessage: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        }).returning();
        return { connection: toConnection(row!, userId) };
      });
    } finally {
      loginId = '';
      password = '';
    }
  }

  async sync(
    user: string,
    planIdRaw: string,
    request: HousingBrandSyncRequest,
  ): Promise<HousingBrandSyncPreview> {
    const userId = actorId(user);
    const input = parse(housingBrandSyncRequestSchema, request);
    const query = parse(householdPlanQuery, { householdId: input.householdId, planId: planIdRaw });
    const householdId = query.householdId.toLowerCase();
    const planId = query.planId.toLowerCase();

    const prepared = await this.transaction(async (tx) => {
      await this.member(tx, householdId, userId, true);
      await this.ownedPlan(tx, householdId, planId, userId);
      const [connection] = await tx.select().from(schema.housingBrandConnections).where(and(
        eq(schema.housingBrandConnections.planId, planId),
        eq(schema.housingBrandConnections.ownerUserId, userId),
        isNull(schema.housingBrandConnections.disconnectedAt),
      )).for('update').limit(1);
      if (!connection || !connection.credentials) {
        throw new BadRequestException(publicErrorMessage('not_connected'));
      }
      if (connection.version !== input.expectedConnectionVersion) throw stale();
      if (!this.vault.enabled) throw new BadRequestException(publicErrorMessage('runtime_unavailable'));

      let decoded: { loginId: string; password: string } | undefined;
      try {
        decoded = this.vault.decrypt<{ loginId: string; password: string }>(
          connection.credentials,
          vaultContext(userId, connection.id),
        );
      } catch {
        throw new BadRequestException(publicErrorMessage('operation_unknown'));
      }
      const payments = await tx.select().from(schema.manualHousingPayments)
        .where(eq(schema.manualHousingPayments.planId, planId))
        .orderBy(asc(schema.manualHousingPayments.position), asc(schema.manualHousingPayments.id));
      return { connection, decoded, payments };
    });

    const credentials = prepared.decoded;
    const controller = new AbortController();
    try {
      let capture: { capturedAt: string; rows: Parameters<SujainBrowserClient['parseRows']>[0] };
      try {
        capture = await this.browser.read(credentials, controller.signal);
      } catch (error) {
        const code = error instanceof SujainBrowserError ? error.code : 'operation_unknown';
        await this.markFailure(prepared.connection.id, prepared.connection.version, code);
        throw new BadRequestException(publicErrorMessage(code));
      } finally {
        credentials.loginId = '';
        credentials.password = '';
      }

      const parsed = this.browser.parseRows(capture.rows);
      const matched = matchFetchedItems(parsed.items, prepared.payments.map((payment) => ({
        id: payment.id,
        kind: payment.kind,
        installment: payment.installment,
        label: payment.label,
        amount: payment.amount,
        dueDate: payment.dueDate,
        paidAmount: payment.paidAmount,
        paidDate: payment.paidDate,
      })));

      const fetchedAt = new Date(capture.capturedAt);
      const storedPreview: HousingBrandStoredPreview = {
        fetchedAt: fetchedAt.toISOString(),
        items: matched,
      };
      const connection = await this.transaction(async (tx) => {
        const status = matched.length > 0 ? 'needs_confirmation' as const : 'connected' as const;
        const [row] = await tx.update(schema.housingBrandConnections).set({
          status,
          statusMessage: matched.length > 0
            ? '가져온 납부·옵션을 확인한 뒤 반영할 항목을 골라 주세요.'
            : null,
          lastFetchAt: fetchedAt,
          lastSuccessAt: fetchedAt,
          lastPreview: storedPreview,
          updatedAt: new Date(),
          version: prepared.connection.version + 1,
        }).where(and(
          eq(schema.housingBrandConnections.id, prepared.connection.id),
          eq(schema.housingBrandConnections.version, prepared.connection.version),
        )).returning();
        if (!row) throw stale();
        return toConnection(row, userId);
      });

      return {
        fetchedAt: storedPreview.fetchedAt,
        fetchedAtSeoul: formatSeoulMinute(fetchedAt),
        source: 'sujain_fetch',
        items: matched,
        unreadCount: parsed.unreadCount,
        unreadReasons: parsed.unreadReasons,
        connection,
      };
    } finally {
      credentials.loginId = '';
      credentials.password = '';
    }
  }

  private async markFailure(connectionId: string, version: number, code: string): Promise<void> {
    await this.db.update(schema.housingBrandConnections).set({
      status: code === 'authentication_required' ? 'needs_confirmation' : 'failed',
      statusMessage: publicErrorMessage(code),
      lastFetchAt: new Date(),
      updatedAt: new Date(),
      version: version + 1,
    }).where(and(
      eq(schema.housingBrandConnections.id, connectionId),
      eq(schema.housingBrandConnections.version, version),
    ));
  }

  async apply(
    user: string,
    planIdRaw: string,
    request: HousingBrandApplyRequest,
  ): Promise<ManualHousingPlanResponse> {
    const userId = actorId(user);
    const input = parse(housingBrandApplyRequestSchema, request);
    const query = parse(householdPlanQuery, { householdId: input.householdId, planId: planIdRaw });
    const householdId = query.householdId.toLowerCase();
    const planId = query.planId.toLowerCase();
    const selectedKeys = [...new Set(input.selections.map((item) => item.key))];

    return this.transaction(async (tx) => {
      await this.member(tx, householdId, userId, true);
      const plan = await this.ownedPlan(tx, householdId, planId, userId);
      if (plan.version !== input.expectedPlanVersion) throw stale();

      const [connection] = await tx.select().from(schema.housingBrandConnections).where(and(
        eq(schema.housingBrandConnections.planId, planId),
        eq(schema.housingBrandConnections.ownerUserId, userId),
        isNull(schema.housingBrandConnections.disconnectedAt),
      )).for('update').limit(1);
      if (!connection) throw new BadRequestException(publicErrorMessage('not_connected'));
      if (connection.version !== input.expectedConnectionVersion) throw stale();

      const preview = housingBrandStoredPreviewSchema.safeParse(connection.lastPreview);
      if (!preview.success || preview.data.items.length === 0) {
        throw new BadRequestException('확인할 미리보기가 없어요. 확인이나 새로고침을 다시 눌러 주세요.');
      }
      const itemByKey = new Map(preview.data.items.map((item) => [item.key, item]));

      const existing = await tx.select().from(schema.manualHousingPayments)
        .where(eq(schema.manualHousingPayments.planId, planId))
        .orderBy(asc(schema.manualHousingPayments.position), asc(schema.manualHousingPayments.id));
      const asOf = new Date(preview.data.fetchedAt);
      const nextRows = existing.map((row) => ({ ...row }));
      let position = existing.length;

      for (const key of selectedKeys) {
        const fetched = itemByKey.get(key);
        if (!fetched) throw new BadRequestException('확인 목록에서 고른 항목을 찾지 못했어요.');
        const fields = applyFieldsFromPreview(fetched);
        if (fields.length === 0) continue;

        if (fetched.matchedPaymentId) {
          const index = nextRows.findIndex((row) => row.id === fetched.matchedPaymentId);
          if (index < 0) throw new BadRequestException('반영할 납부 일정을 찾지 못했어요.');
          nextRows[index] = applySelection(nextRows[index]!, fetched, fields, asOf);
        } else {
          nextRows.push(applySelection({
            id: randomUUID(),
            planId,
            position: position++,
            kind: fetched.kind,
            installment: fetched.installment,
            label: fetched.label,
            dueDate: null,
            amount: null,
            amountSource: null,
            amountAsOfAt: null,
            paidAmount: null,
            paidAmountSource: null,
            paidAmountAsOfAt: null,
            paidDate: null,
          }, fetched, fields, asOf));
        }
      }

      // 기존 계약금·중도금·잔금·옵션은 삭제하지 않고 전체 교체로 유지한다.
      await tx.delete(schema.manualHousingPayments).where(eq(schema.manualHousingPayments.planId, planId));
      if (nextRows.length > 0) {
        await tx.insert(schema.manualHousingPayments).values(nextRows.map((row, index) => ({
          ...row,
          position: index,
        })));
      }

      const planVersion = plan.version + 1;
      const [updatedPlan] = await tx.update(schema.manualHousingPlans).set({
        version: planVersion,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.manualHousingPlans.id, planId),
        eq(schema.manualHousingPlans.version, plan.version),
      )).returning();
      if (!updatedPlan) throw stale();

      const [updatedConnection] = await tx.update(schema.housingBrandConnections).set({
        status: 'connected',
        statusMessage: null,
        lastPreview: null,
        version: connection.version + 1,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.housingBrandConnections.id, connection.id),
        eq(schema.housingBrandConnections.version, connection.version),
      )).returning();
      if (!updatedConnection) throw stale();

      const payments = (await tx.select().from(schema.manualHousingPayments)
        .where(eq(schema.manualHousingPayments.planId, planId))
        .orderBy(asc(schema.manualHousingPayments.position), asc(schema.manualHousingPayments.id)))
        .map(toPayment);

      return {
        item: {
          id: updatedPlan.id,
          householdId: updatedPlan.householdId,
          ownerUserId: updatedPlan.ownerUserId,
          label: updatedPlan.label,
          visibility: updatedPlan.visibility,
          occupancyYear: updatedPlan.occupancyYear,
          contractStage: updatedPlan.contractStage,
          fundingNote: updatedPlan.fundingNote,
          version: updatedPlan.version,
          createdAt: updatedPlan.createdAt.toISOString(),
          updatedAt: updatedPlan.updatedAt.toISOString(),
          canEdit: true,
        },
        payments,
        brandConnection: toConnection(updatedConnection, userId),
      };
    });
  }
}

type ApplyField = 'scheduledAmount' | 'dueDate' | 'paidAmount' | 'paidDate' | 'label' | 'installment';

function applyFieldsFromPreview(fetched: HousingBrandFetchedItem): ApplyField[] {
  const allowed = new Set<ApplyField>([
    'scheduledAmount', 'dueDate', 'paidAmount', 'paidDate', 'label', 'installment',
  ]);
  const fromChanged = fetched.changedFields.filter((field): field is ApplyField => allowed.has(field as ApplyField));
  if (fromChanged.length > 0) return fromChanged;
  const fallback: ApplyField[] = [];
  if (fetched.scheduledAmount !== null) fallback.push('scheduledAmount');
  if (fetched.dueDate !== null) fallback.push('dueDate');
  if (fetched.paidAmount !== null) fallback.push('paidAmount');
  if (fetched.actualPaidDate !== null || fetched.paidDate !== null) fallback.push('paidDate');
  if (fetched.label !== null) fallback.push('label');
  if (fetched.installment !== null) fallback.push('installment');
  return fallback;
}

function applySelection(
  current: PaymentRow,
  fetched: HousingBrandFetchedItem,
  fields: ApplyField[],
  asOf: Date,
): PaymentRow {
  const next = { ...current, kind: fetched.kind };
  for (const field of fields) {
    if (field === 'scheduledAmount') {
      if (fetched.scheduledAmount === null) continue;
      // 사람이 적어 둔 값이 있어도 고른 뒤에만 덮는다.
      next.amount = fetched.scheduledAmount;
      next.amountSource = 'confirmed';
      next.amountAsOfAt = asOf;
    }
    if (field === 'dueDate' && fetched.dueDate !== null) next.dueDate = fetched.dueDate;
    if (field === 'paidAmount' && fetched.paidAmount !== null) {
      next.paidAmount = fetched.paidAmount;
      next.paidAmountSource = 'confirmed';
      next.paidAmountAsOfAt = asOf;
    }
    if (field === 'paidDate') {
      const paidDate = fetched.actualPaidDate ?? fetched.paidDate;
      if (paidDate !== null) next.paidDate = paidDate;
    }
    if (field === 'label' && fetched.label !== null) next.label = fetched.label;
    if (field === 'installment' && fetched.installment !== null) next.installment = fetched.installment;
  }
  return next;
}
