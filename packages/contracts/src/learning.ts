import { z } from 'zod';

/** 현재 공개 snapshot builder가 지원하는 학습/평가 태스크. */
export const learningDatasetTaskSchema = z.enum([
  'memory-candidate',
  'merchant-category',
  'rag-embedding',
]);
export type LearningDatasetTask = z.infer<typeof learningDatasetTaskSchema>;

/** immutable dataset snapshot 상태. */
export const datasetSnapshotStatusSchema = z.enum([
  'draft',
  'validated',
  'approved',
  'revoked',
]);
export type DatasetSnapshotStatus = z.infer<typeof datasetSnapshotStatusSchema>;

/** snapshot 생성 시 선택하는 group-aware split 방식. */
export const datasetSplitStrategySchema = z.enum(['group_time', 'group_hash']);
export type DatasetSplitStrategy = z.infer<typeof datasetSplitStrategySchema>;

const datasetSplitRequestShape = {
  splitSeed: z.string().trim().min(1).max(128).optional(),
  splitStrategy: datasetSplitStrategySchema.optional(),
  validationWindowDays: z.number().int().min(1).max(3_650).optional(),
  testWindowDays: z.number().int().min(1).max(3_650).optional(),
};

function validateDatasetSplitRequest(
  value: {
    splitStrategy?: DatasetSplitStrategy;
    validationWindowDays?: number;
    testWindowDays?: number;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.splitStrategy === 'group_hash' &&
    (value.validationWindowDays !== undefined ||
      value.testWindowDays !== undefined)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'time windows require group_time split strategy',
      path: ['splitStrategy'],
    });
  }
}

/** `POST /v1/learning/datasets/memory-candidate` 요청. */
export const memoryCandidateDatasetCreateRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    ...datasetSplitRequestShape,
  })
  .superRefine(validateDatasetSplitRequest);
export type MemoryCandidateDatasetCreateRequest = z.infer<
  typeof memoryCandidateDatasetCreateRequestSchema
>;

/** `POST /v1/learning/datasets/merchant-category` 요청. */
export const merchantCategoryDatasetCreateRequestSchema = z
  .object({
    householdId: z.string().uuid(),
    ...datasetSplitRequestShape,
  })
  .superRefine(validateDatasetSplitRequest);
export type MerchantCategoryDatasetCreateRequest = z.infer<
  typeof merchantCategoryDatasetCreateRequestSchema
>;

/** 사용자가 검색 결과의 관련성을 명시적으로 확정하는 피드백 요청. */
export const ragRetrievalFeedbackCreateRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  query: z.string().trim().min(1).max(2_000),
  relevantChunkId: z.string().uuid(),
  consent: z.literal(true),
});
export type RagRetrievalFeedbackCreateRequest = z.infer<
  typeof ragRetrievalFeedbackCreateRequestSchema
>;

/** 원문 질의와 object key를 제외한 검색 관련성 피드백 접수 결과. */
export const ragRetrievalFeedbackResponseSchema = z.object({
  id: z.string().uuid(),
  feedbackEventId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  chunkId: z.string().uuid(),
  chunkRevisionId: z.string().uuid(),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal('recorded'),
  occurredAt: z.string(),
});
export type RagRetrievalFeedbackResponse = z.infer<
  typeof ragRetrievalFeedbackResponseSchema
>;

/** `POST /v1/learning/datasets/rag-embedding` 요청. */
export const ragEmbeddingDatasetCreateRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    ...datasetSplitRequestShape,
  })
  .superRefine(validateDatasetSplitRequest);
export type RagEmbeddingDatasetCreateRequest = z.infer<
  typeof ragEmbeddingDatasetCreateRequestSchema
>;

/** dataset artifact의 split별 예제 수. */
export const datasetSplitCountsSchema = z.object({
  train: z.number().int().nonnegative(),
  validation: z.number().int().nonnegative(),
  test: z.number().int().nonnegative(),
});
export type DatasetSplitCounts = z.infer<typeof datasetSplitCountsSchema>;

/** dataset snapshot 공개 메타데이터. object key나 원문은 노출하지 않는다. */
export const datasetSnapshotSummarySchema = z.object({
  id: z.string().uuid(),
  task: learningDatasetTaskSchema,
  version: z.string(),
  schemaVersion: z.string(),
  status: datasetSnapshotStatusSchema,
  rowCount: z.number().int().nonnegative(),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  splitCounts: datasetSplitCountsSchema,
  createdAt: z.string(),
});
export type DatasetSnapshotSummary = z.infer<
  typeof datasetSnapshotSummarySchema
