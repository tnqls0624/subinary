import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, InternalServerErrorException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@family/database';
import type { LoanImportCommitRequest, LoanImportUpdateRequest, ShinhanLoanCapture } from '@family/contracts';
import { LoanImportService } from './loan-import.service';

const H = '11111111-1111-4111-8111-111111111111';
const H2 = '11111111-1111-4111-8111-111111111112';
const U = '22222222-2222-4222-8222-222222222222';
const O = '22222222-2222-4222-8222-222222222223';
const A = '33333333-3333-4333-8333-333333333333';
const C = '33333333-3333-4333-8333-333333333334';
const L = '44444444-4444-4444-8444-444444444444';
const R = '55555555-5555-4555-8555-555555555555';
const M = '66666666-6666-4666-8666-666666666666';
const MO = '66666666-6666-4666-8666-666666666667';
const NOW = '2026-11-01T12:00:00.000Z';
const JOINED = '2026-01-01T00:00:00.123456Z';
const CAPTURED = '2026-11-01T11:59:00.000Z';
const fingerprint = 'a'.repeat(64);
type Row = Record<string, unknown>;
const tables = [schema.users, schema.households, schema.householdMembers, schema.manualAssets, schema.loanRecords, schema.loanSnapshots];
const tableMap = new Map<string, Table>(tables.map(table => [getTableName(table), table as Table]));

const capture = (extra: Partial<ShinhanLoanCapture> = {}): ShinhanLoanCapture => ({
  formatVersion: 1, provider: 'shinhan', source: 'browser_assisted', origin: 'https://bank.shinhan.com',
  pageKind: 'loan_account_list', capturedAt: CAPTURED, accountFingerprint: fingerprint,
  accountLast4: '1234', loanType: 'interim', outstandingPrincipalKrw: '40', maturityDate: '2028-01-01', bankAsOfDate: null, ...extra,
});
const commitInput = (extra: Partial<LoanImportCommitRequest> = {}): LoanImportCommitRequest => ({
  requestId: R, recordId: L, householdId: H, expectedVersion: null, capture: capture(),
  confirmedOwnAccount: true, confirmedValues: true, label: '합성 중도금', visibility: 'private',
  totalMode: 'reference', replacesManualAssetId: null, manualExpectedVersion: null, confirmedSharing: false, ...extra,
});
const review = (extra: Partial<LoanImportUpdateRequest> = {}): LoanImportUpdateRequest => ({
  expectedVersion: 1, label: '합성 중도금', visibility: 'private', totalMode: 'reference',
  replacesManualAssetId: null, manualExpectedVersion: null, confirmedSharing: false, ...extra,
});

/** Split only outside parentheses/quoted identifiers, including the exact-timestamp subquery. */
function splitSql(value: string, separator = ','): string[] {
  const parts: string[] = []; let start = 0, depth = 0, quote = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quote) {
      if (char === quote) { if (value[i + 1] === quote) i++; else quote = ''; }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && value.startsWith(separator, i)) {
      parts.push(value.slice(start, i).trim()); start = i + separator.length; i += separator.length - 1;
    }
  }
  parts.push(value.slice(start).trim()); return parts;
}

/**
 * Real Drizzle SQL and decoding; bounded in-memory rows, no database/network.
 * It enforces the unique/FK boundaries used by this service and rolls back rows.
 * These cases establish service behavior, not PostgreSQL concurrency semantics.
 */
