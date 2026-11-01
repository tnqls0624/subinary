import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const sql = readFileSync(new URL('../drizzle/0065_manual_finance.sql', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const body = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

describe('0065 수동 기록 additive migration', () => {
  it('새 테이블만 추가하며 기존 행·설정·카드 원장을 변경하지 않는다', () => {
    for (const pattern of [/^\s*ALTER\b/im, /^\s*UPDATE\b/im, /^\s*DELETE\s+FROM\b/im, /^\s*DROP\b/im, /^\s*TRUNCATE\b/im, /^\s*INSERT\b/im]) assert.doesNotMatch(body, pattern);
    assert.deepEqual([...body.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]), ['manual_assets', 'manual_housing_plans', 'manual_housing_payments', 'manual_finance_audit']);
    assert.equal(journal.entries.at(-1).tag, '0065_manual_finance');
  });
  it('원화 numeric20,0이며 unknown 금액·날짜를 기본 0/오늘로 바꾸지 않는다', () => {
    assert.equal([...body.matchAll(/\b(?:amount|paid_amount) numeric\(20,0\)/g)].length, 3);
    assert.doesNotMatch(body, /(?:amount|as_of_date|paid_date|due_date)\s+[^,\n]*DEFAULT/i);
    assert.match(body, /CHECK \(currency = 'KRW'\)/);
  });
  it('nullable source가 SQL UNKNOWN으로 금액 계약을 우회하지 못한다', () => {
    assert.match(body, /amount IS NULL AND as_of_date IS NULL AND source IS NULL/);
    assert.match(body, /amount IS NOT NULL AND as_of_date IS NOT NULL AND source IS NOT NULL AND source = 'manual'/);
  });
  it('실제 기록일은 서버 타임존 대신 서울 날짜를 경계로 한다', () => {
    assert.match(body, /as_of_date <= \(CURRENT_TIMESTAMP AT TIME ZONE 'Asia\/Seoul'\)::date/);
    assert.match(body, /paid_date <= \(CURRENT_TIMESTAMP AT TIME ZONE 'Asia\/Seoul'\)::date/);
    assert.match(body, /due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'/);
  });
  it('지급액·지급일 제약은 null 우회를 막고 초과 지급을 거부한다', () => {
    assert.match(body, /paid_amount IS NULL OR \(amount IS NOT NULL AND paid_amount >= 0 AND paid_amount <= amount\)/);
    assert.match(body, /paid_amount IS NOT NULL AND paid_amount > 0 AND paid_date IS NOT NULL/);
    assert.match(body, /\(paid_amount IS NULL OR paid_amount = 0\) AND paid_date IS NULL/);
  });
  it('공유 기본값 private·CAS 버전·생성 hash·삭제 tombstone을 가진다', () => {
    assert.equal([...body.matchAll(/visibility text NOT NULL DEFAULT 'private'/g)].length, 2);
    assert.equal([...body.matchAll(/deleted_at timestamptz/g)].length, 2);
    assert.equal([...body.matchAll(/creation_payload_hash text NOT NULL/g)].length, 2);
    assert.equal([...body.matchAll(/version integer NOT NULL DEFAULT 1/g)].length, 2);
  });
  it('모든 SQL 제약/인덱스 이름이 Drizzle에도 선언돼 있다', () => {
    const names = [...body.matchAll(/(?:CONSTRAINT|CREATE INDEX) (manual_\w+)/g)].map((match) => match[1]);
    for (const name of names) assert.ok(schema.includes(`'${name}'`), name);
    assert.ok(names.length >= 25);
  });
  it('감사는 값 복사 없이 식별자·행위·버전만 보관한다', () => {
    const audit = body.slice(body.indexOf('CREATE TABLE manual_finance_audit'));
    assert.doesNotMatch(audit, /\b(?:amount|paid_amount|label|memo|note|raw_content|before|after|payload)\b/i);
    assert.match(audit, /UNIQUE \(entity_type, entity_id, version, action\)/);
    assert.match(audit, /'membership_removed'/);
  });
  it('최댓값의 수정과 공유 철회를 다른 감사 사건으로 보존한다', () => {
    assert.match(body, /manual_finance_audit_entity_version_action_unique UNIQUE \(entity_type, entity_id, version, action\)/);
    assert.match(schema, /unique\('manual_finance_audit_entity_version_action_unique'\)\.on\(table\.entityType, table\.entityId, table\.version, table\.action\)/);
  });
});
