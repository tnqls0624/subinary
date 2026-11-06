import { z } from 'zod';

/** 수동 기록 전용 계약. 카드 거래·자동 수집·법적 소유권을 나타내지 않는다. */
export const manualFinanceScopeSchema = z.enum(['household', 'private']);
export type ManualFinanceScope = z.infer<typeof manualFinanceScopeSchema>;
export const manualFinanceVisibilitySchema = z.enum(['private', 'household']);
export type ManualFinanceVisibility = z.infer<typeof manualFinanceVisibilitySchema>;
export const manualFinanceListQuerySchema = z.object({ householdId: z.string().uuid(), scope: manualFinanceScopeSchema.default('household') }).strict();
export type ManualFinanceListQuery = z.infer<typeof manualFinanceListQuerySchema>;
export const manualAssetKindSchema = z.enum(['account', 'saving', 'stock', 'loan']);
export type ManualAssetKind = z.infer<typeof manualAssetKindSchema>;

/** numeric(20,0)와 일치한다. JSON number/지수/부호/소수/선행 0을 받지 않는다. */
export const manualKrwAmountSchema = z.string().regex(/^(0|[1-9]\d{0,19})$/, '금액은 20자리 이하의 0 이상 정수 원으로 입력해 주세요.');

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

function seoulToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value).join('-');
}

export const manualFinanceDateSchema = z.string().refine(calendarDate, '실제 날짜를 YYYY-MM-DD 형식으로 입력해 주세요.');
const recordedDateSchema = manualFinanceDateSchema.refine((value) => value <= seoulToday(), '기준일·지급일은 서울 기준 오늘 이후일 수 없습니다.');

/**
 * 적금 자동 납입(2026-11-04). 기준일 다음 날부터 매월 `day`일(그 달에 없으면 말일)에 `monthlyAmount`를
 * 더해 현재 적립액을 계산한다. 원금만 더하고 이자는 넣지 않는다. 만기일이 있으면 그날까지만 더한다.
 */
export const manualSavingsPlanSchema = z.object({
  monthlyAmount: manualKrwAmountSchema.refine((value) => value !== '0', '매월 넣는 금액은 1원 이상이어야 해요.'),
  day: z.number().int().min(1).max(31),
  endDate: manualFinanceDateSchema.nullable(),
}).strict();
export type ManualSavingsPlan = z.infer<typeof manualSavingsPlanSchema>;
/** 응답의 자동 납입 상태. 자산의 amount·asOfDate는 기준 금액에 납입을 더한 현재 값이다. */
export const manualSavingsStatusSchema = manualSavingsPlanSchema.extend({
  /** 사용자가 입력한 기준 금액·기준일. */
  baseAmount: manualKrwAmountSchema,
  baseAsOfDate: manualFinanceDateSchema,
  /** 기준일 다음 날부터 지금까지 더한 납입 횟수. */
  contributions: z.number().int().nonnegative(),
}).strict();
export type ManualSavingsStatus = z.infer<typeof manualSavingsStatusSchema>;
const nullableNote = z.string().trim().min(1).max(1000).nullable();
const labelSchema = z.string().trim().min(1).max(100);
const versionSchema = z.number().int().positive().max(2147483647);
const assetFields = {
  kind: manualAssetKindSchema,
  label: labelSchema,
  visibility: manualFinanceVisibilitySchema,
  amount: manualKrwAmountSchema.nullable(),
  asOfDate: recordedDateSchema.nullable(),
  source: z.literal('manual').nullable(),
  /** 직접 적은 명의 표시일 뿐 검증된 법적 소유·지분 정보가 아니다. */
  legalOwnerLabel: z.string().trim().min(1).max(100).nullable(),
  note: nullableNote,
};

