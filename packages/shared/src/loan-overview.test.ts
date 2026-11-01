import { describe, expect, it } from 'vitest';
import {
  composeFinancialOverview,
  type LoanOverviewInput,
  type LoanOverviewLoanItem,
  type LoanOverviewManualItem,
} from './loan-overview.js';

interface Manual extends LoanOverviewManualItem {
  label: string;
  legalOwnerLabel: string | null;
  note: string | null;
  canEdit: boolean;
}
const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);
const DATE = '2000-01-01';
const TIME = '2000-01-01T00:00:00.000Z';
const manual = (id: string, amount: string | null, kind: Manual['kind'] = 'account', extra: Partial<Manual> = {}): Manual => ({
  id, householdId: 'household', ownerUserId: 'owner', visibility: 'household', version: 2,
  kind, amount, currency: 'KRW', asOfDate: amount === null ? null : DATE, source: amount === null ? null : 'manual',
  label: '합성 수동 기록', legalOwnerLabel: '검증되지 않은 명의 메모', note: '보존할 메모', canEdit: true, ...extra,
});
const loan = (extra: Partial<LoanOverviewLoanItem> = {}, fingerprint = FINGERPRINT, sharingValid = true): LoanOverviewInput => ({
  item: {
    id: 'loan', householdId: 'household', ownerUserId: 'owner', version: 1,
    label: '합성 신한 대출', visibility: 'household', totalMode: 'distinct',
    replacesManualAssetId: null, manualExpectedVersion: null,
    accountLast4: '1234', loanType: 'interim', outstandingPrincipalKrw: '30', maturityDate: '2030-01-01',
    capturedAt: TIME, bankAsOfDate: null, source: 'shinhan_browser', canEdit: true,
    includedInTotals: false, exclusionReason: 'reference', createdAt: TIME, updatedAt: TIME,
    ...extra,
  },
  accountFingerprint: fingerprint,
  sharingValid,
});
const replacement = (extra: Partial<LoanOverviewLoanItem> = {}, fingerprint = FINGERPRINT): LoanOverviewInput => loan({
  totalMode: 'replacement', replacesManualAssetId: 'manual-loan', manualExpectedVersion: 2, ...extra,
}, fingerprint);

