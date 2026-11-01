import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  shinhanLoanCaptureSchema, loanImportPreviewRequestSchema, loanImportCommitRequestSchema,
  loanImportUpdateRequestSchema, importedLoanRecordSchema, financialOverviewQuerySchema,
} from '../dist/index.mjs';

const uid = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const capture = {
  formatVersion: 1, provider: 'shinhan', source: 'browser_assisted', origin: 'https://bank.shinhan.com',
  pageKind: 'loan_account_list', capturedAt: '2026-01-01T12:00:00+09:00',
  accountFingerprint: 'a'.repeat(64), accountLast4: '0001', loanType: 'interim',
  outstandingPrincipalKrw: '9007199254740993', maturityDate: '2028-02-29', bankAsOfDate: null,
};
const review = {
  label: '합성 중도금 대출', visibility: 'private', totalMode: 'reference',
  replacesManualAssetId: null, manualExpectedVersion: null, confirmedSharing: false,
};
const commit = { requestId: uid(1), recordId: uid(2), householdId: uid(3), expectedVersion: null,
  capture, confirmedOwnAccount: true, confirmedValues: true, ...review };
const reject = (schema, value) => assert.equal(schema.safeParse(value).success, false);

describe('Shinhan browser-assisted import contract', () => {
  it('preserves KRW integers above Number safe range and never invents bank dates', () => {
    const result = shinhanLoanCaptureSchema.parse(capture);
    assert.equal(result.outstandingPrincipalKrw, '9007199254740993');
    assert.equal(result.bankAsOfDate, null);
    assert.equal(shinhanLoanCaptureSchema.parse({ ...capture, outstandingPrincipalKrw: '0', maturityDate: null }).outstandingPrincipalKrw, '0');
  });
  for (const amount of [0, null, '', '1\n', ' 1', '1 ', '01', '-1', '+1', '1.0', '1e6', '1,000', '100000000000000000000']) {
    it(`rejects noncanonical or missing principal ${JSON.stringify(amount)}`, () => reject(shinhanLoanCaptureSchema, { ...capture, outstandingPrincipalKrw: amount }));
  }
  for (const field of ['password', 'cookies', 'accountNumber', 'html', 'userId', 'rate', 'executionAmount', 'futureDrawdown', 'bankToken', '__proto__', 'constructor']) {
    it(`rejects unapproved capture field ${field}`, () => reject(shinhanLoanCaptureSchema, { ...capture, [field]: 'SYNTHETIC_ONLY' }));
  }
  it('rejects other origins, providers, pages and manufactured effective dates', () => {
    for (const change of [
      { origin: 'https://bank.shinhan.com.evil.invalid' }, { origin: 'http://bank.shinhan.com' },
      { origin: 'https://bank.shinhan.com/' }, { provider: 'kb' }, { source: 'manual' },
      { pageKind: 'transaction_history' }, { bankAsOfDate: '2026-01-01' }, { formatVersion: 2 },
    ]) reject(shinhanLoanCaptureSchema, { ...capture, ...change });
  });
  it('rejects unmasked identifiers, uppercase/damaged digests and trailing newlines', () => {
    for (const accountLast4 of ['123', '12345', '0001\n', '****', '１２３４']) reject(shinhanLoanCaptureSchema, { ...capture, accountLast4 });
    for (const accountFingerprint of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64)+'\n', 'g'.repeat(64)]) reject(shinhanLoanCaptureSchema, { ...capture, accountFingerprint });
  });
  it('requires valid capture timestamps and calendar dates', () => {
    for (const capturedAt of ['', '2026-01-01', '2026-01-01T12:00:00', 'invalid']) reject(shinhanLoanCaptureSchema, { ...capture, capturedAt });
    for (const maturityDate of ['2026-02-29', '0000-01-01', '2028-02-29\n', '2028-2-29', '']) reject(shinhanLoanCaptureSchema, { ...capture, maturityDate });
  });
  it('requires explicit own-account and values review before committing', () => {
    assert.equal(loanImportCommitRequestSchema.parse(commit).totalMode, 'reference');
    reject(loanImportCommitRequestSchema, { ...commit, confirmedOwnAccount: false });
    reject(loanImportCommitRequestSchema, { ...commit, confirmedValues: false });
    const { confirmedOwnAccount: _ignored, ...missing } = commit;
    reject(loanImportCommitRequestSchema, missing);
  });
  it('requires independent family sharing consent', () => {
    reject(loanImportCommitRequestSchema, { ...commit, visibility: 'household' });
    assert.equal(loanImportCommitRequestSchema.parse({ ...commit, visibility: 'household', confirmedSharing: true }).visibility, 'household');
    reject(loanImportUpdateRequestSchema, { ...review, expectedVersion: 1, visibility: 'household' });
  });
  it('requires reviewed manual target/version only for replacement', () => {
    reject(loanImportCommitRequestSchema, { ...commit, totalMode: 'replacement' });
    reject(loanImportCommitRequestSchema, { ...commit, totalMode: 'replacement', replacesManualAssetId: uid(4) });
    assert.equal(loanImportCommitRequestSchema.parse({ ...commit, totalMode: 'replacement', replacesManualAssetId: uid(4), manualExpectedVersion: 1 }).totalMode, 'replacement');
    for (const totalMode of ['reference', 'distinct']) reject(loanImportCommitRequestSchema, { ...commit, totalMode, replacesManualAssetId: uid(4), manualExpectedVersion: 1 });
  });
  it('does not accept user/owner changes or arbitrary capture metadata on updates', () => {
    for (const field of ['ownerUserId', 'userId', 'source', 'amount', 'accountFingerprint']) reject(loanImportCommitRequestSchema, { ...commit, [field]: uid(9) });
    for (const field of ['capture', 'householdId', 'ownerUserId', 'id']) reject(loanImportUpdateRequestSchema, { ...review, expectedVersion: 1, [field]: capture });
    reject(loanImportUpdateRequestSchema, { ...review, expectedVersion: 2147483648 });
  });
  it('preview is scoped to authenticated caller context and cannot carry review side effects', () => {
    assert.equal(loanImportPreviewRequestSchema.safeParse({ householdId: uid(3), capture }).success, true);
    reject(loanImportPreviewRequestSchema, { householdId: uid(3), capture, save: true });
    reject(loanImportPreviewRequestSchema, { householdId: uid(3), capture, ownerUserId: uid(9) });
    assert.equal(financialOverviewQuerySchema.parse({ householdId: uid(3) }).scope, 'household');
    reject(financialOverviewQuerySchema, { householdId: uid(3), scope: 'all' });
  });
  it('family record response cannot accidentally expose fingerprint or raw credentials', () => {
    const record = { id:uid(2), householdId:uid(3), ownerUserId:uid(4), version:1, ...review,
      accountLast4:'0001', loanType:'interim', outstandingPrincipalKrw:'1', maturityDate:null,
      capturedAt:capture.capturedAt, bankAsOfDate:null, source:'shinhan_browser', canEdit:false,
      includedInTotals:false, exclusionReason:'reference', createdAt:capture.capturedAt, updatedAt:capture.capturedAt };
    delete record.confirmedSharing;
    assert.equal(importedLoanRecordSchema.safeParse(record).success, true);
    reject(importedLoanRecordSchema, { ...record, accountFingerprint:capture.accountFingerprint });
    reject(importedLoanRecordSchema, { ...record, accountLast4:'0001\n' });
  });
});
