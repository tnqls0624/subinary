import { summarizeManualAssets, type ManualAssetSummaryInput, type ManualAssetTotals } from './manual-finance.js';

/** Structural DTOs keep this pure package independent of the API/contracts package. */
export interface LoanOverviewManualItem extends ManualAssetSummaryInput {
  householdId: string;
  ownerUserId: string;
  visibility: 'private' | 'household';
  version: number;
}

export type LoanOverviewExclusionReason = 'reference' | 'replacement_changed' | 'duplicate_visible_loan' | 'sharing_expired';
export interface LoanOverviewLoanItem {
  id: string; householdId: string; ownerUserId: string; version: number;
  label: string; visibility: 'private' | 'household'; totalMode: 'reference' | 'distinct' | 'replacement';
  replacesManualAssetId: string | null; manualExpectedVersion: number | null;
  accountLast4: string; loanType: 'interim' | 'jeonse';
  outstandingPrincipalKrw: string; maturityDate: string | null;
  capturedAt: string; bankAsOfDate: null; source: 'shinhan_browser'; canEdit: boolean;
  includedInTotals: boolean; exclusionReason: LoanOverviewExclusionReason | null;
  createdAt: string; updatedAt: string;
}

export interface LoanOverviewInput {
  item: LoanOverviewLoanItem;
  /** Internal comparison key. Never included in the public result. */
  accountFingerprint: string;
  /** Only shared records require a current owner membership sharing grant. */
  sharingValid: boolean;
}

export interface LoanOverviewResult<M extends LoanOverviewManualItem = LoanOverviewManualItem> {
  /** Retain original metadata, including replaced records, for review and editing. */
  manualItems: M[];
  loanItems: LoanOverviewLoanItem[];
  summary: ManualAssetTotals;
  unresolvedLoans: number;
}

