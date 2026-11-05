import { z } from 'zod';

/** 가족 원장 MVP 1차 계약. OpenAccount/CreateGoal/CloseGoal/UpsertBudgetRule는 2차. */

/** manual-finance와 같은 KRW 정수 문자열(선행 0·소수·부호 거부). */
export const ledgerKrwAmountSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/, '금액은 20자리 이하의 0 이상 정수 원으로 입력해 주세요.')
  .refine((value) => value !== '0', '금액은 1원 이상이어야 해요.');

export const ledgerAccountKindSchema = z.enum([
  'checking',
  'savings',
  'cash',
  'loan',
  'investment',
]);
export type LedgerAccountKind = z.infer<typeof ledgerAccountKindSchema>;

export const ledgerTxnKindSchema = z.enum([
  'expense',
  'income',
  'transfer_out',
  'transfer_in',
]);
export type LedgerTxnKind = z.infer<typeof ledgerTxnKindSchema>;

const memoSchema = z.string().trim().min(1).max(500).nullable().optional();

/** RecordTransaction — 단일 계좌 지출·수입. */
export const recordTransactionRequestSchema = z
  .object({
    householdId: z.string().uuid(),
    accountId: z.string().uuid(),
    kind: z.enum(['expense', 'income']),
    amount: ledgerKrwAmountSchema,
    categoryId: z.string().uuid().nullable().optional(),
    memo: memoSchema,
    occurredAt: z.string().datetime({ offset: true }),
    /** 클라이언트가 한 사용자 동작에 고정한 멱등 키. */
    idempotencyKey: z.string().uuid(),
    /** 거래 행 ID(재시도 동일). 생략 시 서버가 생성. */
    id: z.string().uuid().optional(),
  })
  .strict();
export type RecordTransactionRequest = z.infer<typeof recordTransactionRequestSchema>;

/**
 * TransferBetweenAccounts — 두 Account 간 이체.
 * 선택적 goalId로 목표 적립을 표현한다(ContributeToGoal 별도 액션 없음).
 */
export const transferBetweenAccountsRequestSchema = z
  .object({
    householdId: z.string().uuid(),
    fromAccountId: z.string().uuid(),
    toAccountId: z.string().uuid(),
    amount: ledgerKrwAmountSchema,
    goalId: z.string().uuid().nullable().optional(),
    memo: memoSchema,
    occurredAt: z.string().datetime({ offset: true }),
    idempotencyKey: z.string().uuid(),
    /** 이체 쌍을 묶는 UUID. 생략 시 서버가 생성. */
    transferGroupId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => v.fromAccountId !== v.toAccountId, {
    message: '같은 계좌로는 이체할 수 없어요.',
    path: ['toAccountId'],
  });
export type TransferBetweenAccountsRequest = z.infer<
  typeof transferBetweenAccountsRequestSchema
>;

export const accountTransactionSummarySchema = z
  .object({
    id: z.string().uuid(),
    householdId: z.string().uuid(),
    accountId: z.string().uuid(),
    personId: z.string().uuid(),
    categoryId: z.string().uuid().nullable(),
    kind: ledgerTxnKindSchema,
    amount: z.string(),
    currency: z.literal('KRW'),
    memo: z.string().nullable(),
    counterpartyAccountId: z.string().uuid().nullable(),
    transferGroupId: z.string().uuid().nullable(),
    goalId: z.string().uuid().nullable(),
    occurredAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type AccountTransactionSummary = z.infer<typeof accountTransactionSummarySchema>;

export const recordTransactionResponseSchema = z
  .object({
    transaction: accountTransactionSummarySchema,
    accountBalance: z.string(),
    replayed: z.boolean(),
  })
  .strict();
export type RecordTransactionResponse = z.infer<typeof recordTransactionResponseSchema>;

export const transferBetweenAccountsResponseSchema = z
  .object({
    transferGroupId: z.string().uuid(),
    outbound: accountTransactionSummarySchema,
    inbound: accountTransactionSummarySchema,
    fromAccountBalance: z.string(),
    toAccountBalance: z.string(),
    goalSavedAmount: z.string().nullable(),
    replayed: z.boolean(),
  })
  .strict();
export type TransferBetweenAccountsResponse = z.infer<
  typeof transferBetweenAccountsResponseSchema
>;

export const canSpendQuerySchema = z
  .object({
    householdId: z.string().uuid(),
  })
  .strict();
export type CanSpendQuery = z.infer<typeof canSpendQuerySchema>;

export const canSpendDecisionSchema = z.enum(['ok', 'caution', 'no']);
export type CanSpendDecision = z.infer<typeof canSpendDecisionSchema>;

export const canSpendRecentTxnSchema = z
  .object({
    id: z.string().uuid(),
    kind: ledgerTxnKindSchema,
    amount: z.string(),
    accountId: z.string().uuid(),
    memo: z.string().nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** '지금 써도 되나' — 잔액과 최근 거래를 통합한 판단. */
export const canSpendResponseSchema = z
  .object({
    decision: canSpendDecisionSchema,
    /** 가용 현금성 잔액 합(checking+savings+cash). 대출·투자는 제외. */
    availableKrw: z.string(),
    /** 최근 7일 지출(expense + transfer_out 중 목표 적립 제외) 합. */
    recentSpendKrw: z.string(),
    /** 이번 달 예산 규칙 잔여(규칙 없으면 null). */
    budgetRemainingKrw: z.string().nullable(),
    reasons: z.array(z.string().min(1).max(200)),
    recentTransactions: z.array(canSpendRecentTxnSchema).max(20),
    asOf: z.string().datetime({ offset: true }),
  })
  .strict();
export type CanSpendResponse = z.infer<typeof canSpendResponseSchema>;
