import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, InternalServerErrorException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { schema } from '@family/database';
import type { ManualAssetCreateRequest, ManualHousingPlanCreateRequest } from '@family/contracts';
import { ManualFinanceController } from './manual-finance.controller';
import { ManualFinanceService } from './manual-finance.service';
import { HouseholdService } from '../household/household.service';

const H = '11111111-1111-4111-8111-111111111111';
const H2 = '11111111-1111-4111-8111-111111111112';
const U = '22222222-2222-4222-8222-222222222222';
const O = '22222222-2222-4222-8222-222222222223';
const A = '33333333-3333-4333-8333-333333333333';
const P = '44444444-4444-4444-8444-444444444444';
const PAY = '55555555-5555-4555-8555-555555555555';
const M = '66666666-6666-4666-8666-666666666666';
const MO = '66666666-6666-4666-8666-666666666667';
const AT = '2026-01-01T00:00:00.000Z';
type Row = Record<string, unknown>;
const tables = [schema.users, schema.households, schema.householdMembers, schema.manualAssets,
  schema.manualHousingPlans, schema.manualHousingPayments, schema.manualFinanceAudit,
  schema.housingBrandConnections,
  schema.loanRecords, schema.loanSnapshots,
  schema.registeredDevices, schema.deviceCredentials, schema.householdConsents];
const tableMap = new Map<string, Table>(tables.map(table => [getTableName(table), table as Table]));
const assetInput = (extra: Partial<ManualAssetCreateRequest> = {}): ManualAssetCreateRequest => ({
  id: A, householdId: H, kind: 'account', label: '합성 통장', visibility: 'private',
  amount: null, asOfDate: null, source: null, legalOwnerLabel: null, note: null, ...extra,
});
const planInput = (extra: Partial<ManualHousingPlanCreateRequest> = {}): ManualHousingPlanCreateRequest => ({
  id: P, householdId: H, label: '합성 주택 계획', visibility: 'private', occupancyYear: null,
  contractStage: null, fundingNote: null, payments: [{ id: PAY, kind: 'balance', installment: null,
    dueDate: null, amount: null, paidAmount: null, paidDate: null }], ...extra,
});