>;

/** `GET /v1/learning/datasets` 응답. */
export const datasetSnapshotListResponseSchema = z.object({
  items: z.array(datasetSnapshotSummarySchema),
});
export type DatasetSnapshotListResponse = z.infer<
  typeof datasetSnapshotListResponseSchema
>;

/** `POST /v1/learning/datasets/:datasetSnapshotId/approve` 응답. */
export const datasetSnapshotApprovalResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('approved'),
  approvedAt: z.string(),
});
export type DatasetSnapshotApprovalResponse = z.infer<
  typeof datasetSnapshotApprovalResponseSchema
>;

/** 개인정보 철회/삭제 요청으로 dataset과 파생 artifact를 폐기한다. */
export const datasetSnapshotRevokeRequestSchema = z.object({
  reason: z.enum(['consent_withdrawn', 'privacy_request']),
});
export type DatasetSnapshotRevokeRequest = z.infer<
  typeof datasetSnapshotRevokeRequestSchema
>;

export const datasetSnapshotRevokeResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('revoked'),
  revokedAt: z.string(),
  purgedArtifactCount: z.number().int().nonnegative(),
  revokedTrainingRunCount: z.number().int().nonnegative(),
});
export type DatasetSnapshotRevokeResponse = z.infer<
  typeof datasetSnapshotRevokeResponseSchema
>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const finiteMetricSchema = z.number().finite();

/** 모델/평가/alias가 속하는 단일 개인정보 경계. */
export const learningScopeSchema = z
  .object({
    workspaceId: z.string().uuid().optional(),
    householdId: z.string().uuid().optional(),
  })
  .refine(
    (value) =>
      Number(value.workspaceId !== undefined) +
        Number(value.householdId !== undefined) ===
      1,
    { message: 'exactly one learning scope is required' },
  );
export type LearningScope = z.infer<typeof learningScopeSchema>;

/** registry가 관리하는 태스크 식별자. */
export const learningModelTaskSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export type LearningModelTask = z.infer<typeof learningModelTaskSchema>;

/** 모델 registry 수명주기. */
export const modelRegistryStatusSchema = z.enum([
  'candidate',
  'approved',
  'rejected',
  'retired',
]);
export type ModelRegistryStatus = z.infer<typeof modelRegistryStatusSchema>;

/** owner/admin이 immutable 모델 identity를 registry에 등록하는 요청. */
export const modelRegistryCreateRequestSchema = learningScopeSchema.and(
  z.object({
    task: learningModelTaskSchema,
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(200),
    artifactHash: sha256Schema.optional(),
    dimensions: z.number().int().positive().max(100_000).optional(),
  }),
);
export type ModelRegistryCreateRequest = z.infer<
  typeof modelRegistryCreateRequestSchema
>;

/** object key나 credential을 제외한 모델 registry 공개 정보. */
export const modelRegistrySummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  householdId: z.string().uuid().nullable(),
  task: learningModelTaskSchema,
  provider: z.string(),
  model: z.string(),
  version: z.string(),
  artifactHash: sha256Schema.nullable(),
  dimensions: z.number().int().positive().nullable(),
  status: modelRegistryStatusSchema,
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ModelRegistrySummary = z.infer<typeof modelRegistrySummarySchema>;

/** 모델 registry 조회 범위. */
export const modelRegistryListQuerySchema = learningScopeSchema.and(
  z.object({ task: learningModelTaskSchema.optional() }),
);
export type ModelRegistryListQuery = z.infer<
  typeof modelRegistryListQuerySchema
>;

export const modelRegistryListResponseSchema = z.object({
  items: z.array(modelRegistrySummarySchema),
});
export type ModelRegistryListResponse = z.infer<
  typeof modelRegistryListResponseSchema
>;

/** 별도 Training Runner 실행 상태. */
export const trainingRunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'revoked',
]);
export type TrainingRunStatus = z.infer<typeof trainingRunStatusSchema>;

/** 승인 dataset으로 가맹점 분류 학습 실행을 요청한다. */
export const trainingRunCreateRequestSchema = z.object({
  datasetSnapshotId: z.string().uuid(),
});
export type TrainingRunCreateRequest = z.infer<
  typeof trainingRunCreateRequestSchema
