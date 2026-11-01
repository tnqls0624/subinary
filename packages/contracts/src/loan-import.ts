import { z } from 'zod';
import { manualAssetSchema, manualAssetSummarySchema, manualFinanceDateSchema, manualKrwAmountSchema } from './manual-finance.js';

const loanAmount = manualKrwAmountSchema.refine(value => !/\s/.test(value), '금액에 공백을 넣을 수 없습니다.');
const loanDate = z.string().length(10).pipe(manualFinanceDateSchema);

/** A user-reviewed browser observation, not a bank-signed response or credential. */
const captureObject = z.object({
  formatVersion: z.literal(1), provider: z.literal('shinhan'), source: z.literal('browser_assisted'),
  origin: z.literal('https://bank.shinhan.com'), pageKind: z.literal('loan_account_list'),
  capturedAt: z.string().datetime({ offset: true }),
  accountFingerprint: z.string().length(64).regex(/^[0-9a-f]{64}$/),
  accountLast4: z.string().length(4).regex(/^[0-9]{4}$/),
  loanType: z.enum(['interim', 'jeonse']),
  outstandingPrincipalKrw: loanAmount,
  maturityDate: loanDate.nullable(),
  // The inspected current-balance screen does not establish the bank's valuation timestamp.
  bankAsOfDate: z.null(),
}).strict();
// Zod intentionally drops __proto__ while parsing objects. For a fixed interchange
// format, reject that unexpected own key before parsing instead of silently dropping it.
export const shinhanLoanCaptureSchema = z.preprocess((value, ctx) => {
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, '__proto__')) {
    ctx.addIssue({ code: 'custom', message: '지원하지 않는 확인 파일 필드입니다.' });
    return z.NEVER;
  }
  return value;
}, captureObject);
export type ShinhanLoanCapture = z.infer<typeof shinhanLoanCaptureSchema>;

const version = z.number().int().positive().max(2147483647);
export const loanTotalModeSchema = z.enum(['reference', 'distinct', 'replacement']);
export type LoanTotalMode = z.infer<typeof loanTotalModeSchema>;
const reviewFields = {
  label: z.string().trim().min(1).max(100),
  visibility: z.enum(['private', 'household']),
  totalMode: loanTotalModeSchema,
  replacesManualAssetId: z.string().uuid().nullable(),
  manualExpectedVersion: version.nullable(),
  confirmedSharing: z.boolean(),
};
type ReviewFields = { visibility: string; totalMode: string; replacesManualAssetId: string | null; manualExpectedVersion: number | null; confirmedSharing: boolean };
function checkReview(value: ReviewFields, ctx: z.RefinementCtx): void {
  if (value.visibility === 'household' && !value.confirmedSharing) {
    ctx.addIssue({ code: 'custom', path: ['confirmedSharing'], message: '가족에게 보여줄 내용을 확인해 주세요.' });
  }
  if (value.totalMode === 'replacement') {
    if (value.replacesManualAssetId === null || value.manualExpectedVersion === null) {
      ctx.addIssue({ code: 'custom', path: ['replacesManualAssetId'], message: '연결할 기존 대출을 선택해 주세요.' });
    }
  } else if (value.replacesManualAssetId !== null || value.manualExpectedVersion !== null) {
    ctx.addIssue({ code: 'custom', path: ['replacesManualAssetId'], message: '기존 대출 연결을 다시 확인해 주세요.' });
  }
}

export const loanImportPreviewRequestSchema = z.object({ householdId: z.string().uuid(), capture: shinhanLoanCaptureSchema }).strict();
export type LoanImportPreviewRequest = z.infer<typeof loanImportPreviewRequestSchema>;
export const loanImportCommitRequestSchema = z.object({
  requestId: z.string().uuid(), recordId: z.string().uuid(), householdId: z.string().uuid(),
  expectedVersion: version.nullable(), capture: shinhanLoanCaptureSchema,
  confirmedOwnAccount: z.literal(true), confirmedValues: z.literal(true), ...reviewFields,
}).strict().superRefine(checkReview);
export type LoanImportCommitRequest = z.infer<typeof loanImportCommitRequestSchema>;
export const loanImportUpdateRequestSchema = z.object({ expectedVersion: version, ...reviewFields }).strict().superRefine(checkReview);
export type LoanImportUpdateRequest = z.infer<typeof loanImportUpdateRequestSchema>;
export const loanImportDeleteRequestSchema = z.object({ expectedVersion: version }).strict();
export type LoanImportDeleteRequest = z.infer<typeof loanImportDeleteRequestSchema>;

export const importedLoanRecordSchema = z.object({
  id: z.string().uuid(), householdId: z.string().uuid(), ownerUserId: z.string().uuid(), version,
  label: z.string(), visibility: z.enum(['private', 'household']), totalMode: loanTotalModeSchema,
  replacesManualAssetId: z.string().uuid().nullable(), manualExpectedVersion: version.nullable(),
  accountLast4: z.string().length(4).regex(/^[0-9]{4}$/), loanType: z.enum(['interim', 'jeonse']),
  outstandingPrincipalKrw: loanAmount, maturityDate: loanDate.nullable(),
  capturedAt: z.string().datetime({ offset: true }), bankAsOfDate: z.null(),
  source: z.literal('shinhan_browser'), canEdit: z.boolean(),
  includedInTotals: z.boolean(),
  exclusionReason: z.enum(['reference', 'replacement_changed', 'duplicate_visible_loan', 'sharing_expired']).nullable(),
  createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type ImportedLoanRecord = z.infer<typeof importedLoanRecordSchema>;
export const loanImportPreviewResponseSchema = z.object({
  capture: shinhanLoanCaptureSchema, existing: importedLoanRecordSchema.nullable(),
  replacementOptions: z.array(manualAssetSchema),
}).strict();
export type LoanImportPreviewResponse = z.infer<typeof loanImportPreviewResponseSchema>;
export const loanImportRecordResponseSchema = z.object({ item: importedLoanRecordSchema }).strict();
export type LoanImportRecordResponse = z.infer<typeof loanImportRecordResponseSchema>;
export const loanImportRecordListResponseSchema = z.object({ items: z.array(importedLoanRecordSchema) }).strict();
export type LoanImportRecordListResponse = z.infer<typeof loanImportRecordListResponseSchema>;
export const financialOverviewQuerySchema = z.object({ householdId: z.string().uuid(), scope: z.enum(['household', 'private']).default('household') }).strict();
export type FinancialOverviewQuery = z.infer<typeof financialOverviewQuerySchema>;
export const financialOverviewResponseSchema = z.object({
  manualItems: z.array(manualAssetSchema), loanItems: z.array(importedLoanRecordSchema),
  summary: manualAssetSummarySchema, unresolvedLoans: z.number().int().nonnegative(),
}).strict();
export type FinancialOverviewResponse = z.infer<typeof financialOverviewResponseSchema>;