/** Real Drizzle SQL/decoding, with a bounded synthetic driver; no DB or network. */
function setup() {
  const rows: Record<string, Row[]> = Object.fromEntries(tables.map(table => [getTableName(table), []]));
  rows.users = [{ id: U, name: '합성 작성자', email: 'a@example.invalid', deletedAt: null },
    { id: O, name: '합성 가족', email: 'b@example.invalid', deletedAt: null }];
  rows.households = [{ id: H, deletedAt: null }];
  rows.household_members = [
    { id: M, householdId: H, userId: U, role: 'owner', status: 'active', joinedAt: AT, createdAt: AT, updatedAt: AT },
    { id: MO, householdId: H, userId: O, role: 'member', status: 'active', joinedAt: AT, createdAt: AT, updatedAt: AT },
  ];
  const queries: Array<{ sql: string; params: unknown[]; transaction: boolean }> = [];
  let auditFailure = false;
  let beforeNextTransaction: (() => void) | undefined;
  const transactionState = { active: false, commits: 0, rollbacks: 0 };
  const publisher = { publish: vi.fn(async (_householdId: string, _type: string) => {}) };
  const values = (name: string, row: Row, query: string) => {
    if (query.startsWith('select "household_members"."id", "household_members"."role" from')) return [row.id, row.role];
    if (/returning "id", "version"$/.test(query)) return [row.id, row.version];
    if (/^(?:select|.*returning) (?:"household_members"\.)?"id"(?: from|$)/.test(query)
      || /^(?:select|.*returning) (?:"households"\.)?"id"(?: from|$)/.test(query)) return [row.id];
    const table = tableMap.get(name)!;
    return Object.keys(getTableColumns(table)).map(key => row[key] ?? null);
  };
  const columns = (name: string) => Object.entries(getTableColumns(tableMap.get(name)!));
  const keyOf = (name: string, column: string) => columns(name).find(([, value]) => value.name === column)?.[0] ?? column;
  function bound(query: string, name: string, key: string, params: unknown[]) {
    const column = columns(name).find(([prop]) => prop === key)?.[1].name ?? key;
    const match = query.match(new RegExp('"' + name + '"\\."' + column + '" = \\$(\\d+)'));
    return match ? params[Number(match[1]) - 1] : undefined;
  }
  function matches(name: string, row: Row, query: string, params: unknown[]): boolean {
    const where = query.includes(' where ') ? query.slice(query.indexOf(' where ') + 7) : '';
    for (const key of ['id', 'householdId']) {
      const value = bound(where, name, key, params);
      if (value !== undefined && row[key] !== value) return false;
    }
    if (name === 'household_members') {
      const user = bound(where, name, 'userId', params);
      if (user !== undefined && row.userId !== user) return false;
      const status = bound(where, name, 'status', params);
      if (status !== undefined && row.status !== status) return false;
      if (query.includes('inner join "users"') && rows.users.some(u => u.id === row.userId && u.deletedAt !== null)) return false;
    }
    if (where.includes('"' + name + '"."deleted_at" is null') && row.deletedAt !== null) return false;
    if (name === 'manual_assets' || name === 'manual_housing_plans' || name === 'loan_records') {
      const owner = bound(where, name, 'ownerUserId', params), visibility = bound(where, name, 'visibility', params);
      if (where.includes(' or ') && visibility !== undefined && owner !== undefined) {
        if (row.visibility !== visibility && row.ownerUserId !== owner) return false;
      } else {
        if (owner !== undefined && row.ownerUserId !== owner) return false;
        if (visibility !== undefined && row.visibility !== visibility) return false;
      }
      const version = bound(where, name, 'version', params);
      if (version !== undefined && row.version !== version) return false;
      if (where.includes('exists (select 1') && !rows.household_members.some(m => m.householdId === row.householdId
        && m.userId === row.ownerUserId && m.status === 'active' && rows.users.some(u => u.id === m.userId && u.deletedAt === null))) return false;
    }
    if (name === 'manual_housing_payments') {
      const plan = bound(where, name, 'planId', params);
      if (plan !== undefined && row.planId !== plan) return false;
      if (where.includes(' in (') && !params.includes(row.planId)) return false;
    }
    return true;
  }
  function execute(query: string, params: unknown[]): unknown[][] {
    if (query.startsWith('set transaction')) return [];
    const name = query.match(/^(?:select .*? from |insert into |update |delete from )"([^"]+)"/s)?.[1];
    if (!name || !tableMap.has(name)) throw new Error('unexpected synthetic query');
    if (query.startsWith('select')) return rows[name]!.filter(row => matches(name, row, query, params)).map(row => values(name, row, query));
    if (query.startsWith('insert')) {
      if (name === 'manual_finance_audit' && auditFailure) throw new Error('synthetic audit failure');
      const match = query.match(/\(([^)]+)\) values (.*?)(?: on conflict| returning|$)/s)!;
      const names = match[1]!.split(', ').map(value => value.replaceAll('"', ''));
      const inserted: Row[] = [];
      for (const tuple of match[2]!.matchAll(/\(([^)]+)\)/g)) {
        const row: Row = {};
        tuple[1]!.split(', ').forEach((token, index) => {
          const key = keyOf(name, names[index]!), param = token.match(/^\$(\d+)/);
          row[key] = param ? params[Number(param[1]) - 1] : key === 'id' ? randomUUID()
            : key === 'createdAt' || key === 'updatedAt' ? AT : key === 'version' ? 1 : null;
        });
        if (rows[name]!.some(existing => existing.id === row.id)) {
          if (query.includes('on conflict')) continue;
          throw Object.assign(new Error('synthetic unique collision'), { code: '23505' });
        }
        if (name === 'manual_finance_audit' && rows[name]!.some(existing => existing.entityType === row.entityType
          && existing.entityId === row.entityId && existing.version === row.version && existing.action === row.action)) {
          throw Object.assign(new Error('synthetic audit duplicate'), { code: '23505' });
        }
        rows[name]!.push(row); inserted.push(row);
      }
      return query.includes('returning') ? inserted.map(row => values(name, row, query)) : [];
    }
    const selected = rows[name]!.filter(row => matches(name, row, query, params));
    if (query.startsWith('delete')) { rows[name] = rows[name]!.filter(row => !selected.includes(row)); return []; }
    const assignments = query.match(/ set (.*?) where /s)?.[1] ?? '';
    for (const row of selected) for (const match of assignments.matchAll(/"([^"]+)" = (\$\d+|CASE WHEN "[^"]+"\."version" < 2147483647 THEN "[^"]+"\."version" \+ 1 ELSE "[^"]+"\."version" END)/gi)) {
      const key = keyOf(name, match[1]!), token = match[2]!;
      row[key] = token.startsWith('$') ? params[Number(token.slice(1)) - 1] : Math.min(Number(row.version) + 1, 2_147_483_647);
    }
    return query.includes('returning') ? selected.map(row => values(name, row, query)) : [];
  }
  const unsafe = (transaction: boolean) => (query: string, params: unknown[]) => {
    queries.push({ sql: query, params, transaction });
    const result = Promise.resolve().then(() => execute(query, params));
    return Object.assign(result, { values: () => result });
  };
  const driver = { options: { parsers: {}, serializers: {} }, unsafe: unsafe(false),
    async begin<T>(callback: (client: unknown) => Promise<T>): Promise<T> {
      const beforeRun = beforeNextTransaction; beforeNextTransaction = undefined; beforeRun?.();
      const before = structuredClone(rows);
      transactionState.active = true;
      try { const result = await callback({ ...driver, unsafe: unsafe(true) });
        transactionState.active = false; transactionState.commits += 1; return result; }
      catch (error) { transactionState.active = false; transactionState.rollbacks += 1;
        for (const key of Object.keys(rows)) rows[key] = before[key]!; throw error; }
    } };
  const db = drizzle(driver as unknown as postgres.Sql, { schema });
  return { db, service: new ManualFinanceService(db, publisher as never), household: new HouseholdService(db, {} as never, publisher as never), rows, queries,
    publisher, transactionState, beforeTransaction: (run: () => void) => { beforeNextTransaction = run; },
    failAudit: () => { auditFailure = true; } };
}