describe('browser loan overview provenance and arithmetic', () => {
  it('empty and intentional reference-only input do not become zero debt', () => {
    const empty = composeFinancialOverview([], []);
    expect(empty.summary).toMatchObject({ grossAssets: null, debt: null, netAssets: null, completeness: 'empty' });
    const result = composeFinancialOverview([], [loan({ totalMode: 'reference' })]);
    expect(result.summary).toEqual(empty.summary);
    expect(result.unresolvedLoans).toBe(0);
    expect(result.loanItems[0]).toMatchObject({ includedInTotals: false, exclusionReason: 'reference' });
  });

  it('combines a distinct browser balance with manual assets without changing either source', () => {
    const asset = manual('cash', '100');
    const imported = loan();
    const before = structuredClone({ asset, imported });
    const result = composeFinancialOverview([asset], [imported]);
    expect(result.summary).toMatchObject({ grossAssets: '100', debt: '30', netAssets: '70', completeness: 'complete' });
    expect(result.manualItems).toEqual([asset]);
    expect(result.loanItems[0]).toMatchObject({ source: 'shinhan_browser', bankAsOfDate: null, includedInTotals: true, exclusionReason: null });
    expect({ asset, imported }).toEqual(before);
  });

  it('uses exact integer arithmetic above the Number precision limit', () => {
    const result = composeFinancialOverview([
      manual('cash', '99999999999999999999'), manual('stock', '99999999999999999999', 'stock'),
      manual('debt', '1', 'loan'),
    ], [loan({ outstandingPrincipalKrw: '99999999999999999998' })]);
    expect(result.summary).toMatchObject({ grossAssets: '199999999999999999998', debt: '99999999999999999999', netAssets: '99999999999999999999' });
  });

  it('keeps unknown values unknown and an explicit zero balance known', () => {
    const missing = composeFinancialOverview([manual('cash', '100'), manual('unknown', null, 'loan')], [loan({ outstandingPrincipalKrw: '0' })]);
    expect(missing.summary).toMatchObject({ debt: '0', debtCompleteness: 'partial', netAssets: null, completeness: 'partial' });
    const zero = composeFinancialOverview([manual('cash', '0')], [loan({ outstandingPrincipalKrw: '0' })]);
    expect(zero.summary).toMatchObject({ debt: '0', netAssets: '0', completeness: 'complete' });
    const noAssets = composeFinancialOverview([], [loan()]);
    expect(noAssets.summary).toMatchObject({ grossAssets: null, debt: '30', netAssets: null, assetsCompleteness: 'empty' });
  });

  it('does not use capture time as a bank valuation date or claim unknown dates differ', () => {
    const single = composeFinancialOverview([manual('cash', '100')], [loan({ capturedAt: '2001-02-03T23:59:59Z' })]);
    expect(single.summary).toMatchObject({ asOfDate: null, oldestAsOfDate: DATE, newestAsOfDate: DATE, mixedAsOfDates: false });
    const mixed = composeFinancialOverview([manual('cash', '100'), manual('stock', '50', 'stock', { asOfDate: '2000-02-01' })], [loan()]);
    expect(mixed.summary).toMatchObject({ asOfDate: null, oldestAsOfDate: DATE, newestAsOfDate: '2000-02-01', mixedAsOfDates: true });
    expect(composeFinancialOverview([], [loan()]).summary).toMatchObject({ asOfDate: null, oldestAsOfDate: null, newestAsOfDate: null, mixedAsOfDates: false });
  });

  it('refuses malformed source and numeric inputs rather than silently coercing them', () => {
    for (const value of ['1.5', '-1', '1e2', '01', '0\n', '30\r\n', '\n30', '30\u2028', '30\u2029', '3 0', '30\t', 9007199254740992 as unknown as string]) {
      expect(() => composeFinancialOverview([], [loan({ outstandingPrincipalKrw: value })])).toThrow('loan_overview_invalid_principal');
    }
    expect(() => composeFinancialOverview([], [loan({ source: 'manual' as never })])).toThrow('loan_overview_invalid_record');
    expect(() => composeFinancialOverview([], [loan({ bankAsOfDate: DATE as never })])).toThrow('loan_overview_invalid_record');
    expect(() => composeFinancialOverview([], [loan({}, 'not-a-fingerprint')])).toThrow('loan_overview_invalid_record');
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029', '\t', ' ']) {
      expect(() => composeFinancialOverview([], [loan({}, FINGERPRINT + suffix)])).toThrow('loan_overview_invalid_record');
    }
    expect(() => composeFinancialOverview([manual('manual-loan', '20', 'loan', { source: 'shinhan_browser' })], [replacement()])).toThrow('manual_finance_invalid_snapshot');
  });
});

describe('explicit manual replacement and recovery', () => {
  it('counts only the replacement while retaining all original manual metadata', () => {
    const original = manual('manual-loan', '20', 'loan');
    const result = composeFinancialOverview([manual('cash', '100'), original], [replacement()]);
    expect(result.summary).toMatchObject({ grossAssets: '100', debt: '30', netAssets: '70' });
    expect(result.manualItems).toEqual([manual('cash', '100'), original]);
    expect(result.manualItems[1]).toMatchObject({ note: '보존할 메모', legalOwnerLabel: '검증되지 않은 명의 메모', source: 'manual', amount: '20' });
    expect(result.loanItems[0]?.includedInTotals).toBe(true);
  });

  it.each([
    ['changed version', { version: 3 }],
    ['other owner', { ownerUserId: 'other-owner' }],
    ['other household', { householdId: 'other-household' }],
    ['other visibility', { visibility: 'private' }],
    ['not a loan', { kind: 'saving' }],
  ] as const)('keeps the manual amount when the target is %s', (_name, change) => {
    const original = manual('manual-loan', '20', 'loan', change);
    const result = composeFinancialOverview([manual('cash', '100'), original], [replacement()]);
    expect(result.loanItems[0]).toMatchObject({ includedInTotals: false, exclusionReason: 'replacement_changed' });
    expect(result.unresolvedLoans).toBe(1);
    expect(result.summary.netAssets).toBeNull();
    expect(result.manualItems).toContainEqual(original);
    expect(result.summary.debt).toBe('kind' in change && change.kind === 'saving' ? null : '20');
  });

  it('does not infer a hidden or deleted replacement target', () => {
    const result = composeFinancialOverview([manual('cash', '100')], [replacement()]);
    expect(result.loanItems[0]).toMatchObject({ includedInTotals: false, exclusionReason: 'replacement_changed' });
    expect(result.summary).toMatchObject({ debt: null, debtCompleteness: 'partial', netAssets: null });
    expect(result.manualItems).toHaveLength(1);
  });

  it('restores manual totals after deletion, sharing expiry, or a reference-only change', () => {
    const records = [manual('cash', '100'), manual('manual-loan', '20', 'loan')];
    expect(composeFinancialOverview(records, []).summary).toMatchObject({ debt: '20', netAssets: '80' });
    const expired = replacement(); expired.sharingValid = false;
    const revoked = composeFinancialOverview(records, [expired]);
    expect(revoked.summary.debt).toBe('20');
    expect(revoked.loanItems[0]).toMatchObject({ includedInTotals: false, exclusionReason: 'sharing_expired' });
    const reference = loan({ totalMode: 'reference' });
    expect(composeFinancialOverview(records, [reference]).summary).toMatchObject({ debt: '20', netAssets: '80' });
  });

  it('fails closed on two imported records mapping to the same manual loan', () => {
    const result = composeFinancialOverview([manual('cash', '100'), manual('manual-loan', '20', 'loan')], [
      replacement(), replacement({ id: 'second-loan' }, OTHER_FINGERPRINT),
    ]);
    expect(result.loanItems.map(item => item.exclusionReason)).toEqual(['replacement_changed', 'replacement_changed']);
    expect(result.summary).toMatchObject({ debt: '20', debtCompleteness: 'partial', netAssets: null });
    expect(result.unresolvedLoans).toBe(2);
  });
});