>;

const trainingMetricSchema = z.object({
  rowCount: z.number().int().nonnegative(),
  correctCount: z.number().int().nonnegative(),
  accuracy: z.number().min(0).max(1),
  macroF1: z.number().min(0).max(1),
});

/** object key와 원문을 제외한 재현 환경 지문. */
export const trainingEnvironmentSummarySchema = z.object({
  codeHash: sha256Schema,
  dependencyLockHash: sha256Schema,
  nodeVersion: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
});
export type TrainingEnvironmentSummary = z.infer<
  typeof trainingEnvironmentSummarySchema
>;

/** 학습 결과 공개 지표. */
export const trainingMetricsSummarySchema = z.object({
  training: trainingMetricSchema,
  validation: trainingMetricSchema,
  test: trainingMetricSchema,
});
export type TrainingMetricsSummary = z.infer<
  typeof trainingMetricsSummarySchema
>;

/** artifact key를 제외한 학습 실행 메타데이터. */
export const trainingRunSummarySchema = z.object({
  id: z.string().uuid(),
  datasetSnapshotId: z.string().uuid(),
  modelRegistryId: z.string().uuid().nullable(),
  task: learningModelTaskSchema,
  trainerVersion: z.string().min(1),
  status: trainingRunStatusSchema,
  artifactHash: sha256Schema.nullable(),
  environment: trainingEnvironmentSummarySchema.nullable(),
  metrics: trainingMetricsSummarySchema.nullable(),
  errorCode: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TrainingRunSummary = z.infer<typeof trainingRunSummarySchema>;

export const trainingRunListQuerySchema = z.object({
  householdId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TrainingRunListQuery = z.infer<
  typeof trainingRunListQuerySchema
>;

export const trainingRunListResponseSchema = z.object({
  items: z.array(trainingRunSummarySchema),
});
export type TrainingRunListResponse = z.infer<
  typeof trainingRunListResponseSchema
>;

/** 평가 metric과 slice metric. 원문·샘플은 이 계약에 포함하지 않는다. */
export const modelMetricSetSchema = z.record(z.string(), finiteMetricSchema);
export type ModelMetricSet = z.infer<typeof modelMetricSetSchema>;
export const modelSliceMetricSetSchema = z.record(
  z.string().trim().min(1).max(100),
  modelMetricSetSchema,
);
export type ModelSliceMetricSet = z.infer<typeof modelSliceMetricSetSchema>;

export const modelGateCriterionSchema = z.object({
  metric: z.string().trim().min(1).max(100),
  slice: z.string().trim().min(1).max(100).optional(),
  comparison: z.enum(['candidate', 'delta']),
  operator: z.enum(['gte', 'lte']),
  threshold: finiteMetricSchema,
});
export type ModelGateCriterion = z.infer<typeof modelGateCriterionSchema>;

export const modelGateCriterionResultSchema = modelGateCriterionSchema.extend({
  observedValue: finiteMetricSchema.nullable(),
  passed: z.boolean(),
  failureCode: z
    .enum(['metric_missing', 'baseline_missing', 'non_finite_metric'])
    .nullable(),
});
export type ModelGateCriterionResult = z.infer<
  typeof modelGateCriterionResultSchema
>;

/** 완료된 offline 평가를 기록한다. gateResult는 받지 않고 서버가 계산한다. */
export const evaluationRunCreateRequestSchema = z
  .object({
    datasetSnapshotId: z.string().uuid(),
    baselineModelId: z.string().uuid().optional(),
    candidateModelId: z.string().uuid(),
    evaluatorVersion: z.string().trim().min(1).max(200),
    baselineMetrics: modelMetricSetSchema.optional(),
    candidateMetrics: modelMetricSetSchema,
    baselineSliceMetrics: modelSliceMetricSetSchema.optional(),
    candidateSliceMetrics: modelSliceMetricSetSchema.default({}),
    criteria: z.array(modelGateCriterionSchema).min(1).max(100),
  })
  .superRefine((value, context) => {
    const hasBaselineModel = value.baselineModelId !== undefined;
    const hasBaselineMetrics = value.baselineMetrics !== undefined;
    if (hasBaselineModel !== hasBaselineMetrics) {
      context.addIssue({
        code: 'custom',
        path: ['baselineMetrics'],
        message:
          'baselineModelId and baselineMetrics must be provided together',
      });
    }
    if (value.baselineSliceMetrics !== undefined && !hasBaselineModel) {
      context.addIssue({
        code: 'custom',
        path: ['baselineSliceMetrics'],
        message: 'baselineSliceMetrics require a baseline model and metrics',
      });
    }
    if (
      value.criteria.some((criterion) => criterion.comparison === 'delta') &&
      !hasBaselineModel
    ) {
      context.addIssue({
        code: 'custom',
        path: ['criteria'],
        message: 'delta criteria require a baseline model and metrics',
      });
    }
  });
export type EvaluationRunCreateRequest = z.infer<
  typeof evaluationRunCreateRequestSchema
>;

export const evaluationGateResultSchema = z.enum(['passed', 'failed']);
export type EvaluationGateResult = z.infer<typeof evaluationGateResultSchema>;

/** 재현·승격 근거로 사용하는 immutable 평가 결과. */
export const evaluationRunSummarySchema = z.object({
  id: z.string().uuid(),
  datasetSnapshotId: z.string().uuid(),
  baselineModelId: z.string().uuid().nullable(),
  candidateModelId: z.string().uuid(),
  evaluatorVersion: z.string(),
  baselineMetrics: modelMetricSetSchema.nullable(),
  candidateMetrics: modelMetricSetSchema,
  baselineSliceMetrics: modelSliceMetricSetSchema.nullable(),
  candidateSliceMetrics: modelSliceMetricSetSchema,
  criteria: z.array(modelGateCriterionSchema),
  gateDetails: z.array(modelGateCriterionResultSchema),
  gateResult: evaluationGateResultSchema,
  evaluationHash: sha256Schema,
  completedAt: z.string(),
});
export type EvaluationRunSummary = z.infer<typeof evaluationRunSummarySchema>;

/** 모델 승인에는 통과한 평가를 명시해야 한다. */
export const modelApprovalRequestSchema = z.object({
  evaluationRunId: z.string().uuid(),
});
export type ModelApprovalRequest = z.infer<typeof modelApprovalRequestSchema>;

/** production 등 named alias 승격 요청. */
export const modelCanaryPolicyRequestSchema = z.object({
  minimumInvocationCount: z.number().int().min(1).max(1_000_000),
  maximumErrorRateBasisPoints: z.number().int().min(0).max(10_000),
  maximumP95DurationMs: z.number().int().min(1).max(300_000),
  observationWindowSeconds: z.number().int().min(60).max(86_400),
});
export type ModelCanaryPolicyRequest = z.infer<
  typeof modelCanaryPolicyRequestSchema
>;

/** production 등 named alias 승격 요청. 기존 alias 위 승격은 canary를 자동 생성한다. */
export const modelPromotionRequestSchema = z.object({
  evaluationRunId: z.string().uuid(),
  alias: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
    .default('production'),
  /** 생략하면 서버의 fail-closed 기본 정책을 사용한다. */
  canary: modelCanaryPolicyRequestSchema.optional(),
});
export type ModelPromotionRequest = z.infer<typeof modelPromotionRequestSchema>;

/** alias rollback은 현재 revision이 기억하는 직전 모델로만 이동한다. */
export const modelAliasRollbackRequestSchema = learningScopeSchema.and(
  z.object({ task: learningModelTaskSchema }),
);
export type ModelAliasRollbackRequest = z.infer<
  typeof modelAliasRollbackRequestSchema
>;

/** 승인된 후보를 현재 alias revision에 shadow/live 정책으로 연결한다. */
export const modelTrafficPolicyCreateRequestSchema = learningScopeSchema.and(
  z.object({
    task: learningModelTaskSchema,
    alias: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
      .default('production'),
    candidateModelId: z.string().uuid(),
    evaluationRunId: z.string().uuid(),
    mode: z.enum(['shadow', 'live']),
    trafficBasisPoints: z.number().int().min(1).max(10_000),
  }),
);
export type ModelTrafficPolicyCreateRequest = z.infer<
  typeof modelTrafficPolicyCreateRequestSchema
>;

/** 정책 중지는 요청자가 소유한 scope/task를 명시해 교차 범위 변경을 막는다. */
export const modelTrafficPolicyPauseRequestSchema = learningScopeSchema.and(
  z.object({ task: learningModelTaskSchema }),
);
export type ModelTrafficPolicyPauseRequest = z.infer<
  typeof modelTrafficPolicyPauseRequestSchema
>;

/** credential과 routing salt를 제외한 traffic 정책 공개 정보. */
export const modelTrafficPolicySummarySchema = z.object({
  id: z.string().uuid(),
  modelAliasId: z.string().uuid(),
  aliasRevision: z.number().int().positive(),
  candidateModelId: z.string().uuid(),
  evaluationRunId: z.string().uuid(),
  mode: z.enum(['shadow', 'live']),
  trafficBasisPoints: z.number().int().min(1).max(10_000),
  status: z.enum(['active', 'paused', 'superseded']),
  activatedAt: z.string(),
  deactivatedAt: z.string().nullable(),
});
export type ModelTrafficPolicySummary = z.infer<
  typeof modelTrafficPolicySummarySchema
>;

/** 현재 alias revision에 귀속된 내부 trace만 집계하는 canary 판정 요청. */
export const modelCanaryEvaluateRequestSchema =
  modelAliasRollbackRequestSchema.and(
    z.object({ expectedRevision: z.number().int().positive() }),
  );
export type ModelCanaryEvaluateRequest = z.infer<
  typeof modelCanaryEvaluateRequestSchema
>;

export const modelCanaryDecisionReasonSchema = z.enum([
  'observation_window_open',
  'within_thresholds',
  'insufficient_invocations',
  'error_rate_exceeded',
  'p95_duration_exceeded',
  'error_rate_and_p95_duration_exceeded',
  'rollback_unavailable',
]);

/** canary 판정을 시작한 경로. */
export const modelCanaryEvaluationTriggerSchema = z.enum([
  'manual',
  'scheduled',
]);
export type ModelCanaryEvaluationTrigger = z.infer<
  typeof modelCanaryEvaluationTriggerSchema
>;

/** canary 최신 집계와 결정 결과. 원문·scope id·오류 메시지는 포함하지 않는다. */
export const modelCanaryEvaluationSummarySchema = z.object({
  aliasId: z.string().uuid(),
  evaluatedRevision: z.number().int().positive(),
  status: z.enum(['monitoring', 'passed', 'rolled_back', 'suspended']),
  reason: modelCanaryDecisionReasonSchema,
  trigger: modelCanaryEvaluationTriggerSchema,
  invocationCount: z.number().int().nonnegative(),
  failedInvocationCount: z.number().int().nonnegative(),
  errorRateBasisPoints: z.number().int().min(0).max(10_000),
  p95DurationMs: z.number().int().nonnegative(),
  minimumInvocationCount: z.number().int().positive(),
  maximumErrorRateBasisPoints: z.number().int().min(0).max(10_000),
  maximumP95DurationMs: z.number().int().positive(),
  windowStartedAt: z.string(),
  windowEndsAt: z.string(),
  rollbackRevision: z.number().int().positive().nullable(),
  evaluatedAt: z.string(),
});
export type ModelCanaryEvaluationSummary = z.infer<
  typeof modelCanaryEvaluationSummarySchema
>;

/** 현재 serving 제어 평면 alias와 변경 revision. */
export const modelAliasSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  householdId: z.string().uuid().nullable(),
  task: learningModelTaskSchema,
  alias: z.string(),
  model: modelRegistrySummarySchema,
  revision: z.number().int().positive(),
  evaluationRunId: z.string().uuid().nullable(),
  changeType: z.enum(['promotion', 'rollback']),
  status: z.enum(['active', 'suspended']),
  suspendedAt: z.string().nullable(),
  activatedAt: z.string(),
});
export type ModelAliasSummary = z.infer<typeof modelAliasSummarySchema>;

/** `DELETE /v1/learning/sources/:sourceItemId` 응답. */
export const sourceTombstoneResponseSchema = z.object({
  sourceItemId: z.string().uuid(),
  revisionId: z.string().uuid(),
  status: z.literal('tombstoned'),
  deletedAt: z.string(),
});
export type SourceTombstoneResponse = z.infer<
  typeof sourceTombstoneResponseSchema
>;

/** 격리 outbox 조회 범위. workspace 또는 household 중 하나만 허용한다. */
export const quarantinedOutboxListQuerySchema = z
  .object({
    workspaceId: z.string().uuid().optional(),
    householdId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(
    (value) =>
      Number(value.workspaceId !== undefined) +
        Number(value.householdId !== undefined) ===
      1,
    { message: 'exactly one outbox scope is required' },
  );
export type QuarantinedOutboxListQuery = z.infer<
  typeof quarantinedOutboxListQuerySchema
>;

/** payload와 원문을 제외한 격리 event 운영 메타데이터. */
export const quarantinedOutboxEventSummarySchema = z.object({
  id: z.string().uuid(),
  eventType: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  revisionId: z.string().uuid().nullable(),
  publishAttempts: z.number().int().nonnegative(),
  reprocessCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().nullable(),
  occurredAt: z.string(),
  quarantinedAt: z.string(),
});
export type QuarantinedOutboxEventSummary = z.infer<
  typeof quarantinedOutboxEventSummarySchema
>;

/** `GET /v1/learning/outbox/quarantined` 응답. */
export const quarantinedOutboxListResponseSchema = z.object({
  items: z.array(quarantinedOutboxEventSummarySchema),
});
export type QuarantinedOutboxListResponse = z.infer<
  typeof quarantinedOutboxListResponseSchema
>;

/** 격리 event 재처리 예약 결과. 실제 발행은 dispatcher가 수행한다. */
export const outboxReprocessResponseSchema = z.object({
  eventId: z.string().uuid(),
  status: z.literal('pending'),
  reprocessCount: z.number().int().positive(),
  availableAt: z.string(),
});
export type OutboxReprocessResponse = z.infer<
  typeof outboxReprocessResponseSchema
>;

/** household 운영 지표 조회 범위. 서버 전체 큐 수치는 응답에서 별도 표시한다. */
export const learningOperationsMetricsQuerySchema = z.object({
  householdId: z.string().uuid(),
  windowHours: z.coerce.number().int().min(1).max(168).default(24),
});
export type LearningOperationsMetricsQuery = z.infer<
  typeof learningOperationsMetricsQuerySchema
>;

/** BullMQ 큐별 현재 backlog. 잡 payload나 식별자는 노출하지 않는다. */
export const learningQueueMetricSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  waiting: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  delayed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
});
export type LearningQueueMetric = z.infer<typeof learningQueueMetricSchema>;

/** owner/admin 전용 AI 파이프라인 운영 대시보드 응답. */
export const learningOperationsMetricsResponseSchema = z.object({
  generatedAt: z.string(),
  window: z.object({
    hours: z.number().int().min(1).max(168),
    startedAt: z.string(),
  }),
  queues: z.object({
    scope: z.literal('server'),
    items: z.array(learningQueueMetricSchema),
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    unavailableQueues: z.number().int().nonnegative(),
    oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
  }),
  outbox: z.object({
    pending: z.number().int().nonnegative(),
    quarantinedInWindow: z.number().int().nonnegative(),
    publishedInWindow: z.number().int().nonnegative(),
    oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
  }),
  pipelines: z.object({
    total: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    failureRateBasisPoints: z.number().int().min(0).max(10_000),
    p95DurationMs: z.number().int().nonnegative(),
  }),
  ai: z.object({
    invocations: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errorRateBasisPoints: z.number().int().min(0).max(10_000),
    p95DurationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    meteredInvocations: z.number().int().nonnegative(),
  }),
  quality: z.object({
    humanConfirmedLabels: z.number().int().nonnegative(),
    distinctLabelClasses: z.number().int().nonnegative(),
    approvedDatasets: z.number().int().nonnegative(),
    revokedDatasets: z.number().int().nonnegative(),
    evaluationsPassed: z.number().int().nonnegative(),
    evaluationsFailed: z.number().int().nonnegative(),
    trainingQueued: z.number().int().nonnegative(),
    trainingRunning: z.number().int().nonnegative(),
    trainingSucceeded: z.number().int().nonnegative(),
    trainingFailedOrBlocked: z.number().int().nonnegative(),
    trainingRevoked: z.number().int().nonnegative(),
  }),
  alerts: z.object({
    scope: z.literal('server'),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    deliveredInWindow: z.number().int().nonnegative(),
    oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
  }),
});
export type LearningOperationsMetricsResponse = z.infer<
  typeof learningOperationsMetricsResponseSchema
>;