describe('authenticated manual finance surface', () => {
  it('keeps the controller under normal global authentication and validated dedicated routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ManualFinanceController)).toBe('manual-finance');
    for (const key of ['listAssets', 'getAsset', 'createAsset', 'updateAsset', 'deleteAsset', 'listPlans', 'getPlan', 'createPlan', 'updatePlan', 'deletePlan']) {
      expect(Reflect.getMetadata(METHOD_METADATA, ManualFinanceController.prototype[key as keyof ManualFinanceController])).toBeDefined();
      expect(Reflect.getMetadata('isPublic', ManualFinanceController.prototype[key as keyof ManualFinanceController])).toBeUndefined();
    }
  });
  it('rejects missing authentication and invalid requests without starting queries', async () => {
    const { service, queries } = setup();
    await expect(service.listAssets('', { householdId: H, scope: 'household' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.createAsset(U, { ...assetInput(), amount: '1.5' })).rejects.toBeInstanceOf(BadRequestException);
    expect(queries).toEqual([]);
  });
  it.each(['removed', 'invited'])('rejects %s membership before reading manual records', async status => {
    const { service, rows, queries } = setup(); rows.household_members[0]!.status = status;
    await expect(service.listAssets(U, { householdId: H, scope: 'household' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(queries.some(query => query.sql.includes('from "manual_assets"'))).toBe(false);
  });
  it('rejects a non-member, deleted user and soft-deleted household', async () => {
    for (const mode of ['nonmember', 'deleted-user', 'deleted-household']) {
      const { service, rows } = setup();
      if (mode === 'nonmember') rows.household_members = [];
      if (mode === 'deleted-user') rows.users[0]!.deletedAt = AT;
      if (mode === 'deleted-household') rows.households[0]!.deletedAt = AT;
      await expect(service.createAsset(U, assetInput())).rejects.toBeInstanceOf(ForbiddenException);
      expect(rows.manual_assets).toEqual([]);
    }
  });
  it('keeps a viewer read-only for asset and plan creation', async () => {
    const { service, rows, queries } = setup(); rows.household_members[0]!.role = 'viewer';
    await expect(service.createAsset(U, assetInput())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.createPlan(U, planInput())).rejects.toBeInstanceOf(ForbiddenException);
    expect(queries.some(query => /^(insert|update|delete)/.test(query.sql))).toBe(false);
    expect(rows.manual_finance_audit).toEqual([]);
  });
  it.each(['owner', 'admin', 'member'])('allows an active %s to create only their own manual record', async role => {
    const { service, rows } = setup(); rows.household_members[0]!.role = role;
    expect((await service.createAsset(U, assetInput())).item).toMatchObject({ ownerUserId: U, canEdit: true });
  });
  it('retains a downgraded writer read access but clears canEdit and rejects every mutation', async () => {
    const { service, rows, queries, publisher } = setup(); rows.household_members[0]!.role = 'member';
    const asset = assetInput(), plan = planInput();
    await service.createAsset(U, asset); await service.createPlan(U, plan);
    rows.household_members[0]!.role = 'viewer';
    expect((await service.getAsset(U, H, A)).item.canEdit).toBe(false);
    expect((await service.getPlan(U, H, P)).item.canEdit).toBe(false);
    expect((await service.listAssets(U, { householdId: H, scope: 'private' })).items[0]!.canEdit).toBe(false);
    expect((await service.listPlans(U, { householdId: H, scope: 'private' })).items[0]!.canEdit).toBe(false);
    const { id: _a, householdId: _ha, ...assetFields } = asset;
    const { id: _p, householdId: _hp, ...planFields } = plan;
    const before = JSON.stringify([rows.manual_assets, rows.manual_housing_plans, rows.manual_housing_payments, rows.manual_finance_audit]);
    queries.length = 0;
    for (const mutation of [
      () => service.createAsset(U, { ...asset, id: randomUUID() }),
      () => service.createPlan(U, { ...plan, id: randomUUID() }),
      () => service.updateAsset(U, H, A, { ...assetFields, expectedVersion: 1 }),
      () => service.updatePlan(U, H, P, { ...planFields, expectedVersion: 1 }),
      () => service.deleteAsset(U, H, A, { expectedVersion: 1 }),
      () => service.deletePlan(U, H, P, { expectedVersion: 1 }),
    ]) await expect(mutation()).rejects.toBeInstanceOf(ForbiddenException);
    expect(JSON.stringify([rows.manual_assets, rows.manual_housing_plans, rows.manual_housing_payments, rows.manual_finance_audit])).toBe(before);
    expect(queries.some(query => /^(insert|update|delete)/.test(query.sql))).toBe(false);
    expect(publisher.publish).not.toHaveBeenCalled();
  });
  it('rechecks the writer role inside the locked transaction after a downgrade', async () => {
    const { service, rows, beforeTransaction } = setup(); const asset = assetInput(); await service.createAsset(U, asset);
    const { id: _id, householdId: _household, ...fields } = asset;
    beforeTransaction(() => { rows.household_members[0]!.role = 'viewer'; });
    await expect(service.updateAsset(U, H, A, { ...fields, expectedVersion: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(rows.manual_assets[0]!.version).toBe(1);
  });
});

describe('manual asset privacy, exact money and concurrency', () => {
  it('keeps unknown values null and never reveals private values or their counts in household totals', async () => {
    const { service } = setup();
    const created = await service.createAsset(U, assetInput());
    expect(created.item).toMatchObject({ amount: null, asOfDate: null, source: null, canEdit: true, visibility: 'private' });
    expect(created.item).not.toHaveProperty('creationPayloadHash');
    const shared = await service.listAssets(O, { householdId: H, scope: 'household' });
    expect(shared.items).toEqual([]); expect(shared.summary.grossAssets).toBeNull();
    expect(JSON.stringify(shared)).not.toContain('합성 통장');
    expect((await service.listAssets(U, { householdId: H, scope: 'private' })).items).toHaveLength(1);
  });
  it('allows shared reading, marks non-owner read-only, and denies manager edits of another owner', async () => {
    const { service } = setup();
    await service.createAsset(O, assetInput({ visibility: 'household', amount: '99999999999999999999', asOfDate: '2020-01-01', source: 'manual' }));
    expect((await service.getAsset(U, H, A)).item).toMatchObject({ amount: '99999999999999999999', canEdit: false });
    await expect(service.updateAsset(U, H, A, { ...assetInput(), expectedVersion: 1 } as never)).rejects.toBeInstanceOf(BadRequestException);
    const { id: _id, householdId: _household, ...fields } = assetInput();
    await expect(service.updateAsset(U, H, A, { ...fields, expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deleteAsset(U, H, A, { expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundException);
  });
  it('does not allow cross-household or another owner private detail', async () => {
    const { service } = setup(); await service.createAsset(O, assetInput());
    await expect(service.getAsset(U, H, A)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getAsset(U, H2, A)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('filters a former owner even if a legacy shared flag remains', async () => {
    const { service, rows } = setup(); await service.createAsset(O, assetInput({ visibility: 'household' }));
    rows.household_members[1]!.status = 'removed';
    expect((await service.listAssets(U, { householdId: H, scope: 'household' })).items).toEqual([]);
    await expect(service.getAsset(U, H, A)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('serializes authorization before the entity and uses optimistic versions without changing creation identity', async () => {
    const { service, rows, queries } = setup(); await service.createAsset(U, assetInput());
    const hash = rows.manual_assets[0]!.creationPayloadHash;
    queries.length = 0;
    const { id: _id, householdId: _household, ...fields } = assetInput({ amount: '0', source: 'manual', asOfDate: '2020-01-01' });
    const result = await service.updateAsset(U, H, A, { ...fields, expectedVersion: 1 });
    expect(result.item).toMatchObject({ version: 2, amount: '0' });
    expect(rows.manual_assets[0]!.creationPayloadHash).toBe(hash);
    const locks = queries.filter(query => query.sql.includes('for share') || query.sql.includes('for update'));
    expect(locks.map(query => query.sql.match(/from "([^"]+)"/)?.[1])).toEqual(['household_members', 'households', 'manual_assets']);
    expect(queries.find(query => query.sql.startsWith('update "manual_assets"'))?.sql).toContain('"manual_assets"."version" =');
    await expect(service.updateAsset(U, H, A, { ...fields, expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictException);
    expect(rows.manual_assets[0]!.version).toBe(2);
  });
  it('replays only the original create payload and preserves updated values', async () => {
    const { service, rows } = setup(); const input = assetInput(); await service.createAsset(U, input);
    const { id: _id, householdId: _household, ...fields } = input;
    await service.updateAsset(U, H, A, { ...fields, label: '수정한 합성 통장', expectedVersion: 1 });
    const replay = await service.createAsset(U, input);
    expect(replay.item.label).toBe('수정한 합성 통장');
    await expect(service.createAsset(U, { ...input, label: '다른 작성 요청' })).rejects.toBeInstanceOf(ConflictException);
    expect(rows.manual_assets).toHaveLength(1);
    expect(rows.manual_finance_audit).toHaveLength(2);
  });
  it('soft deletes once, hides totals/detail, and never recreates a tombstone on create retry', async () => {
    const { service, rows } = setup(); const input = assetInput(); await service.createAsset(U, input);
    expect(await service.deleteAsset(U, H, A, { expectedVersion: 1 })).toEqual({ deleted: true });
    expect(await service.deleteAsset(U, H, A, { expectedVersion: 1 })).toEqual({ deleted: true });
    await expect(service.getAsset(U, H, A)).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.listAssets(U, { householdId: H, scope: 'private' })).items).toEqual([]);
    await expect(service.createAsset(U, input)).rejects.toBeInstanceOf(ConflictException);
    expect(rows.manual_assets).toHaveLength(1); expect(rows.manual_finance_audit).toHaveLength(2);
  });
  it('rolls back the record when metadata audit fails and never writes existing money tables', async () => {
    const { service, rows, queries, failAudit } = setup(); failAudit();
    await expect(service.createAsset(U, assetInput())).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(rows.manual_assets).toEqual([]);
    expect(queries.some(query => /card_transactions|card_sms_events|budgets|payment_cards/.test(query.sql))).toBe(false);
  });
  it('does not forward private SQL bindings in unexpected database errors', async () => {
    const { service, failAudit } = setup(); failAudit();
    const error: unknown = await service.createAsset(U, assetInput({ label: '합성 비공개 메모',
      amount: '123456789', source: 'manual', asOfDate: '2020-01-01' })).catch(error => error);
    expect(error).toBeInstanceOf(InternalServerErrorException);
    const text = JSON.stringify((error as InternalServerErrorException).getResponse());
    expect(text).not.toContain('123456789'); expect(text).not.toContain('합성 비공개 메모');
    expect(text).not.toContain('insert'); expect((error as Error).cause).toBeUndefined();
  });
});

describe('housing plan atomicity and privacy', () => {
  it('lists only visible parents and their payments in a consistent read snapshot', async () => {
    const { service, queries } = setup(); await service.createPlan(O, planInput());
    queries.length = 0;
    const result = await service.listPlans(U, { householdId: H, scope: 'household' });
    expect(result.items).toEqual([]); expect(result.summary.nextPayment).toBeNull();
    expect(queries.some(query => query.sql.includes('from "manual_housing_payments"'))).toBe(false);
    expect(queries[0]?.sql).toBe('set transaction isolation level repeatable read');
    await expect(service.getPlan(U, H, P)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('keeps unentered housing/year/option values unknown and never counts housing as current assets', async () => {
    const { service } = setup(); const result = await service.createPlan(U, planInput());
    expect(result.item.occupancyYear).toBeNull(); expect(result.payments[0]!.amount).toBeNull();
    const list = await service.listPlans(U, { householdId: H, scope: 'private' });
    expect(list.summary).toEqual({ nextPayment: null, hasIncompletePayments: true });
    expect((await service.listAssets(U, { householdId: H, scope: 'private' })).summary.grossAssets).toBeNull();
  });
  it('selects an actually known remaining payment without guessing unknown paid amounts or dates', async () => {
    const { service } = setup();
    await service.createPlan(U, planInput({ visibility: 'household', payments: [
      { id: PAY, kind: 'balance', installment: null, dueDate: '2030-01-01', amount: '100', paidAmount: '20', paidDate: '2020-01-01' },
      { id: randomUUID(), kind: 'option', installment: null, dueDate: '2029-01-01', amount: '10', paidAmount: null, paidDate: null },
    ] }));
    expect((await service.listPlans(O, { householdId: H, scope: 'household' })).summary).toMatchObject({
      nextPayment: { paymentId: PAY, dueDate: '2030-01-01', remainingAmountKrw: '80' }, hasIncompletePayments: true,
    });
  });
  it('atomically replaces all payments with the parent version and rolls back conflicting child IDs', async () => {
    const { service, rows } = setup(); const input = planInput(); await service.createPlan(U, input);
    const otherId = randomUUID(), otherPayment = randomUUID();
    await service.createPlan(U, planInput({ id: otherId, payments: [{ ...input.payments[0]!, id: otherPayment }] }));
    const { id: _id, householdId: _household, ...fields } = input;
    await expect(service.updatePlan(U, H, P, { ...fields, expectedVersion: 1,
      payments: [{ ...input.payments[0]!, id: otherPayment }] })).rejects.toBeInstanceOf(ConflictException);
    expect(rows.manual_housing_plans.find(row => row.id === P)!.version).toBe(1);
    expect((await service.getPlan(U, H, P)).payments.map(row => row.id)).toEqual([PAY]);
    const replacement = randomUUID();
    expect((await service.updatePlan(U, H, P, { ...fields, expectedVersion: 1,
      payments: [{ ...input.payments[0]!, id: replacement }] })).item.version).toBe(2);
    expect((await service.getPlan(U, H, P)).payments.map(row => row.id)).toEqual([replacement]);
  });
  it('keeps previous amount and paid-amount sources when the amounts are unchanged even if the client sends manual', async () => {
    const { service } = setup();
    const amountAsOf = '2026-03-01T00:00:00.000Z';
    const paidAsOf = '2026-03-02T00:00:00.000Z';
    const input = planInput({
      payments: [{
        id: PAY, kind: 'contract', installment: null, dueDate: '2026-12-01',
        amount: '10000000', amountSource: 'confirmed', amountAsOfAt: amountAsOf,
        paidAmount: '1000000', paidAmountSource: 'sujain_fetch', paidAmountAsOfAt: paidAsOf,
        paidDate: '2026-02-01',
      }],
    });
    await service.createPlan(U, input);
    const { id: _id, householdId: _household, ...fields } = input;
    const updated = await service.updatePlan(U, H, P, {
      ...fields,
      expectedVersion: 1,
      payments: [{
        id: PAY, kind: 'contract', installment: null, dueDate: '2026-12-01',
        amount: '10000000', amountSource: 'manual', amountAsOfAt: '2026-11-06T15:00:00.000Z',
        paidAmount: '1000000', paidAmountSource: 'manual', paidAmountAsOfAt: '2026-11-06T15:00:00.000Z',
        paidDate: '2026-02-01',
      }],
    });
    expect(updated.payments[0]).toMatchObject({
      amount: '10000000',
      amountSource: 'confirmed',
      amountAsOfAt: amountAsOf,
      paidAmount: '1000000',
      paidAmountSource: 'sujain_fetch',
      paidAmountAsOfAt: paidAsOf,
    });
  });
  it('blocks non-owner edits and hides child records after soft deleting a shared plan', async () => {
    const { service, rows, queries } = setup(); const input = planInput({ visibility: 'household' });
    await service.createPlan(U, input);
    expect((await service.getPlan(O, H, P)).item.canEdit).toBe(false);
    await expect(service.deletePlan(O, H, P, { expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundException);
    await service.deletePlan(U, H, P, { expectedVersion: 1 });
    queries.length = 0;
    await expect(service.getPlan(O, H, P)).rejects.toBeInstanceOf(NotFoundException);
    expect(queries.some(query => query.sql.includes('from "manual_housing_payments"'))).toBe(false);
    expect(rows.manual_housing_payments).toHaveLength(1);
    await expect(service.createPlan(U, input)).rejects.toBeInstanceOf(ConflictException);
  });
  it('replays the original plan creation after edits and rejects a different creation payload', async () => {
    const { service, rows, queries } = setup(); const input = planInput(); await service.createPlan(U, input);
    const { id: _id, householdId: _household, ...fields } = input;
    const child = randomUUID();
    await service.updatePlan(U, H, P, { ...fields, expectedVersion: 1,
      payments: [{ ...input.payments[0]!, id: child }] });
    const replay = await service.createPlan(U, input);
    expect(replay.item.version).toBe(2); expect(replay.payments.map(payment => payment.id)).toEqual([child]);
    expect(queries.some(query => query.sql.includes('from "manual_housing_plans"') && query.sql.endsWith('for share'))).toBe(true);
    await expect(service.createPlan(U, { ...input, label: '다른 합성 계획' })).rejects.toBeInstanceOf(ConflictException);
    expect(rows.manual_housing_plans).toHaveLength(1); expect(rows.manual_finance_audit).toHaveLength(2);
  });
});

describe('membership removal ends manual-record sharing', () => {
  it.each([
    { version: 1, rejoinedAt: '2026-02-01T00:00:00.000Z', incarnation: 'new timestamp' },
    { version: 2_147_483_647, rejoinedAt: '2026-02-01T00:00:00.000Z', incarnation: 'new timestamp' },
    { version: 1, rejoinedAt: AT, incarnation: 'reused timestamp' },
    { version: 2_147_483_647, rejoinedAt: AT, incarnation: 'reused timestamp' },
  ])('revokes imported-loan sharing at version $version with $incarnation without altering evidence', async ({ version, rejoinedAt }) => {
    const { service, household, rows, queries, publisher, transactionState } = setup();
    await service.createAsset(O, assetInput({ kind: 'loan', visibility: 'household',
      amount: '130000000', asOfDate: '2026-01-01', source: 'manual' }));
    publisher.publish.mockClear();
    const recordId = randomUUID();
    const loan = { id: recordId, householdId: H, ownerUserId: O,
      accountFingerprint: 'a'.repeat(64), accountLast4: '1234', loanType: 'interim',
      label: '합성 중도금', visibility: 'household', totalMode: 'replacement',
      replacesManualAssetId: A, manualExpectedVersion: 1, sharedMemberId: MO,
      sharedJoinedAt: AT, version, createdAt: AT, updatedAt: AT, deletedAt: null };
    const privateId = randomUUID(), otherId = randomUUID();
    rows.loan_records.push(loan,
      { ...loan, id: privateId, accountFingerprint: 'c'.repeat(64), visibility: 'private',
        totalMode: 'distinct', replacesManualAssetId: null, manualExpectedVersion: null,
        sharedMemberId: null, sharedJoinedAt: null },
      { ...loan, id: otherId, ownerUserId: U, sharedMemberId: M,
        totalMode: 'distinct', replacesManualAssetId: null, manualExpectedVersion: null });
    rows.loan_snapshots.push({ id: randomUUID(), recordId, householdId: H, ownerUserId: O,
      outstandingPrincipalKrw: '120000000', maturityDate: '2028-01-01', capturedAt: AT,
      source: 'browser_assisted', formatVersion: 1, payloadHash: 'b'.repeat(64), recordVersion: 1, createdAt: AT });
    const beforeSnapshots = structuredClone(rows.loan_snapshots);
    const beforePrivate = structuredClone(rows.loan_records[1]), beforeOther = structuredClone(rows.loan_records[2]);
    const observed: boolean[] = [];
    publisher.publish.mockImplementation(async () => { observed.push(transactionState.active); });
    await household.removeMember(H, U, MO);
    expect(rows.loan_records[0]).toMatchObject({ visibility: 'private', totalMode: 'reference',
      replacesManualAssetId: null, manualExpectedVersion: null, sharedMemberId: null, sharedJoinedAt: null,
      version: Math.min(version + 1, 2_147_483_647) });
    expect(rows.loan_records[1]).toEqual(beforePrivate); expect(rows.loan_records[2]).toEqual(beforeOther);
    expect(rows.loan_snapshots).toEqual(beforeSnapshots);
    expect(queries.filter(query => query.sql.startsWith('update "loan_records"')).every(query => query.transaction)).toBe(true);
    expect(queries.some(query => /^(update|delete).*"loan_snapshots"/.test(query.sql))).toBe(false);
    expect(publisher.publish.mock.calls).toEqual([[H, 'manual-finance.changed']]); expect(observed).toEqual([false]);
    // The rollback-compatible removal must revoke the grant itself. A
    // timestamp comparison alone cannot protect a reused clock value.
    rows.household_members[1]!.status = 'active'; rows.household_members[1]!.joinedAt = rejoinedAt;
    expect(rows.loan_records[0]).toMatchObject({ visibility: 'private', sharedMemberId: null,
      sharedJoinedAt: null, totalMode: 'reference', replacesManualAssetId: null, manualExpectedVersion: null });
  });
  it('unshares only the removed owner records in the membership transaction and does not reshare on rejoin', async () => {
    const { service, household, rows, queries } = setup();
    await service.createAsset(O, assetInput({ visibility: 'household' }));
    await service.createPlan(O, planInput({ visibility: 'household' }));
    queries.length = 0;
    await household.removeMember(H, U, MO);
    expect(rows.manual_assets[0]).toMatchObject({ visibility: 'private', version: 2, amount: null });
    expect(rows.manual_housing_plans[0]).toMatchObject({ visibility: 'private', version: 2, occupancyYear: null });
    expect(rows.manual_finance_audit.filter(row => row.action === 'membership_removed')).toHaveLength(2);
    expect(queries.filter(query => query.sql.startsWith('update "manual_') || query.sql.startsWith('insert into "manual_'))
      .every(query => query.transaction)).toBe(true);
    rows.household_members[1]!.status = 'active';
    expect((await service.listAssets(U, { householdId: H, scope: 'household' })).items).toEqual([]);
    expect((await service.listPlans(U, { householdId: H, scope: 'household' })).items).toEqual([]);
    for (const audit of rows.manual_finance_audit) {
      expect(audit).not.toHaveProperty('amount'); expect(audit).not.toHaveProperty('label'); expect(audit).not.toHaveProperty('fundingNote');
    }
  });
  it('rolls back removal and revocations when its metadata audit fails', async () => {
    const { service, household, rows, failAudit, publisher } = setup();
    await service.createAsset(O, assetInput({ visibility: 'household' }));
    publisher.publish.mockClear();
    failAudit(); await expect(household.removeMember(H, U, MO)).rejects.toThrow();
    expect(rows.household_members[1]!.status).toBe('active');
    expect(rows.manual_assets[0]).toMatchObject({ visibility: 'household', version: 1 });
    expect(publisher.publish).not.toHaveBeenCalled();
  });
  it('locks memberships in order and rechecks an actor removed or demoted while waiting', async () => {
    for (const mode of ['removed', 'demoted']) {
      const { household, rows, queries, beforeTransaction } = setup();
      beforeTransaction(() => {
        if (mode === 'removed') rows.household_members[0]!.status = 'removed';
        else rows.household_members[0]!.role = 'member';
      });
      await expect(household.removeMember(H, U, MO)).rejects.toBeInstanceOf(ForbiddenException);
      expect(rows.household_members[1]!.status).toBe('active');
      expect(queries.some(query => /^(update|insert|delete)/.test(query.sql))).toBe(false);
      const locked = queries.find(query => query.transaction && query.sql.includes('for update'));
      expect(locked?.sql).toContain('order by "household_members"."id" asc');
    }
  });
  it('rechecks the final owner under the same membership locks', async () => {
    const { household, rows, beforeTransaction } = setup(); rows.household_members[1]!.role = 'owner';
    beforeTransaction(() => { rows.household_members[1]!.status = 'removed'; });
    await expect(household.removeMember(H, U, M)).rejects.toBeInstanceOf(BadRequestException);
    expect(rows.household_members[0]!.status).toBe('active');
    expect(rows.household_members.filter(row => row.role === 'owner' && row.status === 'active')).toHaveLength(1);
  });
  it('revokes MAX-version sharing without overflow or colliding with its latest update audit', async () => {
    const { service, household, rows, publisher } = setup();
    const asset = assetInput({ visibility: 'household' }), plan = planInput({ visibility: 'household' });
    await service.createAsset(O, asset); await service.createPlan(O, plan);
    rows.manual_assets[0]!.version = 2_147_483_647; rows.manual_housing_plans[0]!.version = 2_147_483_647;
    rows.manual_finance_audit.push(...[
      { entityType: 'asset', entityId: A }, { entityType: 'housing_plan', entityId: P },
    ].map(row => ({ ...row, id: randomUUID(), householdId: H, actorUserId: O, action: 'update', version: 2_147_483_647, createdAt: AT })));
    const { id: _id, householdId: _householdId, ...assetFields } = asset;
    await expect(service.updateAsset(O, H, A, { ...assetFields, expectedVersion: 2_147_483_647 })).rejects.toBeInstanceOf(ConflictException);
    publisher.publish.mockClear();
    await household.removeMember(H, U, MO);
    expect(rows.household_members[1]!.status).toBe('removed');
    expect(rows.manual_assets[0]).toMatchObject({ version: 2_147_483_647, visibility: 'private' });
    expect(rows.manual_housing_plans[0]).toMatchObject({ version: 2_147_483_647, visibility: 'private' });
    expect(rows.manual_finance_audit.filter(row => row.action === 'membership_removed' && row.version === 2_147_483_647)).toHaveLength(2);
    expect(publisher.publish.mock.calls).toEqual([[H, 'manual-finance.changed']]);
  });
});

describe('shared manual-record cache hints', () => {
  it('keeps direct service construction valid without a publisher', async () => {
    const { db } = setup(); const service = new ManualFinanceService(db);
    await expect(service.createAsset(U, assetInput({ visibility: 'household' }))).resolves.toHaveProperty('item.id', A);
  });
  it('publishes nothing for private-only asset or housing mutations', async () => {
    const { service, publisher } = setup();
    const asset = assetInput(), plan = planInput();
    const { id: _a, householdId: _ha, ...assetFields } = asset;
    const { id: _p, householdId: _hp, ...planFields } = plan;
    await service.createAsset(U, asset); await service.updateAsset(U, H, A, { ...assetFields, expectedVersion: 1 });
    await service.deleteAsset(U, H, A, { expectedVersion: 2 });
    await service.createPlan(U, plan); await service.updatePlan(U, H, P, { ...planFields, expectedVersion: 1 });
    await service.deletePlan(U, H, P, { expectedVersion: 2 });
    expect(publisher.publish).not.toHaveBeenCalled();
  });
  it('publishes once after each committed shared visibility change, without record metadata', async () => {
    const { service, publisher, transactionState, rows } = setup();
    const observed: Array<{ active: boolean; commits: number; auditCount: number }> = [];
    publisher.publish.mockImplementation(async () => { observed.push({ active: transactionState.active,
      commits: transactionState.commits, auditCount: rows.manual_finance_audit.length }); });
    const asset = assetInput({ visibility: 'household' });
    const { id: _id, householdId: _household, ...fields } = asset;
    await service.createAsset(U, asset); await service.createAsset(U, asset); // replay does not publish again
    await service.updateAsset(U, H, A, { ...fields, visibility: 'private', expectedVersion: 1 });
    await service.updateAsset(U, H, A, { ...fields, visibility: 'private', expectedVersion: 2 });
    await service.updateAsset(U, H, A, { ...fields, expectedVersion: 3 });
    await service.deleteAsset(U, H, A, { expectedVersion: 4 });
    await service.deleteAsset(U, H, A, { expectedVersion: 4 });
    expect(publisher.publish.mock.calls).toEqual(Array.from({ length: 4 }, () => [H, 'manual-finance.changed']));
    expect(observed.every(item => !item.active && item.commits > 0 && item.auditCount > 0)).toBe(true);
  });
  it('covers shared plan changes and one post-commit removal hint for multiple shared records', async () => {
    const { service, household, publisher, transactionState } = setup();
    const observed: boolean[] = [];
    publisher.publish.mockImplementation(async () => { observed.push(transactionState.active); });
    const plan = planInput({ visibility: 'household' });
    const { id: _id, householdId: _household, ...fields } = plan;
    await service.createPlan(O, plan); await service.updatePlan(O, H, P, { ...fields, expectedVersion: 1 });
    await service.createAsset(O, assetInput({ visibility: 'household' }));
    expect(publisher.publish.mock.calls).toEqual(Array.from({ length: 3 }, () => [H, 'manual-finance.changed']));
    publisher.publish.mockClear(); observed.length = 0;
    await household.removeMember(H, U, MO);
    expect(publisher.publish.mock.calls).toEqual([[H, 'manual-finance.changed']]); expect(observed).toEqual([false]);
  });
  it('does not publish failed, rejected or private-only removal activity', async () => {
    const failing = setup(); failing.failAudit();
    await expect(failing.service.createAsset(U, assetInput({ visibility: 'household' }))).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(failing.publisher.publish).not.toHaveBeenCalled();
    const privateOnly = setup(); await privateOnly.service.createAsset(O, assetInput());
    await privateOnly.household.removeMember(H, U, MO);
    expect(privateOnly.publisher.publish).not.toHaveBeenCalled();
    const rejected = setup(); const shared = assetInput({ visibility: 'household' });
    await rejected.service.createAsset(U, shared); rejected.publisher.publish.mockClear();
    const { id: _id, householdId: _household, ...fields } = shared;
    await expect(rejected.service.updateAsset(U, H, A, { ...fields, expectedVersion: 999 })).rejects.toBeInstanceOf(ConflictException);
    await expect(rejected.service.deleteAsset(O, H, A, { expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundException);
    expect(rejected.publisher.publish).not.toHaveBeenCalled();
  });
  it('covers plan private-to-shared, shared-to-private and shared deletion without private deletion hints', async () => {
    const { service, publisher } = setup(); const plan = planInput();
    const { id: _id, householdId: _household, ...fields } = plan;
    await service.createPlan(U, plan);
    await service.updatePlan(U, H, P, { ...fields, visibility: 'household', expectedVersion: 1 });
    await service.updatePlan(U, H, P, { ...fields, visibility: 'private', expectedVersion: 2 });
    await service.deletePlan(U, H, P, { expectedVersion: 3 });
    expect(publisher.publish.mock.calls).toEqual(Array.from({ length: 2 }, () => [H, 'manual-finance.changed']));
    const second = planInput({ id: randomUUID(), visibility: 'household', payments: [] });
    await service.createPlan(U, second); publisher.publish.mockClear();
    await service.deletePlan(U, H, second.id, { expectedVersion: 1 });
    await service.deletePlan(U, H, second.id, { expectedVersion: 1 });
    expect(publisher.publish.mock.calls).toEqual([[H, 'manual-finance.changed']]);
  });
  it('does not turn a committed write into failure when publishing fails', async () => {
    const { service, publisher, rows } = setup();
    publisher.publish.mockImplementationOnce(() => { throw new Error('synthetic publisher failure'); });
    await expect(service.createAsset(U, assetInput({ visibility: 'household' }))).resolves.toHaveProperty('item.id', A);
    expect(rows.manual_assets).toHaveLength(1);
    publisher.publish.mockRejectedValueOnce(new Error('synthetic publisher rejection'));
    await expect(service.createPlan(U, planInput({ visibility: 'household' }))).resolves.toHaveProperty('item.id', P);
    expect(rows.manual_housing_plans).toHaveLength(1);
  });
});

describe('적금 자동 납입', () => {
  // 만기일을 과거로 두면 오늘 날짜와 상관없이 결과가 정해진다: 1/15·2/15·3/15 세 번.
  const saving = (extra: Partial<ManualAssetCreateRequest> = {}) => assetInput({
    kind: 'saving', label: '합성 적금', visibility: 'household', amount: '1000000', asOfDate: '2026-01-01', source: 'manual',
    savingsPlan: { monthlyAmount: '500000', day: 15, endDate: '2026-03-31' }, ...extra,
  });

  it('저장된 기준에 납입을 더한 현재 값을 목록·합계에 쓰고, DB의 기준 금액은 그대로 둔다', async () => {
    const { service, rows } = setup();
    const created = await service.createAsset(U, saving());
    expect(created.item).toMatchObject({
      amount: '2500000', asOfDate: '2026-03-15',
      savingsPlan: { monthlyAmount: '500000', day: 15, endDate: '2026-03-31', baseAmount: '1000000', baseAsOfDate: '2026-01-01', contributions: 3 },
    });
    expect(rows.manual_assets[0]).toMatchObject({ amount: '1000000', asOfDate: '2026-01-01', contributionAmount: '500000', contributionDay: 15, contributionEndDate: '2026-03-31' });
    const shared = await service.listAssets(O, { householdId: H, scope: 'household' });
    expect(shared.items[0]!.amount).toBe('2500000');
    expect(shared.summary.grossAssets).toBe('2500000');
  });

  it('계획 키가 없는 수정(옛 앱)은 계획을 지키고, 적금이 아니게 바꾸면 계획을 지운다', async () => {
    const { service, rows } = setup();
    await service.createAsset(U, saving());
    const { id: _id, householdId: _household, savingsPlan: _plan, ...fields } = saving();
    await service.updateAsset(U, H, A, { ...fields, label: '이름만 바꾼 적금', expectedVersion: 1 });
    expect(rows.manual_assets[0]).toMatchObject({ contributionAmount: '500000', contributionDay: 15 });
    const changed = await service.updateAsset(U, H, A, { ...fields, kind: 'account', expectedVersion: 2 });
    expect(rows.manual_assets[0]).toMatchObject({ contributionAmount: null, contributionDay: null, contributionEndDate: null });
    expect(changed.item.amount).toBe('1000000');
    expect(Object.keys(changed.item)).not.toContain('savingsPlan');
  });

  it('null을 보내면 계획을 지우고, 계획 없는 자산 응답에는 savingsPlan 키가 없다(옛 앱 번들 호환)', async () => {
    const { service, rows } = setup();
    await service.createAsset(U, saving());
    const { id: _id, householdId: _household, ...fields } = saving();
    const removed = await service.updateAsset(U, H, A, { ...fields, savingsPlan: null, expectedVersion: 1 });
    expect(rows.manual_assets[0]!.contributionAmount).toBeNull();
    expect(Object.keys(removed.item)).not.toContain('savingsPlan');
  });

  it('금액이 있는 적금이 아니면 자동 납입을 받지 않는다', async () => {
    const { service, queries } = setup();
    await expect(service.createAsset(U, saving({ kind: 'account' }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createAsset(U, saving({ amount: null, asOfDate: null, source: null }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createAsset(U, saving({ savingsPlan: { monthlyAmount: '0', day: 15, endDate: null } }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createAsset(U, saving({ savingsPlan: { monthlyAmount: '500000', day: 32, endDate: null } }))).rejects.toBeInstanceOf(BadRequestException);
    expect(queries).toHaveLength(0);
  });
});