const key = (value: string): string => value.toLowerCase();
const principal = (value: string): bigint => {
  // JavaScript's $ can match before a final line break; reject whitespace too.
  if (typeof value !== 'string' || /\s/.test(value) || !/^(0|[1-9]\d{0,19})$/.test(value)) throw new RangeError('loan_overview_invalid_principal');
  return BigInt(value);
};
const validVersion = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
const canonical = (record: object): string => JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/** Explicitly copy the public DTO. Extra database fields and fingerprints cannot escape. */
function publicLoan(item: LoanOverviewLoanItem, reason: LoanOverviewExclusionReason | null): LoanOverviewLoanItem {
  return {
    id: item.id, householdId: item.householdId, ownerUserId: item.ownerUserId, version: item.version,
    label: item.label, visibility: item.visibility, totalMode: item.totalMode,
    replacesManualAssetId: item.replacesManualAssetId, manualExpectedVersion: item.manualExpectedVersion,
    accountLast4: item.accountLast4, loanType: item.loanType,
    outstandingPrincipalKrw: item.outstandingPrincipalKrw, maturityDate: item.maturityDate,
    capturedAt: item.capturedAt, bankAsOfDate: null, source: 'shinhan_browser', canEdit: item.canEdit,
    includedInTotals: reason === null, exclusionReason: reason,
    createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
}

function validateLoan(input: LoanOverviewInput): void {
  const item = input.item;
  if (typeof input.accountFingerprint !== 'string' || input.accountFingerprint.length !== 64
    || !/^[0-9a-f]{64}$/.test(input.accountFingerprint) || typeof input.sharingValid !== 'boolean'
    || ![item.id, item.householdId, item.ownerUserId].every(value => typeof value === 'string' && value.length > 0)
    || !validVersion(item.version) || !['private', 'household'].includes(item.visibility)
    || !['reference', 'distinct', 'replacement'].includes(item.totalMode)
    || item.source !== 'shinhan_browser' || item.bankAsOfDate !== null
    || !Number.isFinite(Date.parse(item.capturedAt))) throw new RangeError('loan_overview_invalid_record');
  principal(item.outstandingPrincipalKrw);
  if (item.totalMode === 'replacement') {
    if (typeof item.replacesManualAssetId !== 'string' || item.replacesManualAssetId.length === 0
      || !validVersion(item.manualExpectedVersion)) throw new RangeError('loan_overview_invalid_mapping');
  } else if (item.replacesManualAssetId !== null || item.manualExpectedVersion !== null) {
    throw new RangeError('loan_overview_invalid_mapping');
  }
}

/**
 * The API supplies only already-authorized rows from one household and scope,
 * read in one transaction. This function cannot authorize a database row.
 *
 * Browser observations remain browser observations: no conversion to manual
 * provenance and no capture date substituted for an unknown bank value date.
 */
export function composeFinancialOverview<M extends LoanOverviewManualItem>(
  manualItems: readonly M[],
  loanInputs: readonly LoanOverviewInput[],
): LoanOverviewResult<M> {
  // Validate every manual input before suppression so a replacement cannot hide
  // an invalid source, amount, or conflicting duplicate ID.
  summarizeManualAssets(manualItems);
  const manuals = new Map<string, M>();
  for (const item of manualItems) {
    const previous = manuals.get(key(item.id));
    if (previous && (key(previous.ownerUserId) !== key(item.ownerUserId)
      || key(previous.householdId) !== key(item.householdId)
      || previous.visibility !== item.visibility || previous.version !== item.version)) {
      throw new RangeError('loan_overview_conflicting_record');
    }
    if (!previous) manuals.set(key(item.id), item);
  }

  const uniqueLoans = new Map<string, LoanOverviewInput>();
  for (const input of loanInputs) {
    validateLoan(input);
    const previous = uniqueLoans.get(key(input.item.id));
    if (previous && (canonical(publicLoan(previous.item, null)) !== canonical(publicLoan(input.item, null))
      || previous.accountFingerprint !== input.accountFingerprint || previous.sharingValid !== input.sharingValid)) {
      throw new RangeError('loan_overview_conflicting_record');
    }
    if (!previous) uniqueLoans.set(key(input.item.id), input);
  }
  const inputs = [...uniqueLoans.values()];
  const eligible = inputs.filter(({ item, sharingValid }) => item.totalMode !== 'reference'
    && (item.visibility === 'private' || sharingValid));
  const fingerprintCounts = new Map<string, number>();
  const replacementCounts = new Map<string, number>();
  for (const input of eligible) {
    fingerprintCounts.set(input.accountFingerprint, (fingerprintCounts.get(input.accountFingerprint) ?? 0) + 1);
    if (input.item.replacesManualAssetId) {
      const target = key(input.item.replacesManualAssetId);
      replacementCounts.set(target, (replacementCounts.get(target) ?? 0) + 1);
    }
  }

  const suppressed = new Set<string>();
  const loanItems = inputs.map(({ item, accountFingerprint, sharingValid }) => {
    let reason: LoanOverviewExclusionReason | null = null;
    if (item.visibility === 'household' && !sharingValid) reason = 'sharing_expired';
    else if (item.totalMode === 'reference') reason = 'reference';
    // Exclude every visible conflicting candidate rather than selecting a
    // person's balance by array order. Reference-only rows do not compete.
    else if ((fingerprintCounts.get(accountFingerprint) ?? 0) > 1) reason = 'duplicate_visible_loan';
    else if (item.totalMode === 'replacement') {
      const targetId = key(item.replacesManualAssetId!);
      const target = manuals.get(targetId);
      if (!target || target.kind !== 'loan' || key(target.ownerUserId) !== key(item.ownerUserId)
        || key(target.householdId) !== key(item.householdId) || target.visibility !== item.visibility
        || target.version !== item.manualExpectedVersion || replacementCounts.get(targetId) !== 1) {
        reason = 'replacement_changed';
      } else suppressed.add(targetId);
    }
    return publicLoan(item, reason);
  });

  const effectiveManual = [...manuals.values()].filter(item => !suppressed.has(key(item.id)));
  const summary = summarizeManualAssets(effectiveManual);
  const included = loanItems.filter(item => item.includedInTotals);
  const unresolvedLoans = loanItems.filter(item => !item.includedInTotals && item.totalMode !== 'reference').length;
  if (included.length > 0) {
    const observedDebt = included.reduce((sum, item) => sum + principal(item.outstandingPrincipalKrw), 0n);
    summary.debt = (BigInt(summary.debt ?? '0') + observedDebt).toString();
    if (summary.debtCompleteness === 'empty') summary.debtCompleteness = 'complete';
    // The known manual date range remains useful, but is not a range covering
    // imported balances. mixedAsOfDates describes only differing known dates.
    summary.asOfDate = null;
  }
  if (unresolvedLoans > 0) summary.debtCompleteness = 'partial';
  const complete = summary.assetsCompleteness === 'complete' && summary.debtCompleteness === 'complete';
  summary.netAssets = complete ? (BigInt(summary.grossAssets!) - BigInt(summary.debt!)).toString() : null;
  summary.completeness = effectiveManual.length === 0 && included.length === 0 && unresolvedLoans === 0
    ? 'empty' : complete ? 'complete' : 'partial';
  return { manualItems: [...manuals.values()], loanItems, summary, unresolvedLoans };
}
