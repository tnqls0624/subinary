import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const sql = readFileSync(new URL('../drizzle/0066_loan_import.sql', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const body = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('0066 reviewed browser-loan observations', () => {
  it('adds only loan tables and immutability support without changing existing rows', () => {
    for (const pattern of [/^\s*ALTER\b/im, /^\s*UPDATE\b/im, /^\s*DELETE\s+FROM\b/im,
      /^\s*DROP\b/im, /^\s*TRUNCATE\b/im, /^\s*INSERT\b/im]) assert.doesNotMatch(body, pattern);
    assert.deepEqual([...body.matchAll(/CREATE TABLE (\w+)/g)].map(match => match[1]), ['loan_records', 'loan_snapshots']);
    assert.equal(journal.entries.find(entry => entry.idx === 66)?.tag, '0066_loan_import');
  });

  it('allows reviewed reimport after deletion or in a different household while preventing same-household duplicates', () => {
    assert.match(body, /CREATE UNIQUE INDEX loan_records_owner_fingerprint_unique ON loan_records \(household_id, owner_user_id, account_fingerprint\)\s+WHERE deleted_at IS NULL/);
    assert.doesNotMatch(body, /CONSTRAINT loan_records_owner_fingerprint_unique/);
    assert.doesNotMatch(body, /loan_records_owner_fingerprint_unique ON loan_records \(owner_user_id, account_fingerprint\)/);
    assert.match(schema, /uniqueIndex\('loan_records_owner_fingerprint_unique'\)\.on\(table\.householdId, table\.ownerUserId, table\.accountFingerprint\)\s+\.where\(sql`\$\{table\.deletedAt\} IS NULL`\)/);
    assert.match(body, /CREATE UNIQUE INDEX loan_records_manual_replacement_unique ON loan_records \(replaces_manual_asset_id\)\s+WHERE deleted_at IS NULL AND replaces_manual_asset_id IS NOT NULL/);
    assert.match(body, /total_mode = 'replacement' AND replaces_manual_asset_id IS NOT NULL AND manual_expected_version IS NOT NULL AND manual_expected_version > 0/);
    assert.match(body, /total_mode IN \('reference', 'distinct'\) AND replaces_manual_asset_id IS NULL AND manual_expected_version IS NULL/);
  });

  it('requires owner-scoped snapshots, global request identity and one snapshot per record version', () => {
    const snapshots = body.slice(body.indexOf('CREATE TABLE loan_snapshots'));
    assert.match(snapshots, /id uuid PRIMARY KEY/);
    assert.match(body, /loan_records_snapshot_scope_unique UNIQUE \(id, household_id, owner_user_id\)/);
    assert.match(snapshots, /FOREIGN KEY \(record_id, household_id, owner_user_id\)\s+REFERENCES loan_records\(id, household_id, owner_user_id\)/);
    assert.match(snapshots, /UNIQUE \(record_id, record_version\)/);
    assert.match(snapshots, /CHECK \(payload_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    assert.doesNotMatch(snapshots, /ON DELETE CASCADE/);
  });

  it('starts private and excluded from totals; shared records require a membership incarnation', () => {
    assert.match(body, /visibility text NOT NULL DEFAULT 'private'/);
    assert.match(body, /total_mode text NOT NULL DEFAULT 'reference'/);
    assert.match(body, /visibility = 'household' AND shared_member_id IS NOT NULL AND shared_joined_at IS NOT NULL/);
    assert.match(body, /visibility = 'private' AND shared_member_id IS NULL AND shared_joined_at IS NULL/);
    assert.match(body, /shared_member_id uuid REFERENCES household_members\(id\)/);
  });

  it('preserves exact observed principal and source without inventing a rate, bank date or payment due', () => {
    assert.match(body, /outstanding_principal_krw numeric\(20,0\) NOT NULL/);
    assert.match(body, /CHECK \(outstanding_principal_krw >= 0\)/);
    assert.match(body, /CHECK \(source = 'browser_assisted'\)/);
    assert.match(body, /CHECK \(format_version = 1\)/);
    assert.match(body, /captured_at <= CURRENT_TIMESTAMP \+ INTERVAL '5 minutes'/);
    assert.doesNotMatch(body, /(?:outstanding_principal_krw|maturity_date|captured_at)\s+[^,\n]*DEFAULT/i);
    assert.doesNotMatch(body, /\b(?:bank_as_of_date|current_rate|due_amount|credentials?|password|cookie|session_token|raw_content)\b/i);
  });

  it('rejects snapshot updates and deletions at the database boundary', () => {
    assert.match(body, /CREATE FUNCTION reject_loan_snapshot_mutation\(\) RETURNS trigger/);
    assert.match(body, /RAISE EXCEPTION 'loan snapshots are immutable' USING ERRCODE = '55000'/);
    assert.match(body, /CREATE TRIGGER loan_snapshots_immutable\s+BEFORE UPDATE OR DELETE ON loan_snapshots\s+FOR EACH ROW EXECUTE FUNCTION reject_loan_snapshot_mutation\(\)/);
  });

  it('declares matching SQL constraints and indexes in Drizzle', () => {
    const names = [...body.matchAll(/(?:CONSTRAINT|CREATE (?:UNIQUE )?INDEX) (loan_\w+)/g)].map(match => match[1]);
    assert.ok(names.length >= 20);
    for (const name of names) assert.ok(schema.includes(`'${name}'`), name);
  });
});