function setup() {
  const rows: Record<string, Row[]> = Object.fromEntries(tables.map(table => [getTableName(table), []]));
  rows.users = [{ id: U, name: '합성 본인', email: 'u@example.invalid', deletedAt: null },
    { id: O, name: '합성 가족', email: 'o@example.invalid', deletedAt: null }];
  rows.households = [{ id: H, deletedAt: null }, { id: H2, deletedAt: null }];
  rows.household_members = [
    { id: M, householdId: H, userId: U, role: 'owner', status: 'active', joinedAt: JOINED, createdAt: NOW, updatedAt: NOW },
    { id: MO, householdId: H, userId: O, role: 'member', status: 'active', joinedAt: JOINED, createdAt: NOW, updatedAt: NOW },
  ];
  const queries: Array<{ sql: string; params: unknown[]; transaction: boolean }> = [];
  const transactionState = { active: false, commits: 0, rollbacks: 0 };
  const publisher = { publish: vi.fn(async (_householdId: string, _event: string) => {}) };
  let snapshotFailure: Error | undefined;
  let beforeNextTransaction: (() => void) | undefined;
  const columns = (name: string) => Object.entries(getTableColumns(tableMap.get(name)!));
  const keyOf = (name: string, column: string) => columns(name).find(([, value]) => value.name === column)?.[0] ?? column;
  const defaultValue = (key: string): unknown => key === 'createdAt' || key === 'updatedAt' ? NOW
    : key === 'version' || key === 'formatVersion' ? 1 : key === 'source' ? 'browser_assisted'
      : key === 'visibility' ? 'private' : key === 'totalMode' ? 'reference' : null;

  function bound(where: string, name: string, key: string, params: unknown[]): unknown {
    const column = columns(name).find(([prop]) => prop === key)?.[1].name ?? key;
    const match = where.match(new RegExp('"' + name + '"\\."' + column + '" = \\$(\\d+)'));
    return match ? params[Number(match[1]) - 1] : undefined;
  }
  function matches(name: string, row: Row, query: string, params: unknown[]): boolean {
    const where = splitSql(query, ' where ')[1] ?? '';
    for (const key of ['id', 'householdId', 'ownerUserId', 'userId', 'status', 'visibility', 'kind', 'version', 'accountFingerprint']) {
      const value = bound(where, name, key, params);
      if (value !== undefined && row[key] !== value) return false;
    }
    if (where.includes('"' + name + '"."deleted_at" is null') && row.deletedAt !== null) return false;
    if (name === 'household_members' && query.includes('inner join "users"')
      && !rows.users.some(user => user.id === row.userId && user.deletedAt === null)) return false;
    if ((name === 'manual_assets' || name === 'loan_records') && where.includes('exists (select 1')) {
      if (!rows.household_members.some(member => member.householdId === row.householdId
        && member.userId === row.ownerUserId && member.status === 'active'
        && rows.users.some(user => user.id === member.userId && user.deletedAt === null))) return false;
      // Compare stored values exactly, including microseconds; JS Date would lose them.
      if (name === 'loan_records' && where.includes('"loan_records"."shared_joined_at"')
        && !rows.household_members.some(member => member.id === row.sharedMemberId && member.householdId === row.householdId
          && member.userId === row.ownerUserId && member.status === 'active' && member.joinedAt === row.sharedJoinedAt)) return false;
    }
    if (name === 'loan_snapshots') {
      const selected = where.match(/"loan_snapshots"\."record_id" in \(([^)]+)\)/);
      if (selected && ![...selected[1]!.matchAll(/\$(\d+)/g)].some(match => params[Number(match[1]) - 1] === row.recordId)) return false;
      if (where.includes('select max(latest.record_version)') && Number(row.recordVersion)
        !== Math.max(...rows.loan_snapshots.filter(snapshot => snapshot.recordId === row.recordId).map(snapshot => Number(snapshot.recordVersion)))) return false;
    }
    return true;
  }
  function values(name: string, row: Row, query: string): unknown[] {
    if (query.startsWith('select "household_members"."id", "household_members"."role" from')) return [row.id, row.role];
    if (/^select (?:"[^"]+"\.)?"id" from /.test(query)) return [row.id];
    return columns(name).map(([key]) => row[key] ?? null);
  }
  function tokenValue(token: string, key: string, params: unknown[]): unknown {
    const parameter = token.match(/^\$(\d+)$/);
    if (parameter) return params[Number(parameter[1]) - 1];
    if (token === 'default') return defaultValue(key);
    if (token === 'null') return null;
    if (/^\(select "household_members"\."joined_at" from "household_members" where /.test(token)) {
      const id = token.match(/"household_members"\."id" = \$(\d+)/);
      if (!id) throw new Error('unsupported membership timestamp query');
      return rows.household_members.find(member => member.id === params[Number(id[1]) - 1])?.joinedAt ?? null;
    }
    throw new Error('unsupported synthetic SQL value');
  }
  function uniqueError(): never { throw Object.assign(new Error('synthetic unique collision'), { code: '23505' }); }
  function constraints(name: string, row: Row, replacingId?: unknown): void {
    const peers = rows[name]!.filter(existing => existing.id !== replacingId);
    if (peers.some(existing => existing.id === row.id)) uniqueError();
    if (name === 'loan_records' && row.deletedAt === null) {
      if (peers.some(existing => existing.deletedAt === null && existing.householdId === row.householdId
        && existing.ownerUserId === row.ownerUserId && existing.accountFingerprint === row.accountFingerprint)) uniqueError();
      if (row.replacesManualAssetId !== null && peers.some(existing => existing.deletedAt === null && existing.replacesManualAssetId === row.replacesManualAssetId)) uniqueError();
    }
    if (name === 'loan_snapshots') {
      if (peers.some(existing => existing.recordId === row.recordId && existing.recordVersion === row.recordVersion)) uniqueError();
      if (!rows.loan_records.some(record => record.id === row.recordId && record.householdId === row.householdId && record.ownerUserId === row.ownerUserId)) {
        throw Object.assign(new Error('synthetic snapshot scope mismatch'), { code: '23503' });
      }
    }
  }
  function execute(query: string, params: unknown[]): unknown[][] {
    if (query.startsWith('set transaction')) return [];
    const name = query.match(/^(?:select .*? from |insert into |update |delete from )"([^"]+)"/s)?.[1];
    if (!name || !tableMap.has(name)) throw new Error('unexpected synthetic query');
    if (query.startsWith('select')) {
      let selected = rows[name]!.filter(row => matches(name, row, query, params));
      if (query.includes('"loan_snapshots"."record_version" desc')) selected.sort((a, b) => Number(b.recordVersion) - Number(a.recordVersion));
      else if (query.includes(' order by ')) selected.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
      const limit = query.match(/ limit \$(\d+)/); if (limit) selected = selected.slice(0, Number(params[Number(limit[1]) - 1]));
      return selected.map(row => values(name, row, query));
    }
    if (query.startsWith('insert')) {
      if (name === 'loan_snapshots' && snapshotFailure) { const error = snapshotFailure; snapshotFailure = undefined; throw error; }
      const match = query.match(/\(([^)]+)\) values ([\s\S]*)/)!;
      const names = splitSql(match[1]!).map(value => value.replaceAll('"', ''));
      const tuples = splitSql(splitSql(match[2]!, ' returning ')[0]!);
      const inserted: Row[] = [];
      for (const tuple of tuples) {
        const row: Row = {};
        splitSql(tuple.slice(1, -1)).forEach((token, index) => {
          const key = keyOf(name, names[index]!); row[key] = tokenValue(token, key, params);
        });
        constraints(name, row); rows[name]!.push(row); inserted.push(row);
      }
      return query.includes(' returning ') ? inserted.map(row => values(name, row, query)) : [];
    }
    if (name === 'loan_snapshots') throw new Error('immutable snapshot mutation attempted');
    if (!query.startsWith('update')) throw new Error('unexpected synthetic deletion');
    const selected = rows[name]!.filter(row => matches(name, row, query, params));
    const assignments = splitSql(splitSql(query, ' set ')[1]!, ' where ')[0]!;
    for (const row of selected) {
      const next = { ...row };
      for (const assignment of splitSql(assignments)) {
        const match = assignment.match(/^"([^"]+)" = ([\s\S]+)$/)!;
        const key = keyOf(name, match[1]!); next[key] = tokenValue(match[2]!, key, params);
      }
      constraints(name, next, row.id); Object.assign(row, next);
    }
    return query.includes(' returning ') ? selected.map(row => values(name, row, query)) : [];
  }
  const unsafe = (transaction: boolean) => (query: string, params: unknown[]) => {
    queries.push({ sql: query, params, transaction });
    const result = Promise.resolve().then(() => execute(query, params));
    return Object.assign(result, { values: () => result });
  };
  const driver = { options: { parsers: {}, serializers: {} }, unsafe: unsafe(false),
    async begin<T>(callback: (client: unknown) => Promise<T>): Promise<T> {
      const beforeRun = beforeNextTransaction; beforeNextTransaction = undefined; beforeRun?.();
      const before = structuredClone(rows); transactionState.active = true;
      try { const result = await callback({ ...driver, unsafe: unsafe(true) }); transactionState.active = false; transactionState.commits++; return result; }
      catch (error) { transactionState.active = false; transactionState.rollbacks++;
        for (const key of Object.keys(rows)) rows[key] = before[key]!; throw error; }
    } };
  const db = drizzle(driver as unknown as postgres.Sql, { schema });
  const seedAsset = (extra: Row = {}) => {
    const row: Row = { id: A, householdId: H, ownerUserId: U, kind: 'loan', label: '합성 수동 대출',
      visibility: 'private', amount: '30', currency: 'KRW', asOfDate: '2026-10-30', source: 'manual',
      legalOwnerLabel: null, note: null, version: 1, creationPayloadHash: 'd'.repeat(64),
      createdAt: NOW, updatedAt: NOW, deletedAt: null, ...extra };
    rows.manual_assets.push(row); return row;
  };
  return { service: new LoanImportService(db, publisher as never), rows, queries, publisher, transactionState, seedAsset,
    failNextSnapshot: (error: Error) => { snapshotFailure = error; },
    beforeTransaction: (run: () => void) => { beforeNextTransaction = run; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('loan import authorization and preview', () => {
  it('rejects missing authentication and malformed input before querying', async () => {
    const { service, queries } = setup();
    await expect(service.overview('', { householdId: H, scope: 'private' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.commit(U, { ...commitInput(), capture: { ...capture(), outstandingPrincipalKrw: '1.5' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.commit(U, { ...commitInput(), ownerUserId: O } as LoanImportCommitRequest)).rejects.toBeInstanceOf(BadRequestException);
    expect(queries).toEqual([]);
  });

  it.each(['removed', 'invited', 'missing', 'deleted-user', 'deleted-household'])('requires live membership, user and household: %s', async mode => {
    const { service, rows, queries } = setup();
    if (mode === 'missing') rows.household_members = [];
    else if (mode === 'deleted-user') rows.users[0]!.deletedAt = NOW;
    else if (mode === 'deleted-household') rows.households[0]!.deletedAt = NOW;
    else rows.household_members[0]!.status = mode;
    await expect(service.overview(U, { householdId: H, scope: 'private' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(queries.some(query => query.sql.includes('from "loan_records"'))).toBe(false);
  });

  it.each(['owner', 'admin', 'member'])('allows own reviewed writes for %s roles', async role => {
    const { service, rows } = setup(); rows.household_members[0]!.role = role;
    expect((await service.commit(U, commitInput())).item).toMatchObject({ ownerUserId: U, canEdit: true });
  });

  it('lets viewers read but never preview, commit or edit', async () => {
    const { service, rows } = setup(); await service.commit(U, commitInput()); rows.household_members[0]!.role = 'viewer';
    expect((await service.records(U, H)).items[0]).toMatchObject({ canEdit: false });
    await expect(service.preview(U, { householdId: H, capture: capture() })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.commit(U, commitInput())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(U, H, L, review())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove(U, H, L, { expectedVersion: 1 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('previews only own undeleted loan mapping options and performs no writes', async () => {
    const { service, rows, queries, seedAsset, publisher } = setup();
    seedAsset(); seedAsset({ id: C, kind: 'account' }); seedAsset({ id: randomUUID(), ownerUserId: O });
    seedAsset({ id: randomUUID(), householdId: H2 }); seedAsset({ id: randomUUID(), deletedAt: NOW });
    const before = structuredClone(rows);
    const result = await service.preview(U, { householdId: H, capture: capture() });
    expect(result.existing).toBeNull(); expect(result.replacementOptions.map(item => item.id)).toEqual([A]);
    expect(result.capture).toEqual(capture()); expect(rows).toEqual(before); expect(publisher.publish).not.toHaveBeenCalled();
    expect(queries.some(query => /^(insert|update|delete)/.test(query.sql))).toBe(false);
    expect(queries.some(query => query.sql.includes('isolation level repeatable read'))).toBe(true);
  });

  it('keeps private records owner-only and shared records read-only for other family members', async () => {
    const { service, rows } = setup();
    await service.commit(U, commitInput());
    expect((await service.records(O, H)).items).toEqual([]);
    expect((await service.overview(O, { householdId: H, scope: 'private' })).loanItems).toEqual([]);
    await expect(service.update(O, H, L, review())).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(O, H, L, { expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundException);
    await service.update(U, H, L, review({ visibility: 'household', confirmedSharing: true, totalMode: 'distinct' }));
    expect((await service.overview(O, { householdId: H, scope: 'household' })).loanItems[0]).toMatchObject({ id: L, canEdit: false });
    expect((await service.overview(U, { householdId: H, scope: 'private' })).loanItems).toEqual([]);
    rows.household_members[0]!.status = 'removed';
    expect((await service.overview(O, { householdId: H, scope: 'household' })).loanItems).toEqual([]);
  });
});

describe('reviewed commits, idempotency and snapshots', () => {
  it('saves owner-bound browser provenance without exposing internal hashes or assuming a bank date', async () => {
    const { service, rows, queries, publisher } = setup();
    const result = await service.commit(U, commitInput());
    expect(result.item).toMatchObject({ id: L, ownerUserId: U, version: 1, source: 'shinhan_browser',
      outstandingPrincipalKrw: '40', bankAsOfDate: null, capturedAt: CAPTURED, includedInTotals: false, exclusionReason: 'reference' });
    expect(rows.loan_snapshots[0]).toMatchObject({ id: R, recordId: L, householdId: H, ownerUserId: U,
      source: 'browser_assisted', formatVersion: 1, recordVersion: 1, outstandingPrincipalKrw: '40' });
    expect(JSON.stringify(result)).not.toContain(fingerprint);
    expect(result.item).not.toHaveProperty('payloadHash'); expect(result.item).not.toHaveProperty('sharedMemberId');
    expect(queries.filter(query => /^(insert|update)/.test(query.sql)).every(query => query.transaction)).toBe(true);
    expect(queries.some(query => query.sql.includes('isolation level read committed'))).toBe(true);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('retries without writes and rejects changed content under the same request UUID', async () => {
    const { service, rows, queries, publisher } = setup();
    const input = commitInput({ visibility: 'household', confirmedSharing: true });
    await service.commit(U, input); publisher.publish.mockClear(); queries.length = 0;
    expect((await service.commit(U, input)).item.version).toBe(1);
    expect(rows.loan_snapshots).toHaveLength(1); expect(rows.loan_records).toHaveLength(1);
    expect(queries.some(query => /^(insert|update)/.test(query.sql))).toBe(false); expect(publisher.publish).not.toHaveBeenCalled();
    const before = structuredClone(rows);
    await expect(service.commit(U, { ...input, label: '다른 합성 이름' })).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toEqual(before);
    await service.update(U, H, L, review({ expectedVersion: 1, label: '검토 후 수정' }));
    queries.length = 0; vi.setSystemTime('2026-11-03T12:00:00.000Z');
    const replay = await service.commit(U, input);
    expect(replay.item).toMatchObject({ label: '검토 후 수정', visibility: 'private', version: 2 });
    expect(queries.some(query => /^(insert|update)/.test(query.sql))).toBe(false);
  });

  it('appends observations, uses the newest snapshot through metadata edits, and rejects stale writes', async () => {
    const { service, rows, queries } = setup(); await service.commit(U, commitInput());
    const first = structuredClone(rows.loan_snapshots[0]);
    const second = commitInput({ requestId: randomUUID(), expectedVersion: 1,
      capture: capture({ capturedAt: '2026-11-01T11:59:30.000Z', outstandingPrincipalKrw: '35' }) });
    expect((await service.commit(U, second)).item).toMatchObject({ version: 2, outstandingPrincipalKrw: '35' });
    expect(rows.loan_snapshots).toHaveLength(2); expect(rows.loan_snapshots[0]).toEqual(first);
    expect((await service.update(U, H, L, review({ expectedVersion: 2, label: '새 이름' }))).item).toMatchObject({ version: 3, outstandingPrincipalKrw: '35' });
    const before = structuredClone(rows);
    await expect(service.commit(U, { ...second, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.commit(U, { ...second, requestId: randomUUID(), expectedVersion: 3, capture: capture() })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.commit(U, { ...second, requestId: randomUUID(), expectedVersion: 3,
      capture: capture({ capturedAt: '2026-11-01T11:59:40.000Z', accountLast4: '9999' }) })).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toEqual(before);
    expect(queries.some(query => /^(update|delete).*"loan_snapshots"/.test(query.sql))).toBe(false);
    expect(queries.some(query => query.sql.includes('select max(latest.record_version)'))).toBe(true);
  });

  it('rolls back a global request-id collision from another owner without revealing their record', async () => {
    const { service, rows } = setup(); await service.commit(U, commitInput()); const before = structuredClone(rows);
    await expect(service.commit(O, commitInput({ recordId: randomUUID(), capture: capture({ accountFingerprint: 'b'.repeat(64) }) }))).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toEqual(before); expect((await service.records(O, H)).items).toEqual([]);
  });

  it('keeps account identity unique within a household while permitting independent reimport after leaving it', async () => {
    const { service, rows, seedAsset } = setup(); seedAsset(); await service.commit(U, commitInput());
    const beforeDuplicate = structuredClone(rows);
    await expect(service.commit(U, commitInput({ requestId: randomUUID(), recordId: randomUUID() }))).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toEqual(beforeDuplicate);
    rows.household_members.push({ ...rows.household_members[0]!, id: randomUUID(), householdId: H2 });
    rows.household_members[0]!.status = 'removed';
    const preview = await service.preview(U, { householdId: H2, capture: capture() });
    expect(preview.existing).toBeNull(); expect(preview.replacementOptions).toEqual([]);
    const fresh = commitInput({ householdId: H2, requestId: randomUUID(), recordId: randomUUID() });
    expect((await service.commit(U, fresh)).item).toMatchObject({ id: fresh.recordId, householdId: H2 });
    expect((await service.records(U, H2)).items.map(item => item.id)).toEqual([fresh.recordId]);
    await expect(service.records(U, H)).rejects.toBeInstanceOf(ForbiddenException);
    const before = structuredClone(rows);
    await expect(service.update(U, H2, fresh.recordId, review({ totalMode: 'replacement',
      replacesManualAssetId: A, manualExpectedVersion: 1 }))).rejects.toBeInstanceOf(ConflictException);
    await expect(service.commit(U, { ...fresh, requestId: randomUUID(), recordId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toEqual(before);
  });

  it.each(['2026-11-01T12:03:00.000Z', '2026-10-31T11:59:59.000Z'])('rejects future or stale captures without writes: %s', async capturedAt => {
    const { service, rows, queries } = setup(); const invalid = capture({ capturedAt });
    await expect(service.preview(U, { householdId: H, capture: invalid })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.commit(U, commitInput({ capture: invalid }))).rejects.toBeInstanceOf(BadRequestException);
    expect(rows.loan_records).toEqual([]); expect(rows.loan_snapshots).toEqual([]);
    expect(queries.some(query => /^(insert|update)/.test(query.sql))).toBe(false);
  });
});

describe('mapping, privacy and the financial overview', () => {
  it('excludes reference observations and includes distinct debt without touching manual rows', async () => {
    const { service, seedAsset, rows } = setup(); seedAsset(); seedAsset({ id: C, kind: 'account', amount: '200' });
    const before = structuredClone(rows.manual_assets); await service.commit(U, commitInput());
    expect((await service.overview(U, { householdId: H, scope: 'private' })).summary).toMatchObject({ debt: '30', netAssets: '170' });
    await service.update(U, H, L, review({ totalMode: 'distinct' }));
    const result = await service.overview(U, { householdId: H, scope: 'private' });
    expect(result.summary).toMatchObject({ grossAssets: '200', debt: '70', netAssets: '130', asOfDate: null });
    expect(result.loanItems[0]).toMatchObject({ includedInTotals: true }); expect(rows.manual_assets).toEqual(before);
  });

  it('replaces exactly one explicit manual loan and restores it when its reviewed version changes', async () => {
    const { service, rows, queries, seedAsset } = setup(); const manual = seedAsset(); seedAsset({ id: C, kind: 'account', amount: '200' });
    const before = structuredClone(rows.manual_assets);
    await service.commit(U, commitInput({ totalMode: 'replacement', replacesManualAssetId: A, manualExpectedVersion: 1 }));
    expect((await service.overview(U, { householdId: H, scope: 'private' })).summary).toMatchObject({ debt: '40', netAssets: '160' });
    expect(rows.manual_assets).toEqual(before);
    const locks = queries.filter(query => query.sql.includes('for update'));
    expect(locks[0]?.sql).toContain('for update of "household_members"');
    expect(locks.findIndex(query => query.sql.includes('from "loan_records"'))).toBeLessThan(locks.findIndex(query => query.sql.includes('from "manual_assets"')));
    manual.version = 2; manual.amount = '31';
    const stale = await service.overview(U, { householdId: H, scope: 'private' });
    expect(stale.loanItems[0]).toMatchObject({ includedInTotals: false, exclusionReason: 'replacement_changed' });
    expect(stale.summary).toMatchObject({ debt: '31', netAssets: null, debtCompleteness: 'partial' });
    expect(stale.manualItems[0]).toMatchObject({ id: A, amount: '31', version: 2 });
    expect(stale.unresolvedLoans).toBe(1);
  });

  it.each(['other-owner', 'other-household', 'wrong-kind', 'different-visibility', 'stale-version', 'deleted', 'missing'])('rejects invalid mapping: %s', async mode => {
    const { service, rows, seedAsset } = setup(); const manual = seedAsset();
    if (mode === 'other-owner') manual.ownerUserId = O;
    if (mode === 'other-household') manual.householdId = H2;
    if (mode === 'wrong-kind') manual.kind = 'account';
    if (mode === 'different-visibility') manual.visibility = 'household';
    if (mode === 'stale-version') manual.version = 2;
    if (mode === 'deleted') manual.deletedAt = NOW;
    if (mode === 'missing') rows.manual_assets = [];
    const before = structuredClone(rows.manual_assets);
    await expect(service.commit(U, commitInput({ totalMode: 'replacement', replacesManualAssetId: A, manualExpectedVersion: 1 }))).rejects.toBeInstanceOf(ConflictException);
    expect(rows.manual_assets).toEqual(before); expect(rows.loan_records).toEqual([]); expect(rows.loan_snapshots).toEqual([]);
  });

  it('does not allow two active imports to replace the same manual loan', async () => {
    const { service, rows, seedAsset } = setup(); seedAsset();
    const input = commitInput({ totalMode: 'replacement', replacesManualAssetId: A, manualExpectedVersion: 1 });
    await service.commit(U, input); const before = structuredClone(rows);
    await expect(service.commit(U, { ...input, requestId: randomUUID(), recordId: randomUUID(),
      capture: capture({ accountFingerprint: 'b'.repeat(64), accountLast4: '5678' }) })).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toEqual(before);
  });

  it('copies sharing grants with full database precision and hides expired grants after rejoin', async () => {
    const { service, rows, queries } = setup();
    await service.commit(U, commitInput({ visibility: 'household', confirmedSharing: true, totalMode: 'distinct' }));
    expect(rows.loan_records[0]!.sharedJoinedAt).toBe(JOINED);
    expect(queries.find(query => query.sql.startsWith('insert into "loan_records"'))?.sql).toContain('(select "household_members"."joined_at" from "household_members" where "household_members"."id" =');
    expect((await service.overview(O, { householdId: H, scope: 'household' })).loanItems).toHaveLength(1);
    // Same JS millisecond, different PostgreSQL membership incarnation.
    rows.household_members[0]!.joinedAt = '2026-01-01T00:00:00.123999Z';
    expect((await service.overview(O, { householdId: H, scope: 'household' })).loanItems).toEqual([]);
    expect((await service.records(U, H)).items[0]).toMatchObject({ includedInTotals: false, exclusionReason: 'sharing_expired' });
    await service.update(U, H, L, review({ visibility: 'household', confirmedSharing: true, totalMode: 'distinct' }));
    expect(rows.loan_records[0]!.sharedJoinedAt).toBe('2026-01-01T00:00:00.123999Z');
    expect((await service.overview(O, { householdId: H, scope: 'household' })).loanItems).toHaveLength(1);
  });

  it('does not reveal private duplicates and excludes all conflicting visible owners safely', async () => {
    const { service } = setup();
    await service.commit(U, commitInput({ visibility: 'household', confirmedSharing: true, totalMode: 'distinct' }));
    const otherId = randomUUID();
    await service.commit(O, commitInput({ requestId: randomUUID(), recordId: otherId, totalMode: 'distinct' }));
    expect((await service.overview(U, { householdId: H, scope: 'household' })).summary.debt).toBe('40');
    await service.update(O, H, otherId, review({ visibility: 'household', confirmedSharing: true, totalMode: 'distinct' }));
    const result = await service.overview(U, { householdId: H, scope: 'household' });
    expect(result.loanItems).toHaveLength(2);
    expect(result.loanItems.every(item => !item.includedInTotals && item.exclusionReason === 'duplicate_visible_loan')).toBe(true);
    expect(result.unresolvedLoans).toBe(2); expect(result.summary).toMatchObject({ debt: null, netAssets: null, debtCompleteness: 'partial' });
    expect(JSON.stringify(result)).not.toContain(fingerprint);
  });

  it('soft deletion restores manual totals; fresh review can reimport but old requests cannot resurrect', async () => {
    const { service, rows, seedAsset } = setup(); seedAsset(); seedAsset({ id: C, kind: 'account', amount: '200' });
    const original = commitInput({ totalMode: 'replacement', replacesManualAssetId: A, manualExpectedVersion: 1 });
    await service.commit(U, original); const saved = structuredClone(rows.loan_snapshots);
    await service.remove(U, H, L, { expectedVersion: 1 });
    await expect(service.remove(U, H, L, { expectedVersion: 1 })).resolves.toEqual({ deleted: true });
    expect(rows.loan_records[0]).toMatchObject({ visibility: 'private', totalMode: 'reference', replacesManualAssetId: null, version: 2 });
    expect((await service.overview(U, { householdId: H, scope: 'private' })).summary).toMatchObject({ debt: '30', netAssets: '170' });
    expect(rows.loan_snapshots).toEqual(saved);
    await expect(service.commit(U, original)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.commit(U, { ...original, requestId: randomUUID(), expectedVersion: 2 })).rejects.toBeInstanceOf(ConflictException);
    const fresh = { ...original, recordId: randomUUID(), requestId: randomUUID() };
    expect((await service.commit(U, fresh)).item).toMatchObject({ id: fresh.recordId, version: 1, includedInTotals: true });
    expect(rows.loan_records).toHaveLength(2); expect(rows.loan_snapshots).toHaveLength(2);
    const before = structuredClone(rows);
    await expect(service.commit(U, { ...fresh, recordId: randomUUID(), requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toEqual(before);
  });
});

describe('transaction failures and notifications', () => {
  it('rolls back record creation if snapshot insertion fails and redacts SQL/error data', async () => {
    const { service, rows, failNextSnapshot, publisher, transactionState } = setup();
    failNextSnapshot(new Error('synthetic-private-payload 987654321 SQL bind'));
    let failure: unknown;
    try { await service.commit(U, commitInput({ visibility: 'household', confirmedSharing: true })); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(InternalServerErrorException);
    expect(String(failure)).not.toContain('synthetic-private-payload'); expect(JSON.stringify(failure)).not.toContain('987654321');
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(rows.loan_records).toEqual([]); expect(rows.loan_snapshots).toEqual([]);
    expect(transactionState.rollbacks).toBe(1); expect(publisher.publish).not.toHaveBeenCalled();
  });

  it.each(['23505', '40001', '40P01', '55P03'])('returns a conflict and preserves the prior snapshot/version after %s', async code => {
    const { service, rows, failNextSnapshot } = setup(); await service.commit(U, commitInput()); const before = structuredClone(rows);
    failNextSnapshot(Object.assign(new Error('synthetic SQL error'), { code }));
    await expect(service.commit(U, commitInput({ requestId: randomUUID(), expectedVersion: 1,
      capture: capture({ capturedAt: '2026-11-01T11:59:30.000Z', outstandingPrincipalKrw: '35' }) }))).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toEqual(before);
  });

  it('rechecks a membership removed before the write transaction and does not mutate loan rows', async () => {
    const { service, rows, queries, beforeTransaction } = setup();
    beforeTransaction(() => { rows.household_members[0]!.status = 'removed'; });
    await expect(service.commit(U, commitInput())).rejects.toBeInstanceOf(ForbiddenException);
    expect(queries.some(query => /^(insert|update)/.test(query.sql))).toBe(false);
  });

  it('publishes only after shared commits, without values, and tolerates a failed hint', async () => {
    const { service, publisher, transactionState, rows } = setup();
    const observed: boolean[] = [];
    publisher.publish.mockImplementation(async () => { observed.push(transactionState.active); });
    await service.commit(U, commitInput()); expect(publisher.publish).not.toHaveBeenCalled();
    await service.update(U, H, L, review({ visibility: 'household', confirmedSharing: true }));
    expect(publisher.publish.mock.calls).toEqual([[H, 'manual-finance.changed']]); expect(observed).toEqual([false]);
    publisher.publish.mockImplementationOnce(() => { throw new Error('synthetic hint failure'); });
    await expect(service.update(U, H, L, review({ expectedVersion: 2 }))).resolves.toHaveProperty('item.version', 3);
    expect(rows.loan_records[0]!.visibility).toBe('private');
  });

  it.each(['update', 'remove'])('does not notify the household when %s cleans up an expired sharing grant', async operation => {
    const { service, rows, publisher } = setup();
    await service.commit(U, commitInput({ visibility: 'household', confirmedSharing: true, totalMode: 'distinct' }));
    rows.household_members[0]!.joinedAt = '2026-01-01T00:00:00.123999Z';
    publisher.publish.mockClear();
    if (operation === 'update') await service.update(U, H, L, review());
    else await service.remove(U, H, L, { expectedVersion: 1 });
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
