import { describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { Db } from '@family/database';
import { HouseholdService } from './household.service';

const H = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const MA = '44444444-4444-4444-8444-444444444444';
const MB = '55555555-5555-4555-8555-555555555555';
const actor = { id: MA, householdId: H, userId: A, role: 'owner', status: 'active' };
const target = { id: MB, householdId: H, userId: B, role: 'member', status: 'active' };

// Unit test only: queued DB projections exercise the actual method's authority
// and post-commit hint boundary. Locks, SQL CASE, atomic writes and real rejoin
// remain the separately run PostgreSQL/HTTP integration harness's responsibility.
function query(rows: unknown[]) {
  const result = {
    from: () => result, where: () => result, limit: () => result,
    orderBy: () => result, for: () => result, returning: () => result,
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return result;
}

function fixture(options: { members?: unknown[]; initial?: unknown[]; assets?: unknown[]; plans?: unknown[]; auditFails?: boolean } = {}) {
  const updates: { table: string; values: Record<string, unknown> }[] = [];
  const audits: Record<string, unknown>[] = [];
  let inTransaction = false;
  let txSelect = 0;
  const tx = {
    select: () => query(txSelect++ === 0 ? options.members ?? [actor, target] : [{ id: H }]),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (values: Record<string, unknown>) => {
        const name = getTableName(table); updates.push({ table: name, values });
        const rows = name === 'manual_assets' ? options.assets ?? [] : name === 'manual_housing_plans' ? options.plans ?? [] : [];
        const updateQuery = query(rows);
        return updateQuery;
      },
    }),
    insert: () => ({ values: async (rows: Record<string, unknown>[]) => {
      if (options.auditFails) throw new Error('synthetic_audit_failure');
      audits.push(...rows);
    } }),
  };
  const db = {
    select: () => query(options.initial ?? [actor]),
    transaction: async (run: (executor: typeof tx) => Promise<unknown>) => {
      inTransaction = true;
      try { return await run(tx); } finally { inTransaction = false; }
    },
  };
  const publisher = { publish: vi.fn(async () => { expect(inTransaction).toBe(false); }) };
  const service = new HouseholdService(db as unknown as Db, {} as never, publisher as never);
  return { service, updates, audits, publisher, db };
}

describe('old API rollback: guarded household sharing revocation', () => {
  it('rejects an actor removed while waiting before mutating any resource', async () => {
    const f = fixture({ members: [{ ...actor, status: 'removed' }, target] });
    await expect(f.service.removeMember(H, A, MB)).rejects.toMatchObject({ status: 403 });
    expect(f.updates).toEqual([]); expect(f.audits).toEqual([]); expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it('rechecks a downgraded role under the lock', async () => {
    const f = fixture({ members: [{ ...actor, role: 'member' }, target] });
    await expect(f.service.removeMember(H, A, MB)).rejects.toMatchObject({ status: 403 });
    expect(f.updates).toEqual([]); expect(f.audits).toEqual([]);
  });
  it('preserves the final owner using the locked membership state', async () => {
    const f = fixture();
    await expect(f.service.removeMember(H, A, MA)).rejects.toMatchObject({ status: 400 });
    expect(f.updates).toEqual([]); expect(f.audits).toEqual([]);
  });
  it('allows a viewer to leave their own family without granting manual-record write authority', async () => {
    const viewer = { ...actor, role: 'viewer' };
    const f = fixture({ initial: [viewer], members: [viewer, { ...target, role: 'owner' }] });
    await expect(f.service.removeMember(H, A, MA)).resolves.toEqual({ removed: true });
    expect(f.updates[0]).toMatchObject({ table: 'household_members', values: { status: 'removed' } });
  });
  it('keeps repeated removal idempotent without duplicate audit or hints', async () => {
    const f = fixture({ members: [actor, { ...target, status: 'removed' }] });
    await expect(f.service.removeMember(H, A, MB)).resolves.toEqual({ removed: true });
    expect(f.updates).toEqual([]); expect(f.audits).toEqual([]); expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it('revokes both parent kinds and audits only identifiers/actions/versions before a post-commit hint', async () => {
    const f = fixture({ assets: [{ id: 'asset', version: 2147483647 }], plans: [{ id: 'plan', version: 2147483647 }] });
    await expect(f.service.removeMember(H, A, MB)).resolves.toEqual({ removed: true });
    expect(f.updates.find(row => row.table === 'manual_assets')?.values.visibility).toBe('private');
    expect(f.updates.find(row => row.table === 'manual_housing_plans')?.values.visibility).toBe('private');
    expect(f.audits).toEqual([
      { householdId: H, actorUserId: A, entityType: 'asset', entityId: 'asset', action: 'membership_removed', version: 2147483647 },
      { householdId: H, actorUserId: A, entityType: 'housing_plan', entityId: 'plan', action: 'membership_removed', version: 2147483647 },
    ]);
    expect(f.publisher.publish).toHaveBeenCalledExactlyOnceWith(H, 'manual-finance.changed');
  });
  it('does not disclose private-only activity via a realtime hint', async () => {
    const f = fixture();
    await expect(f.service.removeMember(H, A, MB)).resolves.toEqual({ removed: true });
    expect(f.audits).toEqual([]); expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it('does not publish a hint when the transaction rejects its audit', async () => {
    const f = fixture({ assets: [{ id: 'asset', version: 2 }], auditFails: true });
    await expect(f.service.removeMember(H, A, MB)).rejects.toThrow('synthetic_audit_failure');
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it('preserves the old optional publisher dependency', async () => {
    const f = fixture({ assets: [{ id: 'asset', version: 2 }] });
    const service = new HouseholdService(f.db as unknown as Db, {} as never);
    await expect(service.removeMember(H, A, MB)).resolves.toEqual({ removed: true });
  });
});