function checkAsset(input: { kind: ManualAssetKind; amount: string | null; asOfDate: string | null; source: 'manual' | null; savingsPlan?: object | null }, ctx: z.RefinementCtx): void {
  if (input.amount === null) {
    if (input.asOfDate !== null || input.source !== null) ctx.addIssue({ code: 'custom', path: ['amount'], message: '금액 미입력 시 기준일과 출처도 미입력으로 남겨 주세요.' });
  } else if (input.asOfDate === null || input.source !== 'manual') {
    ctx.addIssue({ code: 'custom', path: ['asOfDate'], message: '금액에는 기준일과 직접 입력 출처가 필요합니다.' });
  }
  // 자동 납입은 기준 금액이 있는 적금에만 둔다(DB manual_assets_contribution_check와 같다).
  if (input.savingsPlan && (input.kind !== 'saving' || input.amount === null)) {
    ctx.addIssue({ code: 'custom', path: ['savingsPlan'], message: '자동 납입은 현재 적립액과 기준일을 입력한 적금에만 쓸 수 있어요.' });
  }
}

export const manualAssetCreateRequestSchema = z.object({
  /** 한 번의 작성 동작에 고정한 UUID. 재시도에도 같은 ID와 원래 입력을 보낸다. */
  id: z.string().uuid(),
  householdId: z.string().uuid(),
  ...assetFields,
  visibility: manualFinanceVisibilitySchema.default('private'),
  savingsPlan: manualSavingsPlanSchema.nullable().optional(),
}).strict().superRefine(checkAsset);
export type ManualAssetCreateRequest = z.infer<typeof manualAssetCreateRequestSchema>;
export const manualAssetUpdateRequestSchema = z.object({
  expectedVersion: versionSchema,
  ...assetFields,
  /** 없으면(옛 앱) 기존 계획을 유지하고, null이면 지운다. */
  savingsPlan: manualSavingsPlanSchema.nullable().optional(),
}).strict().superRefine(checkAsset);
export type ManualAssetUpdateRequest = z.infer<typeof manualAssetUpdateRequestSchema>;

const recordFields = {
  id: z.string().uuid(), householdId: z.string().uuid(), ownerUserId: z.string().uuid(),
  version: versionSchema, createdAt: z.string(), updatedAt: z.string(), canEdit: z.boolean(),
};
/** `savingsPlan`은 계획이 있는 자산에만 붙는다 — 계획이 없을 때 키를 만들지 않아야 옛 앱 번들(strict)이 읽는다. */
export const manualAssetSchema = z.object({ ...recordFields, ...assetFields, currency: z.literal('KRW'), savingsPlan: manualSavingsStatusSchema.optional() }).strict().superRefine(checkAsset);
export type ManualAsset = z.infer<typeof manualAssetSchema>;
const completenessSchema = z.enum(['empty', 'partial', 'complete']);
const aggregateAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const manualAssetSummarySchema = z.object({
  currency: z.literal('KRW'),
  /** partial이면 알려진 항목의 부분합이다. 항목이 없거나 모두 미입력이면 null. */
  grossAssets: aggregateAmountSchema.nullable(),
  debt: aggregateAmountSchema.nullable(),
  /** 양쪽 집합이 모두 complete일 때만 산출한다. 음수도 가능하다. */
  netAssets: z.string().regex(/^(0|-?[1-9]\d*)$/).nullable(),
  assetsCompleteness: completenessSchema, debtCompleteness: completenessSchema, completeness: completenessSchema,
  asOfDate: manualFinanceDateSchema.nullable(), oldestAsOfDate: manualFinanceDateSchema.nullable(), newestAsOfDate: manualFinanceDateSchema.nullable(),
  mixedAsOfDates: z.boolean(),
}).strict();
export type ManualAssetSummary = z.infer<typeof manualAssetSummarySchema>;
export const manualAssetResponseSchema = z.object({ item: manualAssetSchema }).strict();
export type ManualAssetResponse = z.infer<typeof manualAssetResponseSchema>;
export const manualAssetListResponseSchema = z.object({ items: z.array(manualAssetSchema), summary: manualAssetSummarySchema }).strict();
export type ManualAssetListResponse = z.infer<typeof manualAssetListResponseSchema>;

