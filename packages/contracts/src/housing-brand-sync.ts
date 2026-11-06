import { z } from 'zod';
import { manualFinanceDateSchema, manualHousingPaymentKindSchema, manualKrwAmountSchema } from './manual-finance.js';

/** 수자인만. 공개 분양 소개 조회 UI·호반 수납조회와 섞지 않는다. */
export const housingBrandSchema = z.literal('sujain');
export type HousingBrand = z.infer<typeof housingBrandSchema>;

export const housingBrandConnectionStatusSchema = z.enum(['connected', 'needs_confirmation', 'failed']);
export type HousingBrandConnectionStatus = z.infer<typeof housingBrandConnectionStatusSchema>;

/** API·화면 표시용. 평문 아이디·비밀번호는 절대 넣지 않는다. */
export const housingBrandConnectionSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  brand: housingBrandSchema,
  status: housingBrandConnectionStatusSchema,
  /** 실패·확인 안내. 비밀번호를 반복하지 않는다. */
  statusMessage: z.string().trim().min(1).max(200).nullable(),
  credentialsStored: z.boolean(),
  version: z.number().int().positive().max(2147483647),
  lastFetchAt: z.string().datetime({ offset: true }).nullable(),
  lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
  /** 연결한 본인만 true. 다른 가족에게는 brandConnection 자체를 붙이지 않는다. */
  canManage: z.boolean(),
}).strict();
export type HousingBrandConnection = z.infer<typeof housingBrandConnectionSchema>;

const loginIdSchema = z.string().min(1).max(64).refine((value) => !/[^A-Za-z0-9._@-]/u.test(value));
const passwordSchema = z.string().min(1).max(64).refine((value) => !/[^\x21-\x7e]/u.test(value));

/** 주택 추가·열기 화면의 같은 아이디·비밀번호 칸. 조회용 별도 로그인 폼이 아니다. */
export const housingBrandConnectRequestSchema = z.object({
  householdId: z.string().uuid(),
  brand: housingBrandSchema,
  loginId: loginIdSchema,
  password: passwordSchema,
  expectedPlanVersion: z.number().int().positive().max(2147483647),
}).strict();
export type HousingBrandConnectRequest = z.infer<typeof housingBrandConnectRequestSchema>;

export const housingBrandConnectResponseSchema = z.object({
  connection: housingBrandConnectionSchema,
}).strict();
export type HousingBrandConnectResponse = z.infer<typeof housingBrandConnectResponseSchema>;

export const housingBrandSyncErrorSchema = z.enum([
  'credentials_invalid',
  'authentication_required',
  'network_error',
  'unsupported_layout',
  'runtime_unavailable',
  'operation_unknown',
  'not_connected',
]);
export type HousingBrandSyncError = z.infer<typeof housingBrandSyncErrorSchema>;

export const housingBrandFetchedItemSchema = z.object({
  /** 확인 목록에서 고를 때 쓰는 임시 키. 일정 id가 아님. */
  key: z.string().uuid(),
  kind: manualHousingPaymentKindSchema,
  installment: z.number().int().positive().max(1000).nullable(),
  label: z.string().trim().min(1).max(100).nullable(),
  scheduledAmount: manualKrwAmountSchema.nullable(),
  dueDate: manualFinanceDateSchema.nullable(),
  paidAmount: manualKrwAmountSchema.nullable(),
  paidDate: manualFinanceDateSchema.nullable(),
  /** 사이트에 있을 때만. */
  actualPaidDate: manualFinanceDateSchema.nullable(),
  /** 이미 있는 일정과 맞춘 id. 새로 추가 후보는 null. */
  matchedPaymentId: z.string().uuid().nullable(),
  /** 기존 일정이 있으면 달라진 칸만. 새 항목이면 읽힌 칸 전부. */
  changedFields: z.array(z.enum([
    'kind', 'installment', 'label', 'scheduledAmount', 'dueDate', 'paidAmount', 'paidDate', 'actualPaidDate',
  ])).max(8),
  unreadFields: z.array(z.object({
    field: z.enum([
      'kind', 'installment', 'label', 'scheduledAmount', 'dueDate', 'paidAmount', 'paidDate', 'actualPaidDate',
    ]),
    reason: z.string().trim().min(1).max(200),
  }).strict()).max(8),
}).strict();
export type HousingBrandFetchedItem = z.infer<typeof housingBrandFetchedItemSchema>;

export const housingBrandSyncPreviewSchema = z.object({
  fetchedAt: z.string().datetime({ offset: true }),
  /** Asia/Seoul 표시용 YYYY-MM-DD HH:mm */
  fetchedAtSeoul: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
  source: z.literal('sujain_fetch'),
  items: z.array(housingBrandFetchedItemSchema).max(100),
  unreadCount: z.number().int().nonnegative(),
  unreadReasons: z.array(z.string().trim().min(1).max(200)).max(50),
  connection: housingBrandConnectionSchema,
}).strict();
export type HousingBrandSyncPreview = z.infer<typeof housingBrandSyncPreviewSchema>;

export const housingBrandSyncRequestSchema = z.object({
  householdId: z.string().uuid(),
  expectedConnectionVersion: z.number().int().positive().max(2147483647),
}).strict();
export type HousingBrandSyncRequest = z.infer<typeof housingBrandSyncRequestSchema>;

/** 확인 목록에서 고른 키만 보낸다. 금액·날짜는 서버에 저장한 미리보기를 쓴다. */
export const housingBrandApplySelectionSchema = z.object({
  key: z.string().uuid(),
}).strict();
export type HousingBrandApplySelection = z.infer<typeof housingBrandApplySelectionSchema>;

export const housingBrandApplyRequestSchema = z.object({
  householdId: z.string().uuid(),
  expectedPlanVersion: z.number().int().positive().max(2147483647),
  expectedConnectionVersion: z.number().int().positive().max(2147483647),
  selections: z.array(housingBrandApplySelectionSchema).min(1).max(100),
}).strict();
export type HousingBrandApplyRequest = z.infer<typeof housingBrandApplyRequestSchema>;

export const housingBrandStoredPreviewSchema = z.object({
  fetchedAt: z.string().datetime({ offset: true }),
  items: z.array(housingBrandFetchedItemSchema).max(100),
}).strict();
export type HousingBrandStoredPreview = z.infer<typeof housingBrandStoredPreviewSchema>;

export const HOUSING_BRAND_STATUS_LABEL = {
  connected: '연결됨',
  needs_confirmation: '확인 필요',
  failed: '실패',
} as const;

export const HOUSING_VALUE_SOURCE_LABEL = {
  manual: '직접 입력',
  sujain_fetch: '신축 조회',
  confirmed: '연결 후 사람 확인',
} as const;

export const SUJAIN_OFFICIAL = {
  site: 'https://www.sujain.co.kr/',
  login: 'https://www.sujain.co.kr/login',
  payment: 'https://www.sujain.co.kr/mypage/payment',
  unitItems: 'https://www.sujain.co.kr/mypage/unit-items',
  allowedHosts: ['www.sujain.co.kr', 'm.sujain.co.kr'] as const,
} as const;
