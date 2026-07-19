/**
 * 검증 DB에서 dataset 승인→평가→모델 승인→승격→rollback, RAG embedding
 * coverage와 source 삭제 전파를 확인한다.
 * 운영 DB 오실행을 막기 위해 명시적인 쓰기 허용 환경변수와 독립 검증 DB가
 * 필요하다.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

import { assertVerificationDatabaseSafety } from './lib/verification-database-guard.mjs';

import {
  createDbClient,
  resolveModelAlias,
  resolveModelTrafficPolicy,
  schema,
} from '../packages/database/dist/index.mjs';
import { learningOperationsMetricsResponseSchema } from '../packages/contracts/dist/index.mjs';

const databaseUrl = process.env.DATABASE_URL;
const { databaseName } = assertVerificationDatabaseSafety({
  databaseUrl,
  allowWrite: process.env.MODEL_GATE_VERIFY_ALLOW_WRITE,
  nodeEnv: process.env.NODE_ENV,
});
console.log(`[model-gate] 검증 DB 안전 가드 통과: ${databaseName}`);

const require = createRequire(import.meta.url);
const { and, eq } = require('../packages/database/node_modules/drizzle-orm');
const {
  LearningModelService,
} = require('../apps/api/dist/learning/learning-model.service.js');
const {
  LearningCanaryMonitorService,
} = require('../apps/api/dist/learning/learning-canary-monitor.service.js');
const {
  LearningDatasetService,
} = require('../apps/api/dist/learning/learning-dataset.service.js');
const {
  LearningMerchantDatasetService,
} = require('../apps/api/dist/learning/learning-merchant-dataset.service.js');
const {
  LearningRagDatasetService,
} = require('../apps/api/dist/learning/learning-rag-dataset.service.js');
const {
  LearningDataControlService,
} = require('../apps/api/dist/learning/learning-data-control.service.js');
const {
  LearningOperationsService,
} = require('../apps/api/dist/learning/learning-operations.service.js');
const {
  SourceTombstoneProcessor,
} = require('../apps/worker/dist/processors/source-tombstone.processor.js');
const { db, client } = createDbClient(databaseUrl, { max: 1 });
const service = new LearningModelService(db);
const canaryMonitor = new LearningCanaryMonitorService(db, service, {
  get(key) {
    return key === 'ai'
      ? {
          modelCanaryMonitorEnabled: false,
          modelCanaryMonitorIntervalMs: 30_000,
          modelCanaryMonitorBatchSize: 50,
        }
      : undefined;
  },
});
const storedArtifacts = new Map();
const deletedArtifactKeys = new Set();
const storage = {
  async putObject(key, value) {
    storedArtifacts.set(key, value);
  },
  async getObject(key) {
    const value = storedArtifacts.get(key);
    if (value === undefined) {
      throw new Error('verification object not found');
    }
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  },
  async deleteObject(key) {
    storedArtifacts.delete(key);
    deletedArtifactKeys.add(key);
  },
};
const datasetService = new LearningDatasetService(db, storage);
const merchantDatasetService = new LearningMerchantDatasetService(db, storage);
const ragDatasetService = new LearningRagDatasetService(db, storage);
const dataControlService = new LearningDataControlService(db);
const operationsService = new LearningOperationsService(db, {
  get(key) {
    if (key === 'redis') {
      return {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      };
    }
    if (key === 'queue') {
      return { prefix: process.env.BULLMQ_PREFIX ?? 'fma' };
    }
    return undefined;
  },
});

const userId = randomUUID();
const workspaceId = randomUUID();
const datasetSnapshotId = randomUUID();
const householdId = randomUUID();
const memberId = randomUUID();
const categoryId = randomUUID();
const merchantRuleId = randomUUID();
const chunkId = randomUUID();
const chunkRevisionId = randomUUID();
const successorChunkRevisionId = randomUUID();
const sourceItemId = randomUUID();
const sourceRevisionId = randomUUID();
const suffix = randomUUID();
const hash = 'a'.repeat(64);

try {
  await db.insert(schema.users).values({
    id: userId,
    email: `model-gate-${suffix}@example.com`,
    passwordHash: 'verification-only',
    name: 'model gate verifier',
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    ownerUserId: userId,
    name: 'model gate verification',
    kind: 'personal',
  });
  await db.insert(schema.households).values({
    id: householdId,
    name: 'model gate household',
    createdBy: userId,
  });
  await db.insert(schema.householdMembers).values({
    id: memberId,
    householdId,
    userId,
    role: 'owner',
  });
  await db.insert(schema.expenseCategories).values({
    id: categoryId,
    householdId,
    slug: 'cafe',
    name: '카페',
  });
  const merchantPattern = `검증가맹점-${suffix}`;
  const merchantTargetId = createHash('sha256')
    .update(JSON.stringify([householdId, merchantPattern]), 'utf8')
    .digest('hex');
  await db.insert(schema.merchantCategoryRules).values({
    id: merchantRuleId,
    householdId,
    merchantPattern,
    categoryId,
    source: 'human_confirmed',
    confirmedAt: new Date(),
    createdBy: userId,
  });
  await db.insert(schema.feedbackEvents).values({
    householdId,
    targetType: 'merchant-category',
    targetId: merchantTargetId,
    labelSchemaVersion: 'merchant-category-v1',
    label: { categoryId },
    source: 'human_confirmed',
    actorUserId: userId,
    occurredAt: new Date(),
  });
  await db.insert(schema.datasetSnapshots).values({
    id: datasetSnapshotId,
    workspaceId,
    task: 'memory-candidate',
    version: `verify-${suffix}`,
    schemaVersion: 'memory-candidate-dataset-v1',
    artifactKey: `verify/${suffix}/examples.jsonl`,
    artifactHash: hash,
    manifestKey: `verify/${suffix}/manifest.json`,
    manifestHash: 'b'.repeat(64),
    splitPolicy: { seed: 'verify' },
    consentScope: { mode: 'workspace-only' },
    rowCount: 1,
    status: 'approved',
    createdBy: userId,
    approvedAt: new Date(),
  });
  const chunkCreatedAt = new Date();
  await db.insert(schema.chunks).values({
    id: chunkId,
    workspaceId,
    sourceType: 'slack_message',
    sourceRefId: `verify-${suffix}`,
    text: '검증용 장애 대응 런북',
    occurredAt: chunkCreatedAt,
  });
  await db.insert(schema.chunkRevisions).values({
    id: chunkRevisionId,
    chunkId,
    revision: 1,
    contentHash: 'e'.repeat(64),
    sourceFingerprint: 'f'.repeat(64),
    text: '검증용 장애 대응 런북',
    chunkerVersion: 'slack-chunk-v1',
    redactionVersion: 'none-v1',
    validFrom: chunkCreatedAt,
  });
  await db
    .update(schema.chunks)
    .set({ currentRevisionId: chunkRevisionId })
    .where(eq(schema.chunks.id, chunkId));
  const sourceObjectKey = `verify/${suffix}/source.json`;
  storedArtifacts.set(sourceObjectKey, 'verification source');
  await db.insert(schema.sourceItems).values({
    id: sourceItemId,
    workspaceId,
    kind: 'slack',
    objectKey: sourceObjectKey,
    contentHash: '1'.repeat(64),
    sizeBytes: 19,
    receivedAt: chunkCreatedAt,
  });
  await db.insert(schema.sourceRevisions).values({
    id: sourceRevisionId,
    sourceItemId,
    revision: 1,
    objectKey: sourceObjectKey,
    contentHash: '1'.repeat(64),
    sizeBytes: 19,
    parserSchemaVersion: 'verify-v1',
    consentScope: { mode: 'workspace-only' },
    validFrom: chunkCreatedAt,
  });
  await db
    .update(schema.sourceItems)
    .set({ currentRevisionId: sourceRevisionId })
    .where(eq(schema.sourceItems.id, sourceItemId));
  await db.insert(schema.lineageEdges).values({
    fromNodeType: 'source_revision',
    fromNodeId: sourceRevisionId,
    toNodeType: 'chunk_revision',
    toNodeId: chunkRevisionId,
    transformVersion: 'verify-v1',
  });

  const baseline = await service.registerModel(userId, {
    workspaceId,
    task: 'memory-candidate',
    provider: 'mock',
    model: 'memory-extractor',
    version: `baseline-${suffix}`,
    artifactHash: 'c'.repeat(64),
  });
  const baselineEvaluation = await service.recordEvaluation(userId, {
    datasetSnapshotId,
    candidateModelId: baseline.id,
    evaluatorVersion: 'verify-v1',
    candidateMetrics: { accuracy: 0.85, p95LatencyMs: 100 },
    candidateSliceMetrics: {},
    criteria: [
      {
        metric: 'accuracy',
        comparison: 'candidate',
        operator: 'gte',
        threshold: 0.8,
      },
    ],
  });
  assert.equal(baselineEvaluation.gateResult, 'passed');
  await service.approveModel(userId, baseline.id, {
    evaluationRunId: baselineEvaluation.id,
  });
  const firstAlias = await service.promoteModel(userId, baseline.id, {
    evaluationRunId: baselineEvaluation.id,
    alias: 'production',
  });
  assert.equal(firstAlias.revision, 1);
  assert.equal(firstAlias.model.id, baseline.id);

  const candidate = await service.registerModel(userId, {
    workspaceId,
    task: 'memory-candidate',
    provider: 'mock',
    model: 'memory-extractor',
    version: `candidate-${suffix}`,
    artifactHash: 'd'.repeat(64),
  });
  const candidateEvaluation = await service.recordEvaluation(userId, {
    datasetSnapshotId,
    baselineModelId: baseline.id,
    candidateModelId: candidate.id,
    evaluatorVersion: 'verify-v1',
    baselineMetrics: { accuracy: 0.85, p95LatencyMs: 100 },
    candidateMetrics: { accuracy: 0.9, p95LatencyMs: 90 },
    candidateSliceMetrics: {},
    criteria: [
      {
        metric: 'accuracy',
        comparison: 'delta',
        operator: 'gte',
        threshold: 0,
      },
      {
        metric: 'p95LatencyMs',
        comparison: 'candidate',
        operator: 'lte',
        threshold: 100,
      },
    ],
  });
  assert.equal(candidateEvaluation.gateResult, 'passed');
  await service.approveModel(userId, candidate.id, {
    evaluationRunId: candidateEvaluation.id,
  });
  const promoted = await service.promoteModel(userId, candidate.id, {
    evaluationRunId: candidateEvaluation.id,
    alias: 'production',
    canary: {
      minimumInvocationCount: 1,
      maximumErrorRateBasisPoints: 0,
      maximumP95DurationMs: 1_000,
      observationWindowSeconds: 60,
    },
  });
  assert.equal(promoted.revision, 2);
  assert.equal(promoted.model.id, candidate.id);

  const invocationStartedAt = new Date();
  await db.insert(schema.aiInvocations).values({
    id: randomUUID(),
    modelAliasId: promoted.id,
    modelAliasRevision: promoted.revision,
    modelRegistryId: candidate.id,
    task: 'memory-candidate-verify',
    operation: 'llm_generate',
    provider: 'mock',
    model: 'memory-extractor',
    promptVersion: 'verify-v1',
    inputFingerprint: '9'.repeat(64),
    inputCount: 1,
    durationMs: 1_500,
    outcome: 'failed',
    errorCode: 'VerificationError',
    startedAt: invocationStartedAt,
    finishedAt: invocationStartedAt,
  });
  const monitorSummary = await canaryMonitor.evaluatePending();
  assert.equal(monitorSummary.scanned, 1);
  assert.equal(monitorSummary.rolledBack, 1);
  assert.equal(monitorSummary.failed, 0);
  const canaryEvaluation = await service.evaluateCanary(userId, 'production', {
    workspaceId,
    task: 'memory-candidate',
    expectedRevision: promoted.revision,
  });
  assert.equal(canaryEvaluation.status, 'rolled_back');
  assert.equal(canaryEvaluation.trigger, 'scheduled');
  assert.equal(canaryEvaluation.reason, 'error_rate_and_p95_duration_exceeded');
  assert.equal(canaryEvaluation.rollbackRevision, 3);
  const retriedCanaryEvaluation = await service.evaluateCanary(
    userId,
    'production',
    {
      workspaceId,
      task: 'memory-candidate',
      expectedRevision: promoted.revision,
    },
  );
  assert.equal(retriedCanaryEvaluation.status, 'rolled_back');
  assert.equal(retriedCanaryEvaluation.rollbackRevision, 3);
  const rolledBack = await service.getAlias(userId, 'production', {
    workspaceId,
    task: 'memory-candidate',
  });
  assert.equal(rolledBack.revision, 3);
  assert.equal(rolledBack.changeType, 'rollback');
  assert.equal(rolledBack.model.id, baseline.id);
  const [canaryRollbackAudit] = await db
    .select({ gateDetails: schema.modelAliasRevisions.gateDetails })
    .from(schema.modelAliasRevisions)
    .where(
      and(
        eq(schema.modelAliasRevisions.modelAliasId, rolledBack.id),
        eq(schema.modelAliasRevisions.revision, rolledBack.revision),
      ),
    );
  assert.equal(
    canaryRollbackAudit?.gateDetails.canaryEvaluation.reason,
    'error_rate_and_p95_duration_exceeded',
  );

  const promotedWithoutRollbackTarget = await service.promoteModel(
    userId,
    candidate.id,
    {
      evaluationRunId: candidateEvaluation.id,
      alias: 'production',
      canary: {
        minimumInvocationCount: 1,
        maximumErrorRateBasisPoints: 0,
        maximumP95DurationMs: 1_000,
        observationWindowSeconds: 60,
      },
    },
  );
  const baselineRevokedAt = new Date();
  await db
    .update(schema.evaluationRuns)
    .set({
      status: 'revoked',
      revokedAt: baselineRevokedAt,
      revocationReason: 'rollback-unavailable-verification',
    })
    .where(eq(schema.evaluationRuns.id, baselineEvaluation.id));
  const unavailableInvocationStartedAt = new Date();
  await db.insert(schema.aiInvocations).values({
    id: randomUUID(),
    modelAliasId: promotedWithoutRollbackTarget.id,
    modelAliasRevision: promotedWithoutRollbackTarget.revision,
    modelRegistryId: candidate.id,
    task: 'memory-candidate-verify',
    operation: 'llm_generate',
    provider: 'mock',
    model: 'memory-extractor',
    promptVersion: 'verify-v1',
    inputFingerprint: '8'.repeat(64),
    inputCount: 1,
    durationMs: 1_500,
    outcome: 'failed',
    errorCode: 'VerificationError',
    startedAt: unavailableInvocationStartedAt,
    finishedAt: unavailableInvocationStartedAt,
  });
  const unavailableMonitorSummary = await canaryMonitor.evaluatePending();
  assert.equal(unavailableMonitorSummary.scanned, 1);
  assert.equal(unavailableMonitorSummary.suspended, 1);
  assert.equal(unavailableMonitorSummary.failed, 0);
  const unavailableRollback = await service.evaluateCanary(
    userId,
    'production',
    {
      workspaceId,
      task: 'memory-candidate',
      expectedRevision: promotedWithoutRollbackTarget.revision,
    },
  );
  assert.equal(unavailableRollback.status, 'suspended');
  assert.equal(unavailableRollback.reason, 'rollback_unavailable');
  assert.equal(unavailableRollback.trigger, 'scheduled');
  const canaryAlerts = await db
    .select({ kind: schema.operationalAlerts.kind })
    .from(schema.operationalAlerts);
  assert.equal(
    canaryAlerts.filter((alert) => alert.kind === 'canary_rolled_back').length,
    1,
  );
  assert.equal(
    canaryAlerts.filter((alert) => alert.kind === 'canary_suspended').length,
    1,
  );
  const idleMonitorSummary = await canaryMonitor.evaluatePending();
  assert.equal(idleMonitorSummary.scanned, 0);
  assert.deepEqual(idleMonitorSummary, {
    scanned: 0,
    monitoring: 0,
    passed: 0,
    rolledBack: 0,
    suspended: 0,
    failed: 0,
  });
  const suspendedAlias = await service.getAlias(userId, 'production', {
    workspaceId,
    task: 'memory-candidate',
  });
  assert.equal(suspendedAlias.status, 'suspended');
  await db
    .update(schema.evaluationRuns)
    .set({
      status: 'succeeded',
      revokedAt: null,
      revocationReason: null,
    })
    .where(eq(schema.evaluationRuns.id, baselineEvaluation.id));
  const recoveredAlias = await service.rollbackAlias(userId, 'production', {
    workspaceId,
    task: 'memory-candidate',
  });
  assert.equal(recoveredAlias.status, 'active');
  assert.equal(recoveredAlias.model.id, baseline.id);

  const rejectedCandidate = await service.registerModel(userId, {
    workspaceId,
    task: 'memory-candidate',
    provider: 'mock',
    model: 'memory-extractor',
    version: `failed-${suffix}`,
  });
  const failedEvaluation = await service.recordEvaluation(userId, {
    datasetSnapshotId,
    candidateModelId: rejectedCandidate.id,
    evaluatorVersion: 'verify-v1',
    candidateMetrics: { accuracy: 0.2 },
    candidateSliceMetrics: {},
    criteria: [
      {
        metric: 'accuracy',
        comparison: 'candidate',
        operator: 'gte',
        threshold: 0.8,
      },
    ],
  });
  assert.equal(failedEvaluation.gateResult, 'failed');
  await assert.rejects(
    service.approveModel(userId, rejectedCandidate.id, {
      evaluationRunId: failedEvaluation.id,
    }),
    (error) => error?.getStatus?.() === 409,
  );

  const merchantDataset = await merchantDatasetService.createSnapshot(userId, {
    householdId,
    splitSeed: 'merchant-verification-v1',
  });
  assert.equal(merchantDataset.task, 'merchant-category');
  assert.equal(merchantDataset.status, 'validated');
  assert.equal(merchantDataset.rowCount, 1);
  assert.equal(
    [...storedArtifacts.keys()].filter((key) =>
      key.startsWith(`gold/merchant-category/${householdId}/`),
    ).length,
    2,
  );
  const [merchantDatasetItem] = await db
    .select()
    .from(schema.datasetSnapshotItems)
    .where(
      eq(schema.datasetSnapshotItems.datasetSnapshotId, merchantDataset.id),
    );
  assert.equal(merchantDatasetItem?.merchantCategoryRuleId, merchantRuleId);
  assert.equal(merchantDatasetItem?.chunkRevisionId, null);
  assert.match(merchantDatasetItem?.splitGroupHash ?? '', /^[a-f0-9]{64}$/);
  assert.ok(merchantDatasetItem?.occurredAt);
  assert.equal(merchantDatasetItem?.split, 'test');
  const [merchantSplitPolicy] = await db
    .select({ splitPolicy: schema.datasetSnapshots.splitPolicy })
    .from(schema.datasetSnapshots)
    .where(eq(schema.datasetSnapshots.id, merchantDataset.id));
  assert.equal(merchantSplitPolicy?.splitPolicy.strategy, 'group_time');
  assert.equal(merchantSplitPolicy?.splitPolicy.leakageAudit?.status, 'passed');
  await datasetService.approveSnapshot(userId, merchantDataset.id);

  const incompleteAuditDataset = await merchantDatasetService.createSnapshot(
    userId,
    {
      householdId,
      splitSeed: 'merchant-verification-v1',
      validationWindowDays: 29,
    },
  );
  await db
    .update(schema.datasetSnapshotItems)
    .set({ splitGroupHash: null, occurredAt: null })
    .where(
      eq(
        schema.datasetSnapshotItems.datasetSnapshotId,
        incompleteAuditDataset.id,
      ),
    );
  await assert.rejects(
    datasetService.approveSnapshot(userId, incompleteAuditDataset.id),
    (error) =>
      error?.getStatus?.() === 400 &&
      error?.message === 'dataset leakage audit metadata is incomplete',
  );

  const merchantModel = await service.registerModel(userId, {
    householdId,
    task: 'merchant-category',
    provider: 'mock',
    model: 'mock-llm-v0',
    version: 'merchant-category-v1',
  });
  const merchantEvaluation = await service.recordEvaluation(userId, {
    datasetSnapshotId: merchantDataset.id,
    candidateModelId: merchantModel.id,
    evaluatorVersion: 'merchant-eval-v1',
    candidateMetrics: { macroF1: 0.91 },
    candidateSliceMetrics: {},
    criteria: [
      {
        metric: 'macroF1',
        comparison: 'candidate',
        operator: 'gte',
        threshold: 0.85,
      },
    ],
  });
  await service.approveModel(userId, merchantModel.id, {
    evaluationRunId: merchantEvaluation.id,
  });
  await service.promoteModel(userId, merchantModel.id, {
    evaluationRunId: merchantEvaluation.id,
    alias: 'production',
  });
  const resolvedMerchant = await resolveModelAlias(db, {
    householdId,
    task: 'merchant-category',
    provider: 'mock',
    model: 'mock-llm-v0',
    required: true,
  });
  assert.equal(resolvedMerchant.source, 'alias');
  assert.equal(resolvedMerchant.modelRegistryId, merchantModel.id);

  const merchantTrafficCandidate = await service.registerModel(userId, {
    householdId,
    task: 'merchant-category',
    provider: 'mock',
    model: 'mock-llm-v0',
    version: `merchant-category-candidate-${suffix}`,
  });
  const merchantTrafficEvaluation = await service.recordEvaluation(userId, {
    datasetSnapshotId: merchantDataset.id,
    baselineModelId: merchantModel.id,
    candidateModelId: merchantTrafficCandidate.id,
    evaluatorVersion: 'merchant-traffic-eval-v1',
    baselineMetrics: { macroF1: 0.91 },
    candidateMetrics: { macroF1: 0.92 },
    candidateSliceMetrics: {},
    criteria: [
      {
        metric: 'macroF1',
        comparison: 'delta',
        operator: 'gte',
        threshold: 0,
      },
    ],
  });
  await service.approveModel(userId, merchantTrafficCandidate.id, {
    evaluationRunId: merchantTrafficEvaluation.id,
  });
  const shadowPolicy = await service.createTrafficPolicy(userId, {
    householdId,
    task: 'merchant-category',
    alias: 'production',
    candidateModelId: merchantTrafficCandidate.id,
    evaluationRunId: merchantTrafficEvaluation.id,
    mode: 'shadow',
    trafficBasisPoints: 2_500,
  });
  assert.equal(shadowPolicy.status, 'active');
  const resolvedShadowPolicy = await resolveModelTrafficPolicy(db, {
    primary: resolvedMerchant,
    candidateRuntime: {
      provider: 'mock',
      model: 'mock-llm-v0',
      version: merchantTrafficCandidate.version,
    },
  });
  assert.equal(resolvedShadowPolicy?.id, shadowPolicy.id);
  assert.equal(resolvedShadowPolicy?.mode, 'shadow');
  await assert.rejects(
    resolveModelTrafficPolicy(db, {
      primary: resolvedMerchant,
      candidateRuntime: {
        provider: 'mock',
        model: 'mock-llm-v0',
        version: 'wrong-version',
      },
    }),
    (error) => error?.code === 'candidate_version_mismatch',
  );
  const livePolicy = await service.createTrafficPolicy(userId, {
    householdId,
    task: 'merchant-category',
    alias: 'production',
    candidateModelId: merchantTrafficCandidate.id,
    evaluationRunId: merchantTrafficEvaluation.id,
    mode: 'live',
    trafficBasisPoints: 1_000,
  });
  const [supersededShadow] = await db
    .select({ status: schema.modelTrafficPolicies.status })
    .from(schema.modelTrafficPolicies)
    .where(eq(schema.modelTrafficPolicies.id, shadowPolicy.id));
  assert.equal(supersededShadow?.status, 'superseded');
  const pausedPolicy = await service.pauseTrafficPolicy(userId, livePolicy.id, {
    householdId,
    task: 'merchant-category',
  });
  assert.equal(pausedPolicy.status, 'paused');
  assert.equal(
    await resolveModelTrafficPolicy(db, {
      primary: resolvedMerchant,
      candidateRuntime: {
        provider: 'mock',
        model: 'mock-llm-v0',
        version: merchantTrafficCandidate.version,
      },
    }),
    null,
  );
  await assert.rejects(
    resolveModelAlias(db, {
      householdId,
      task: 'merchant-category',
      provider: 'mock',
      model: 'wrong-model',
      required: true,
    }),
    (error) => error?.code === 'model_mismatch',
  );
  const optionalFallback = await resolveModelAlias(db, {
    workspaceId,
    task: 'rag-answer',
    provider: 'mock',
    model: 'mock-llm-v0',
    required: false,
  });
  assert.equal(optionalFallback.source, 'configuration');
  await assert.rejects(
    resolveModelAlias(db, {
      workspaceId,
      task: 'rag-answer',
      provider: 'mock',
      model: 'mock-llm-v0',
      required: true,
    }),
    (error) => error?.code === 'alias_missing',
  );

  const retrievalFeedback = await ragDatasetService.recordFeedback(userId, {
    workspaceId,
    query: '장애 대응 런북은 어디에 있나요?',
    relevantChunkId: chunkId,
    consent: true,
  });
  assert.equal(retrievalFeedback.chunkRevisionId, chunkRevisionId);
  const ragDataset = await ragDatasetService.createSnapshot(userId, {
    workspaceId,
    splitSeed: 'rag-embedding-verification-v1',
  });
  assert.equal(ragDataset.task, 'rag-embedding');
  assert.equal(ragDataset.rowCount, 1);
  await datasetService.approveSnapshot(userId, ragDataset.id);

  const embeddingVector = Array.from({ length: 256 }, (_, index) =>
    index === 0 ? 1 : 0,
  );
  const registerEmbeddingModel = async (version) => {
    const model = await service.registerModel(userId, {
      workspaceId,
      task: 'rag-embedding',
      provider: 'mock',
      model: 'mock',
      version,
      dimensions: 256,
    });
    const evaluation = await service.recordEvaluation(userId, {
      datasetSnapshotId: ragDataset.id,
      candidateModelId: model.id,
      evaluatorVersion: 'rag-eval-v1',
      candidateMetrics: { recallAt5: 1 },
      candidateSliceMetrics: {},
      criteria: [
        {
          metric: 'recallAt5',
          comparison: 'candidate',
          operator: 'gte',
          threshold: 0.9,
        },
      ],
    });
    await service.approveModel(userId, model.id, {
      evaluationRunId: evaluation.id,
    });
    return { model, evaluation };
  };
  const insertEmbeddingVersion = async (version) => {
    const [created] = await db
      .insert(schema.embeddingVersions)
      .values({
        chunkRevisionId,
        provider: 'mock',
        model: 'mock',
        modelRevision: version,
        preprocessingVersion: 'raw-chunk-v1',
        dim: 256,
        embedding: embeddingVector,
        embeddingHash: createHash('sha256')
          .update(JSON.stringify(embeddingVector))
          .digest('hex'),
      })
      .returning({ id: schema.embeddingVersions.id });
    assert.ok(created);
    return created.id;
  };

  const ragBaselineVersion = `rag-baseline-${suffix}`;
  const ragBaseline = await registerEmbeddingModel(ragBaselineVersion);
  const baselineEmbeddingVersionId = await insertEmbeddingVersion(
    ragBaselineVersion,
  );
  const ragFirstAlias = await service.promoteModel(
    userId,
    ragBaseline.model.id,
    {
      evaluationRunId: ragBaseline.evaluation.id,
      alias: 'production',
    },
  );
  assert.equal(ragFirstAlias.revision, 1);

  const ragCandidateVersion = `rag-candidate-${suffix}`;
  const ragCandidate = await registerEmbeddingModel(ragCandidateVersion);
  await assert.rejects(
    service.promoteModel(userId, ragCandidate.model.id, {
      evaluationRunId: ragCandidate.evaluation.id,
      alias: 'production',
    }),
    (error) =>
      error?.getStatus?.() === 409 &&
      error?.message === 'embedding coverage gate failed: 0/1',
  );
  const candidateEmbeddingVersionId = await insertEmbeddingVersion(
    ragCandidateVersion,
  );
  const ragPromoted = await service.promoteModel(
    userId,
    ragCandidate.model.id,
    {
      evaluationRunId: ragCandidate.evaluation.id,
      alias: 'production',
    },
  );
  assert.equal(ragPromoted.revision, 2);
  const [candidateProjection] = await db
    .select({ currentVersionId: schema.embeddings.currentVersionId })
    .from(schema.embeddings)
    .where(eq(schema.embeddings.chunkId, chunkId));
  assert.equal(
    candidateProjection?.currentVersionId,
    candidateEmbeddingVersionId,
  );
  const ragRolledBack = await service.rollbackAlias(userId, 'production', {
    workspaceId,
    task: 'rag-embedding',
  });
  assert.equal(ragRolledBack.revision, 3);
  const [baselineProjection] = await db
    .select({ currentVersionId: schema.embeddings.currentVersionId })
    .from(schema.embeddings)
    .where(eq(schema.embeddings.chunkId, chunkId));
  assert.equal(
    baselineProjection?.currentVersionId,
    baselineEmbeddingVersionId,
  );
  const resolvedRagEmbedding = await resolveModelAlias(db, {
    workspaceId,
    task: 'rag-embedding',
    provider: 'mock',
    model: 'mock',
    version: ragBaselineVersion,
    dimensions: 256,
    required: true,
  });
  assert.equal(resolvedRagEmbedding.version, ragBaselineVersion);
  await assert.rejects(
    resolveModelAlias(db, {
      workspaceId,
      task: 'rag-embedding',
      provider: 'mock',
      model: 'mock',
      version: ragCandidateVersion,
      dimensions: 256,
      required: true,
    }),
    (error) => error?.code === 'version_mismatch',
  );
  const [ragAliasRevision] = await db
    .select({ gateDetails: schema.modelAliasRevisions.gateDetails })
    .from(schema.modelAliasRevisions)
    .where(eq(schema.modelAliasRevisions.modelAliasId, ragRolledBack.id));
  assert.equal(ragAliasRevision?.gateDetails.coverageBasisPoints, 10_000);

  // source 계보는 초기 revision만 가리키지만, 같은 chunk의 후속 revision을 사용한
  // 학습 예제와 snapshot도 source 삭제 시 함께 폐기돼야 한다.
  const successorValidFrom = new Date();
  await db
    .update(schema.chunkRevisions)
    .set({ validUntil: successorValidFrom })
    .where(eq(schema.chunkRevisions.id, chunkRevisionId));
  await db.insert(schema.chunkRevisions).values({
    id: successorChunkRevisionId,
    chunkId,
    revision: 2,
    contentHash: '2'.repeat(64),
    sourceFingerprint: '3'.repeat(64),
    text: '검증용 장애 대응 런북 개정본',
    chunkerVersion: 'slack-chunk-v2',
    redactionVersion: 'none-v1',
    validFrom: successorValidFrom,
  });
  await db
    .update(schema.chunks)
    .set({
      text: '검증용 장애 대응 런북 개정본',
      currentRevisionId: successorChunkRevisionId,
      updatedAt: successorValidFrom,
    })
    .where(eq(schema.chunks.id, chunkId));
  const successorRetrievalFeedback = await ragDatasetService.recordFeedback(
    userId,
    {
      workspaceId,
      query: '개정된 장애 대응 런북은 어디에 있나요?',
      relevantChunkId: chunkId,
      consent: true,
    },
  );
  assert.equal(
    successorRetrievalFeedback.chunkRevisionId,
    successorChunkRevisionId,
  );
  const successorRagDataset = await ragDatasetService.createSnapshot(userId, {
    workspaceId,
    splitSeed: 'rag-embedding-successor-verification-v1',
  });
  await datasetService.approveSnapshot(userId, successorRagDataset.id);

  const [ragExampleBeforeDelete] = await db
    .select({ queryObjectKey: schema.ragRetrievalExamples.queryObjectKey })
    .from(schema.ragRetrievalExamples)
    .where(eq(schema.ragRetrievalExamples.id, retrievalFeedback.id));
  assert.ok(ragExampleBeforeDelete);
  const [ragSnapshotBeforeDelete] = await db
    .select({
      artifactKey: schema.datasetSnapshots.artifactKey,
      manifestKey: schema.datasetSnapshots.manifestKey,
    })
    .from(schema.datasetSnapshots)
    .where(eq(schema.datasetSnapshots.id, ragDataset.id));
  assert.ok(ragSnapshotBeforeDelete);
  const [successorExampleBeforeDelete] = await db
    .select({ queryObjectKey: schema.ragRetrievalExamples.queryObjectKey })
    .from(schema.ragRetrievalExamples)
    .where(
      eq(
        schema.ragRetrievalExamples.id,
        successorRetrievalFeedback.id,
      ),
    );
  assert.ok(successorExampleBeforeDelete);
  const [successorSnapshotBeforeDelete] = await db
    .select({
      artifactKey: schema.datasetSnapshots.artifactKey,
      manifestKey: schema.datasetSnapshots.manifestKey,
    })
    .from(schema.datasetSnapshots)
    .where(eq(schema.datasetSnapshots.id, successorRagDataset.id));
  assert.ok(successorSnapshotBeforeDelete);
  await dataControlService.tombstoneSource(userId, sourceItemId);
  const tombstoneProcessor = new SourceTombstoneProcessor(db, storage);
  const tombstoneResult = await tombstoneProcessor.process({
    data: { sourceItemId },
    id: `verify-tombstone-${suffix}`,
    attemptsMade: 0,
    queueName: 'source-tombstone',
  });
  assert.equal(tombstoneResult.revokedRetrievalExampleCount, 2);
  const [ragExampleAfterDelete] = await db
    .select({ revokedAt: schema.ragRetrievalExamples.revokedAt })
    .from(schema.ragRetrievalExamples)
    .where(eq(schema.ragRetrievalExamples.id, retrievalFeedback.id));
  assert.ok(ragExampleAfterDelete?.revokedAt);
  const [successorExampleAfterDelete] = await db
    .select({ revokedAt: schema.ragRetrievalExamples.revokedAt })
    .from(schema.ragRetrievalExamples)
    .where(
      eq(
        schema.ragRetrievalExamples.id,
        successorRetrievalFeedback.id,
      ),
    );
  assert.ok(successorExampleAfterDelete?.revokedAt);
  const [ragSnapshotAfterDelete] = await db
    .select({ status: schema.datasetSnapshots.status })
    .from(schema.datasetSnapshots)
    .where(eq(schema.datasetSnapshots.id, ragDataset.id));
  assert.equal(ragSnapshotAfterDelete?.status, 'revoked');
  const [successorSnapshotAfterDelete] = await db
    .select({ status: schema.datasetSnapshots.status })
    .from(schema.datasetSnapshots)
    .where(eq(schema.datasetSnapshots.id, successorRagDataset.id));
  assert.equal(successorSnapshotAfterDelete?.status, 'revoked');
  const chunkRevisionTextsAfterDelete = await db
    .select({ text: schema.chunkRevisions.text })
    .from(schema.chunkRevisions)
    .where(eq(schema.chunkRevisions.chunkId, chunkId));
  assert.ok(
    chunkRevisionTextsAfterDelete.every((revision) => revision.text === ''),
  );
  assert.ok(deletedArtifactKeys.has(sourceObjectKey));
  assert.ok(deletedArtifactKeys.has(ragExampleBeforeDelete.queryObjectKey));
  assert.ok(
    deletedArtifactKeys.has(successorExampleBeforeDelete.queryObjectKey),
  );
  assert.ok(deletedArtifactKeys.has(ragSnapshotBeforeDelete.artifactKey));
  assert.ok(deletedArtifactKeys.has(ragSnapshotBeforeDelete.manifestKey));
  assert.ok(
    deletedArtifactKeys.has(successorSnapshotBeforeDelete.artifactKey),
  );
  assert.ok(
    deletedArtifactKeys.has(successorSnapshotBeforeDelete.manifestKey),
  );

  const revokedAt = new Date();
  await db
    .update(schema.datasetSnapshots)
    .set({
      status: 'revoked',
      revokedAt,
      revocationReason: 'verification',
      updatedAt: revokedAt,
    })
    .where(eq(schema.datasetSnapshots.id, datasetSnapshotId));
  await assert.rejects(
    service.promoteModel(userId, candidate.id, {
      evaluationRunId: candidateEvaluation.id,
      alias: 'production',
    }),
    (error) => error?.getStatus?.() === 409,
  );

  const operationsMetrics = await operationsService.getMetrics(userId, {
    householdId,
    windowHours: 24,
  });
  learningOperationsMetricsResponseSchema.parse(operationsMetrics);
  assert.ok(operationsMetrics.pipelines.total > 0);
  assert.equal(operationsMetrics.quality.humanConfirmedLabels, 1);
  assert.equal(operationsMetrics.quality.distinctLabelClasses, 1);
  assert.equal(operationsMetrics.queues.unavailableQueues, 0);
  assert.ok(operationsMetrics.alerts.pending >= 2);

  console.log(
    JSON.stringify({
      gateFailureBlocked: true,
      revokedDatasetPromotionBlocked: true,
      merchantDatasetBuilt: true,
      datasetLeakageApprovalBlocked: true,
      ragDatasetBuilt: true,
      embeddingCoverageBlocked: true,
      embeddingProjectionRollback: true,
      ragDeletionPropagation: true,
      runtimeAliasMatched: true,
      trafficPolicyLifecycleVerified: true,
      canaryAutoRollback: true,
      canaryScheduledEvaluation: true,
      canaryScheduledSuspension: true,
      canaryRollbackUnavailableSuspended: true,
      canaryOperationalAlertsCreated: true,
      operationalMetricsVerified: true,
      firstPromotionRevision: firstAlias.revision,
      candidatePromotionRevision: promoted.revision,
      rollbackRevision: rolledBack.revision,
    }),
  );
} finally {
  await operationsService.onModuleDestroy();
  await client.end({ timeout: 5 });
}