export const manualHousingPaymentKindSchema = z.enum(['contract', 'interim', 'balance', 'option']);
export type ManualHousingPaymentKind = z.infer<typeof manualHousingPaymentKindSchema>;
/** 숫자 출처. null은 예전 직접 입력 행. */
export const manualHousingValueSourceSchema = z.enum(['manual', 'sujain_fetch', 'confirmed']);
export type ManualHousingValueSource = z.infer<typeof manualHousingValueSourceSchema>;
/** Asia/Seoul 표시용 YYYY-MM-DD HH:mm */
export const manualHousingAsOfSeoulSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
export const manualHousingPaymentInputSchema = z.object({
  id: z.string().uuid(), kind: manualHousingPaymentKindSchema,
  installment: z.number().int().positive().max(1000).nullable(),
  /** 옵션 품목 이름. */
  label: z.string().trim().min(1).max(100).nullable().optional(),
  dueDate: manualFinanceDateSchema.nullable(), amount: manualKrwAmountSchema.nullable(),
  paidAmount: manualKrwAmountSchema.nullable(), paidDate: recordedDateSchema.nullable(),
  amountSource: manualHousingValueSourceSchema.nullable().optional(),
  amountAsOfAt: z.string().datetime({ offset: true }).nullable().optional(),
  paidAmountSource: manualHousingValueSourceSchema.nullable().optional(),
  paidAmountAsOfAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().superRefine((input, ctx) => {
  // 형식 오류는 기본 스키마가 보고한다. 잘못된 문자열을 BigInt에 넘겨 예외로 바꾸지 않는다.
  if ((input.amount !== null && !manualKrwAmountSchema.safeParse(input.amount).success)
    || (input.paidAmount !== null && !manualKrwAmountSchema.safeParse(input.paidAmount).success)) return;
  if (input.paidAmount !== null && (input.amount === null || BigInt(input.paidAmount) > BigInt(input.amount))) {
    ctx.addIssue({ code: 'custom', path: ['paidAmount'], message: '지급액에는 예정 금액이 필요하며 예정 금액을 초과할 수 없습니다.' });
  }
  if (input.paidAmount !== null && BigInt(input.paidAmount) > 0n) {
    if (input.paidDate === null) ctx.addIssue({ code: 'custom', path: ['paidDate'], message: '지급액이 있으면 실제 지급일을 입력해 주세요.' });
  } else if (input.paidDate !== null) {
    ctx.addIssue({ code: 'custom', path: ['paidDate'], message: '지급일에는 0보다 큰 지급액이 필요합니다.' });
  }
  if (input.amount === null && (input.amountSource != null || input.amountAsOfAt != null)) {
    ctx.addIssue({ code: 'custom', path: ['amountSource'], message: '예정 금액이 없으면 출처와 기준시각도 비워 주세요.' });
  }
  if (input.paidAmount === null && (input.paidAmountSource != null || input.paidAmountAsOfAt != null)) {
    ctx.addIssue({ code: 'custom', path: ['paidAmountSource'], message: '낸 금액이 없으면 출처와 기준시각도 비워 주세요.' });
  }
});
export type ManualHousingPaymentInput = z.infer<typeof manualHousingPaymentInputSchema>;
export const manualHousingPaymentSchema = manualHousingPaymentInputSchema.safeExtend({
  planId: z.string().uuid(),
  /** 남은 금액. 예정·낸 금액이 있을 때만. */
  remainingAmount: manualKrwAmountSchema.nullable().optional(),
  /** unpaid | partial | paid | unknown */
  status: z.enum(['unpaid', 'partial', 'paid', 'unknown']).optional(),
  amountAsOfSeoul: manualHousingAsOfSeoulSchema.nullable().optional(),
  paidAmountAsOfSeoul: manualHousingAsOfSeoulSchema.nullable().optional(),
});
export type ManualHousingPayment = z.infer<typeof manualHousingPaymentSchema>;
const housingFields = {
  label: labelSchema, visibility: manualFinanceVisibilitySchema,
  occupancyYear: z.number().int().min(1).max(9999).nullable(),
  contractStage: z.string().trim().min(1).max(100).nullable(),
  /** 용도 메모만 저장한다. 자산 연결·재원 예약·전망 계산은 하지 않는다. */
  fundingNote: z.string().trim().min(1).max(2000).nullable(),
};
const paymentsSchema = z.array(manualHousingPaymentInputSchema).max(100).refine((items) => new Set(items.map((item) => item.id.toLowerCase())).size === items.length, '지급 기록 ID를 중복할 수 없습니다.');
export const manualHousingPlanCreateRequestSchema = z.object({ id: z.string().uuid(), householdId: z.string().uuid(), ...housingFields, visibility: manualFinanceVisibilitySchema.default('private'), payments: paymentsSchema }).strict();
export type ManualHousingPlanCreateRequest = z.infer<typeof manualHousingPlanCreateRequestSchema>;
export const manualHousingPlanUpdateRequestSchema = z.object({ expectedVersion: versionSchema, ...housingFields, payments: paymentsSchema }).strict();
export type ManualHousingPlanUpdateRequest = z.infer<typeof manualHousingPlanUpdateRequestSchema>;
export const manualHousingPlanSchema = z.object({ ...recordFields, ...housingFields }).strict();
export type ManualHousingPlan = z.infer<typeof manualHousingPlanSchema>;
/** housing-brand-sync와 순환 import를 피하려고 최소 형태만 둔다. */
const housingBrandConnectionSummarySchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  brand: z.literal('sujain'),
  status: z.enum(['connected', 'needs_confirmation', 'failed']),
  statusMessage: z.string().trim().min(1).max(200).nullable(),
  credentialsStored: z.boolean(),
  version: z.number().int().positive().max(2147483647),
  lastFetchAt: z.string().datetime({ offset: true }).nullable(),
  lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
  canManage: z.boolean(),
}).strict();
export const manualHousingPlanResponseSchema = z.object({
  item: manualHousingPlanSchema,
  payments: z.array(manualHousingPaymentSchema),
  /** 연결한 본인에게만 붙인다. 평문 자격증명은 없다. */
  brandConnection: housingBrandConnectionSummarySchema.nullable().optional(),
}).strict();
export type ManualHousingPlanResponse = z.infer<typeof manualHousingPlanResponseSchema>;
export const manualHousingSummarySchema = z.object({
  /** 입력된 미지급 일정 중 가장 이른 행. 현금 전망이나 전체 일정의 확정값이 아니다. */
  nextPayment: z.object({
    planId: z.string().uuid(), paymentId: z.string().uuid(), label: labelSchema,
    kind: manualHousingPaymentKindSchema, installment: z.number().int().positive().max(1000).nullable(),
    dueDate: manualFinanceDateSchema, remainingAmountKrw: manualKrwAmountSchema,
  }).strict().nullable(),
  hasIncompletePayments: z.boolean(),
}).strict();
export type ManualHousingSummary = z.infer<typeof manualHousingSummarySchema>;
export const manualHousingPlanListResponseSchema = z.object({ items: z.array(manualHousingPlanSchema), summary: manualHousingSummarySchema }).strict();
export type ManualHousingPlanListResponse = z.infer<typeof manualHousingPlanListResponseSchema>;
export const manualFinanceDeleteRequestSchema = z.object({ expectedVersion: versionSchema }).strict();
export type ManualFinanceDeleteRequest = z.infer<typeof manualFinanceDeleteRequestSchema>;
export const manualFinanceDeleteResponseSchema = z.object({ deleted: z.boolean() }).strict();
export type ManualFinanceDeleteResponse = z.infer<typeof manualFinanceDeleteResponseSchema>;