describe('visible duplicates and private data boundaries', () => {
  it('excludes all visible duplicate fingerprints across people without selecting a winner', () => {
    const inputs = [replacement(), loan({ id: 'wife-loan', ownerUserId: 'wife', outstandingPrincipalKrw: '40' })];
    const records = [manual('cash', '100'), manual('manual-loan', '20', 'loan')];
    const result = composeFinancialOverview(records, inputs);
    expect(result.loanItems.map(item => item.exclusionReason)).toEqual(['duplicate_visible_loan', 'duplicate_visible_loan']);
    expect(result.summary).toMatchObject({ debt: '20', debtCompleteness: 'partial', netAssets: null });
    expect(result.unresolvedLoans).toBe(2);
    const reversed = composeFinancialOverview(records, [...inputs].reverse());
    expect(reversed.summary).toEqual(result.summary);
  });

  it('reference-only or expired shared records do not block a counted observation', () => {
    const reference = loan({ id: 'reference-loan', totalMode: 'reference' });
    const result = composeFinancialOverview([manual('cash', '100')], [loan(), reference]);
    expect(result.summary).toMatchObject({ debt: '30', netAssets: '70' });
    expect(result.loanItems.map(item => item.exclusionReason)).toEqual([null, 'reference']);
    const expired = loan({ id: 'expired-loan', ownerUserId: 'other' }, FINGERPRINT, false);
    expect(composeFinancialOverview([], [loan(), expired]).loanItems[0]?.includedInTotals).toBe(true);
  });

  it('private observations do not require a family sharing grant', () => {
    const result = composeFinancialOverview([manual('cash', '100', 'account', { visibility: 'private' })], [loan({ visibility: 'private' }, FINGERPRINT, false)]);
    expect(result.loanItems[0]?.includedInTotals).toBe(true);
    expect(result.summary.netAssets).toBe('70');
  });

  it('deduplicates identical IDs and refuses conflicting versions or observations', () => {
    const item = loan();
    const asset = manual('cash', '100');
    expect(composeFinancialOverview([asset, { ...asset }], [item, structuredClone(item)]).summary).toMatchObject({ grossAssets: '100', debt: '30' });
    expect(composeFinancialOverview([], [item, structuredClone(item)]).loanItems).toHaveLength(1);
    expect(() => composeFinancialOverview([], [item, loan({ outstandingPrincipalKrw: '31' })])).toThrow('loan_overview_conflicting_record');
    expect(() => composeFinancialOverview([asset, { ...asset, ownerUserId: 'other' }], [])).toThrow('loan_overview_conflicting_record');
  });

  it('does not return fingerprints or extra database fields even if accidentally attached to a DTO', () => {
    const input = loan();
    Object.assign(input.item, { accountFingerprint: FINGERPRINT, payloadHash: 'hidden-hash', rawCapture: 'hidden-content' });
    const result = composeFinancialOverview([], [input]);
    expect(JSON.stringify(result)).not.toContain(FINGERPRINT);
    expect(result.loanItems[0]).not.toHaveProperty('payloadHash');
    expect(result.loanItems[0]).not.toHaveProperty('rawCapture');
  });
});
