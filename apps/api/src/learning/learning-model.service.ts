/**
 * Offline 평가, 모델 승인, named alias 승격/rollback 제어 평면.
 * 실제 metric 원문과 credential은 받지 않으며 gate 판정은 서버에서 수행한다.
 */
import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  sql,
} from 'drizzle-orm';

import type {
  EvaluationRunCreateRequest,
  EvaluationRunSummary,
  LearningScope,
  ModelCanaryEvaluateRequest,
  ModelCanaryEvaluationSummary,
  ModelCanaryEvaluationTrigger,
  ModelCanaryPolicyRequest,
  ModelAliasRollbackRequest,
  ModelAliasSummary,
  ModelApprovalRequest,
  ModelGateCriterion,
  ModelGateCriterionResult,
  ModelPromotionRequest,
  ModelRegistryCreateRequest,
  ModelRegistryListQuery,
  ModelRegistrySummary,
  ModelTrafficPolicyCreateRequest,
  ModelTrafficPolicyPauseRequest,
  ModelTrafficPolicySummary,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import {
  canonicalJson,
  RAG_EMBEDDING_PREPROCESSING_VERSION,
  sha256Hex,
} from '@family/rag';
import {
  evaluateModelCanary,
  evaluateModelGate,
  MODEL_SERVING_TASKS,
  type ModelCanaryDecisionReason,
} from '@family/shared';

import { DB } from '../database/database.constants';

const PRIVILEGED_HOUSEHOLD_ROLES = ['owner', 'admin'] as const;

interface StoredScope {
  workspaceId: string | null;
  householdId: string | null;
}

type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

interface PromotionGateDetails extends Record<string, unknown> {
  gate: 'embedding_index_coverage';
  required: boolean;
  activeChunkCount?: number;
  coveredChunkCount?: number;
  coverageBasisPoints?: number;
  provider?: string;
  model?: string;
  modelRevision?: string;
  dimensions?: number;
  preprocessingVersion?: string;
}

const DEFAULT_MODEL_CANARY_POLICY: ModelCanaryPolicyRequest = {
  minimumInvocationCount: 20,
  maximumErrorRateBasisPoints: 500,
  maximumP95DurationMs: 5_000,
  observationWindowSeconds: 1_800,
};

interface CanaryMetrics {
  invocationCount: number;
  failedInvocationCount: number;
  p95DurationMs: number;
}

interface CanaryRollbackAudit extends Record<string, unknown> {
  trigger: ModelCanaryEvaluationTrigger;
  evaluatedRevision: number;
  reason: ModelCanaryDecisionReason;
  invocationCount: number;
  failedInvocationCount: number;
  errorRateBasisPoints: number;
  p95DurationMs: number;
}

function normalizeScope(scope: LearningScope): StoredScope {
  return {
    workspaceId: scope.workspaceId ?? null,
    householdId: scope.householdId ?? null,
  };
}

function scopesMatch(left: StoredScope, right: StoredScope): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.householdId === right.householdId
  );
}

function isModelCanaryDecisionReason(
  value: string | null,
): value is ModelCanaryDecisionReason {
  switch (value) {
    case 'observation_window_open':
    case 'within_thresholds':
    case 'insufficient_invocations':
    case 'error_rate_exceeded':
    case 'p95_duration_exceeded':
    case 'error_rate_and_p95_duration_exceeded':
    case 'rollback_unavailable':
      return true;
    default:
      return false;
  }
}

@Injectable()
export class LearningModelService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 한 scope 안에 immutable 모델 identity를 candidate로 등록한다. */
  async registerModel(
    userId: string,
    input: ModelRegistryCreateRequest,
  ): Promise<ModelRegistrySummary> {
    const scope = normalizeScope(input);
    await this.assertScopeOperator(userId, scope);

    const [created] = await this.db
      .insert(schema.modelRegistry)
      .values({
        ...scope,
        task: input.task,
        provider: input.provider,
        model: input.model,
        version: input.version,
        artifactHash: input.artifactHash ?? null,
        dimensions: input.dimensions ?? null,
        createdBy: userId,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      return this.toModelSummary(created);
    }

    const [existing] = await this.db
      .select()
      .from(schema.modelRegistry)
      .where(
        and(
          this.modelScopeCondition(scope),
          eq(schema.modelRegistry.task, input.task),
          eq(schema.modelRegistry.provider, input.provider),
          eq(schema.modelRegistry.model, input.model),
          eq(schema.modelRegistry.version, input.version),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new ConflictException('model registry identity conflict');
    }
    if (
      existing.artifactHash !== (input.artifactHash ?? null) ||
      existing.dimensions !== (input.dimensions ?? null)
    ) {
      throw new ConflictException(
        'registered model identity has different immutable metadata',
      );
    }
    return this.toModelSummary(existing);
  }

  /** owner/admin이 접근 가능한 scope의 모델을 최신순으로 조회한다. */
  async listModels(
    userId: string,
    query: ModelRegistryListQuery,
  ): Promise<ModelRegistrySummary[]> {
    const scope = normalizeScope(query);
    await this.assertScopeOperator(userId, scope);
    const where = query.task
      ? and(
          this.modelScopeCondition(scope),
          eq(schema.modelRegistry.task, query.task),
        )
      : this.modelScopeCondition(scope);
    const rows = await this.db
      .select()
      .from(schema.modelRegistry)
      .where(where)
      .orderBy(desc(schema.modelRegistry.createdAt));
    return rows.map((row) => this.toModelSummary(row));
  }

  /**
   * 승인 snapshot과 동일 scope/task 모델의 완료 평가를 immutable하게 기록한다.
   * 같은 입력과 출력은 evaluationHash로 멱등 재사용한다.
   */
  async recordEvaluation(
    userId: string,
    input: EvaluationRunCreateRequest,
  ): Promise<EvaluationRunSummary> {
    const [dataset] = await this.db
      .select()
      .from(schema.datasetSnapshots)
      .where(eq(schema.datasetSnapshots.id, input.datasetSnapshotId))
      .limit(1);
    if (!dataset) {
      throw new NotFoundException('dataset snapshot not found');
    }
    const datasetScope: StoredScope = {
      workspaceId: dataset.workspaceId,
      householdId: dataset.householdId,
    };
    await this.assertScopeOperator(userId, datasetScope);
    if (dataset.status !== 'approved') {
      throw new ConflictException(
        'evaluation requires an approved dataset snapshot',
      );
    }

    const modelIds = input.baselineModelId
      ? [input.candidateModelId, input.baselineModelId]
      : [input.candidateModelId];
    if (
      input.baselineModelId !== undefined &&
      input.baselineModelId === input.candidateModelId
    ) {
      throw new BadRequestException(
        'baseline and candidate models must differ',
      );
    }
    const models = await this.db
      .select()
      .from(schema.modelRegistry)
      .where(inArray(schema.modelRegistry.id, modelIds));
    const candidate = models.find(
      (model) => model.id === input.candidateModelId,
    );
    const baseline = input.baselineModelId
      ? models.find((model) => model.id === input.baselineModelId)
      : undefined;
    if (!candidate || (input.baselineModelId && !baseline)) {
      throw new NotFoundException('evaluation model not found');
    }
    this.assertModelMatchesDataset(candidate, datasetScope, dataset.task);
    if (candidate.status === 'rejected' || candidate.status === 'retired') {
      throw new ConflictException('candidate model is not evaluable');
    }
    if (baseline) {
      this.assertModelMatchesDataset(baseline, datasetScope, dataset.task);
      if (baseline.status !== 'approved') {
        throw new ConflictException('baseline model must be approved');
      }
    }

    const gate = evaluateModelGate({
      ...(input.baselineMetrics !== undefined
        ? { baselineMetrics: input.baselineMetrics }
        : {}),
      candidateMetrics: input.candidateMetrics,
      ...(input.baselineSliceMetrics !== undefined
        ? { baselineSliceMetrics: input.baselineSliceMetrics }
        : {}),
      candidateSliceMetrics: input.candidateSliceMetrics,
      criteria: input.criteria,
    });
    const evaluationHash = sha256Hex(
      canonicalJson({
        datasetSnapshotId: dataset.id,
        datasetArtifactHash: dataset.artifactHash,
        datasetManifestHash: dataset.manifestHash,
        baselineModelId: input.baselineModelId ?? null,
        candidateModelId: input.candidateModelId,
        evaluatorVersion: input.evaluatorVersion,
        baselineMetrics: input.baselineMetrics ?? null,
        candidateMetrics: input.candidateMetrics,
        baselineSliceMetrics: input.baselineSliceMetrics ?? null,
        candidateSliceMetrics: input.candidateSliceMetrics,
        criteria: input.criteria,
      }),
    );
    const completedAt = new Date();
    const [created] = await this.db
      .insert(schema.evaluationRuns)
      .values({
        datasetSnapshotId: dataset.id,
        baselineModelId: input.baselineModelId ?? null,
        candidateModelId: input.candidateModelId,
        evaluatorVersion: input.evaluatorVersion,
        baselineMetrics: input.baselineMetrics ?? null,
        candidateMetrics: input.candidateMetrics,
        baselineSliceMetrics: input.baselineSliceMetrics ?? null,
        candidateSliceMetrics: input.candidateSliceMetrics,
        gateCriteria: input.criteria,
        gateDetails: gate.details as unknown as Array<Record<string, unknown>>,
        gateResult: gate.result,
        evaluationHash,
        status: 'succeeded',
        createdBy: userId,
        completedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      return this.toEvaluationSummary(created);
    }
    const [existing] = await this.db
      .select()
      .from(schema.evaluationRuns)
      .where(eq(schema.evaluationRuns.evaluationHash, evaluationHash))
      .limit(1);
    if (!existing) {
      throw new ConflictException('evaluation hash conflict');
    }
    return this.toEvaluationSummary(existing);
  }

  /** 통과 평가와 현재 승인 dataset을 근거로 candidate 모델을 승인한다. */
  async approveModel(
    userId: string,
    modelId: string,
    input: ModelApprovalRequest,
  ): Promise<ModelRegistrySummary> {
    const initial = await this.findModel(modelId);
    await this.assertScopeOperator(userId, initial);

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`model-approval:${modelId}`}))`,
      );
      const [model] = await tx
        .select()
        .from(schema.modelRegistry)
        .where(eq(schema.modelRegistry.id, modelId))
        .limit(1)
        .for('update');
      if (!model) {
        throw new NotFoundException('model registry entry not found');
      }
      if (model.status === 'approved') {
        return this.toModelSummary(model);
      }
      if (model.status !== 'candidate') {
        throw new ConflictException(
          `model in ${model.status} status cannot be approved`,
        );
      }
      const evidence = await this.loadPromotionEvidence(
        tx,
        model,
        input.evaluationRunId,
      );
      const approvedAt = new Date();
      const [updated] = await tx
        .update(schema.modelRegistry)
        .set({
          status: 'approved',
          approvedBy: userId,
          approvedAt,
          updatedAt: approvedAt,
        })
        .where(eq(schema.modelRegistry.id, modelId))
        .returning();
      if (!updated) {
        throw new Error('model approval update returned no row');
      }
      await tx.insert(schema.modelRegistryApprovals).values({
        modelRegistryId: modelId,
        evaluationRunId: evidence.evaluation.id,
        approvedBy: userId,
        approvedAt,
      });
      return this.toModelSummary(updated);
    });
  }

  /** 승인된 모델을 통과 평가 근거와 함께 named alias로 원자적 승격한다. */
  async promoteModel(
    userId: string,
    modelId: string,
    input: ModelPromotionRequest,
  ): Promise<ModelAliasSummary> {
    const initial = await this.findModel(modelId);
    await this.assertScopeOperator(userId, initial);
    const scope: StoredScope = {
      workspaceId: initial.workspaceId,
      householdId: initial.householdId,
    };
    const lockKey = this.aliasLockKey(scope, initial.task, input.alias);

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const [model] = await tx
        .select()
        .from(schema.modelRegistry)
        .where(eq(schema.modelRegistry.id, modelId))
        .limit(1)
        .for('update');
      if (!model) {
        throw new NotFoundException('model registry entry not found');
      }
      if (model.status !== 'approved') {
        throw new ConflictException('only approved models can be promoted');
      }
      const approvalRows = await tx
        .select({ id: schema.modelRegistryApprovals.id })
        .from(schema.modelRegistryApprovals)
        .where(eq(schema.modelRegistryApprovals.modelRegistryId, modelId))
        .limit(1);
      if (approvalRows.length === 0) {
        throw new ConflictException('model has no approval evidence');
      }
      const gateDetails = await this.assertRuntimePromotionGates(tx, model);
      const evidence = await this.loadPromotionEvidence(
        tx,
        model,
        input.evaluationRunId,
      );
      const activatedAt = new Date();
      const aliasCondition = and(
        this.aliasScopeCondition(scope),
        eq(schema.modelAliases.task, model.task),
        eq(schema.modelAliases.alias, input.alias),
      );
      const [current] = await tx
        .select()
        .from(schema.modelAliases)
        .where(aliasCondition)
        .limit(1)
        .for('update');
      if (current?.modelRegistryId === modelId) {
        throw new ConflictException('model is already active for this alias');
      }

      if (!current) {
        const [createdAlias] = await tx
          .insert(schema.modelAliases)
          .values({
            ...scope,
            task: model.task,
            alias: input.alias,
            modelRegistryId: model.id,
            revision: 1,
            evaluationRunId: evidence.evaluation.id,
            lastChangeType: 'promotion',
            activatedBy: userId,
            activatedAt,
            suspendedAt: null,
            suspensionReason: null,
          })
          .returning();
        if (!createdAlias) {
          throw new Error('model alias insert returned no row');
        }
        await tx.insert(schema.modelAliasRevisions).values({
          modelAliasId: createdAlias.id,
          revision: 1,
          previousModelRegistryId: null,
          modelRegistryId: model.id,
          evaluationRunId: evidence.evaluation.id,
          changeType: 'promotion',
          gateDetails,
          changedBy: userId,
          changedAt: activatedAt,
        });
        return this.toAliasSummary(createdAlias, model);
      }

      const nextRevision = current.revision + 1;
      await this.supersedeMonitoringCanary(tx, current.id, activatedAt);
      await this.supersedeActiveTrafficPolicy(tx, current.id, activatedAt);
      const [updatedAlias] = await tx
        .update(schema.modelAliases)
        .set({
          modelRegistryId: model.id,
          revision: nextRevision,
          evaluationRunId: evidence.evaluation.id,
          lastChangeType: 'promotion',
          activatedBy: userId,
          activatedAt,
          suspendedAt: null,
          suspensionReason: null,
          updatedAt: activatedAt,
        })
        .where(eq(schema.modelAliases.id, current.id))
        .returning();
      if (!updatedAlias) {
        throw new Error('model alias promotion returned no row');
      }
      await tx.insert(schema.modelAliasRevisions).values({
        modelAliasId: current.id,
        revision: nextRevision,
        previousModelRegistryId: current.modelRegistryId,
        modelRegistryId: model.id,
        evaluationRunId: evidence.evaluation.id,
        changeType: 'promotion',
        gateDetails,
        changedBy: userId,
        changedAt: activatedAt,
      });
      await this.createCanaryRun(
        tx,
        current.id,
        nextRevision,
        activatedAt,
        input.canary ?? DEFAULT_MODEL_CANARY_POLICY,
        userId,
      );
      return this.toAliasSummary(updatedAlias, model);
    });
  }

  /** 승인된 후보 모델을 현재 alias revision의 shadow/live 정책으로 활성화한다. */
  async createTrafficPolicy(
    userId: string,
    input: ModelTrafficPolicyCreateRequest,
  ): Promise<ModelTrafficPolicySummary> {
    const scope = normalizeScope(input);
    await this.assertScopeOperator(userId, scope);
    if (
      input.task !== MODEL_SERVING_TASKS.RAG_ANSWER &&
      input.task !== MODEL_SERVING_TASKS.MERCHANT_CATEGORY
    ) {
      throw new BadRequestException(
        'traffic policy supports LLM serving tasks only',
      );
    }
    const lockKey = `${this.aliasLockKey(
      scope,
      input.task,
      input.alias,
    )}:traffic`;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const [alias] = await tx
        .select()
        .from(schema.modelAliases)
        .where(
          and(
            this.aliasScopeCondition(scope),
            eq(schema.modelAliases.task, input.task),
            eq(schema.modelAliases.alias, input.alias),
          ),
        )
        .limit(1)
        .for('update');
      if (!alias) {
        throw new NotFoundException('model alias not found');
      }
      if (alias.suspendedAt !== null) {
        throw new ConflictException('model alias is suspended');
      }

      const [candidate] = await tx
        .select()
        .from(schema.modelRegistry)
        .where(eq(schema.modelRegistry.id, input.candidateModelId))
        .limit(1);
      if (!candidate) {
        throw new NotFoundException('candidate model not found');
      }
      if (
        !scopesMatch(candidate, scope) ||
        candidate.task !== input.task ||
        candidate.id === alias.modelRegistryId
      ) {
        throw new ConflictException(
          'candidate must differ from primary and match scope/task',
        );
      }
      if (candidate.status !== 'approved') {
        throw new ConflictException('candidate model is not approved');
      }
      if (candidate.dimensions !== null) {
        throw new ConflictException('traffic policy supports LLM models only');
      }

      const [evidence] = await tx
        .select({
          evaluation: schema.evaluationRuns,
          dataset: schema.datasetSnapshots,
        })
        .from(schema.evaluationRuns)
        .innerJoin(
          schema.datasetSnapshots,
          eq(
            schema.evaluationRuns.datasetSnapshotId,
            schema.datasetSnapshots.id,
          ),
        )
        .where(eq(schema.evaluationRuns.id, input.evaluationRunId))
        .limit(1);
      if (
        !evidence ||
        evidence.evaluation.candidateModelId !== candidate.id ||
        evidence.evaluation.status !== 'succeeded' ||
        evidence.evaluation.gateResult !== 'passed'
      ) {
        throw new ConflictException('candidate evaluation is not valid');
      }
      if (
        evidence.dataset.status !== 'approved' ||
        !scopesMatch(evidence.dataset, scope) ||
        evidence.dataset.task !== input.task
      ) {
        throw new ConflictException('candidate dataset is not approved');
      }
      const [approval] = await tx
        .select({
          evaluationRunId: schema.modelRegistryApprovals.evaluationRunId,
        })
        .from(schema.modelRegistryApprovals)
        .where(eq(schema.modelRegistryApprovals.modelRegistryId, candidate.id))
        .limit(1);
      if (!approval || approval.evaluationRunId !== evidence.evaluation.id) {
        throw new ConflictException(
          'candidate approval does not reference this evaluation',
        );
      }

      const activatedAt = new Date();
      await this.supersedeActiveTrafficPolicy(tx, alias.id, activatedAt);
      const [created] = await tx
        .insert(schema.modelTrafficPolicies)
        .values({
          modelAliasId: alias.id,
          aliasRevision: alias.revision,
          candidateModelRegistryId: candidate.id,
          evaluationRunId: evidence.evaluation.id,
          mode: input.mode,
          trafficBasisPoints: input.trafficBasisPoints,
          routingSalt: randomUUID(),
          status: 'active',
          createdBy: userId,
          activatedAt,
          deactivatedAt: null,
        })
        .returning();
      if (!created) {
        throw new Error('model traffic policy insert returned no row');
      }
      return this.toTrafficPolicySummary(created);
    });
  }

  /** 활성 traffic 정책을 멱등하게 중지한다. */
  async pauseTrafficPolicy(
    userId: string,
    policyId: string,
    input: ModelTrafficPolicyPauseRequest,
  ): Promise<ModelTrafficPolicySummary> {
    const scope = normalizeScope(input);
    await this.assertScopeOperator(userId, scope);

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          policy: schema.modelTrafficPolicies,
          alias: schema.modelAliases,
        })
        .from(schema.modelTrafficPolicies)
        .innerJoin(
          schema.modelAliases,
          eq(schema.modelTrafficPolicies.modelAliasId, schema.modelAliases.id),
        )
        .where(eq(schema.modelTrafficPolicies.id, policyId))
        .limit(1)
        .for('update');
      if (!row) {
        throw new NotFoundException('model traffic policy not found');
      }
      if (!scopesMatch(row.alias, scope) || row.alias.task !== input.task) {
        throw new ForbiddenException('model traffic policy scope mismatch');
      }
      if (row.policy.status === 'paused') {
        return this.toTrafficPolicySummary(row.policy);
      }
      if (row.policy.status !== 'active') {
        throw new ConflictException('model traffic policy is superseded');
      }
      const deactivatedAt = new Date();
      const [updated] = await tx
        .update(schema.modelTrafficPolicies)
        .set({
          status: 'paused',
          deactivatedAt,
          updatedAt: deactivatedAt,
        })
        .where(eq(schema.modelTrafficPolicies.id, row.policy.id))
        .returning();
      if (!updated) {
        throw new Error('model traffic policy pause returned no row');
      }
      return this.toTrafficPolicySummary(updated);
    });
  }

  /** 현재 alias revision의 직전 모델로만 원자적 rollback한다. */
  async rollbackAlias(
    userId: string,
    alias: string,
    input: ModelAliasRollbackRequest,
  ): Promise<ModelAliasSummary> {
    const scope = normalizeScope(input);
    await this.assertScopeOperator(userId, scope);
    const lockKey = this.aliasLockKey(scope, input.task, alias);

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const [current] = await tx
        .select()
        .from(schema.modelAliases)
        .where(
          and(
            this.aliasScopeCondition(scope),
            eq(schema.modelAliases.task, input.task),
            eq(schema.modelAliases.alias, alias),
          ),
        )
        .limit(1)
        .for('update');
      if (!current) {
        throw new NotFoundException('model alias not found');
      }
      const changedAt = new Date();
      await this.supersedeMonitoringCanary(tx, current.id, changedAt);
      return this.rollbackLocked(tx, current, userId, changedAt);
    });
  }

  /** 현재 revision의 내부 호출 trace만 집계해 canary를 판정하고 필요 시 rollback한다. */
  async evaluateCanary(
    userId: string,
    alias: string,
    input: ModelCanaryEvaluateRequest,
  ): Promise<ModelCanaryEvaluationSummary> {
    const scope = normalizeScope(input);
    await this.assertScopeOperator(userId, scope);
    return this.evaluateCanaryWithTrigger(userId, alias, input, 'manual');
  }

  /** monitor가 승격 요청자를 감사 actor로 유지하며 동일 canary 코어를 실행한다. */
  async evaluateCanaryScheduled(
    userId: string,
    alias: string,
    input: ModelCanaryEvaluateRequest,
  ): Promise<ModelCanaryEvaluationSummary> {
    return this.evaluateCanaryWithTrigger(userId, alias, input, 'scheduled');
  }

  private async evaluateCanaryWithTrigger(
    userId: string,
    alias: string,
    input: ModelCanaryEvaluateRequest,
    trigger: ModelCanaryEvaluationTrigger,
  ): Promise<ModelCanaryEvaluationSummary> {
    const scope = normalizeScope(input);
    const lockKey = this.aliasLockKey(scope, input.task, alias);

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const [current] = await tx
        .select()
        .from(schema.modelAliases)
        .where(
          and(
            this.aliasScopeCondition(scope),
            eq(schema.modelAliases.task, input.task),
            eq(schema.modelAliases.alias, alias),
          ),
        )
        .limit(1)
        .for('update');
      if (!current) {
        throw new NotFoundException('model alias not found');
      }
      const [canary] = await tx
        .select()
        .from(schema.modelCanaryRuns)
        .where(
          and(
            eq(schema.modelCanaryRuns.modelAliasId, current.id),
            eq(schema.modelCanaryRuns.aliasRevision, input.expectedRevision),
          ),
        )
        .limit(1)
        .for('update');
      if (!canary) {
        throw new NotFoundException('model canary run not found');
      }
      const decided = this.toDecidedCanarySummary(canary);
      if (decided !== null) {
        return decided;
      }
      if (current.revision !== input.expectedRevision) {
        throw new ConflictException('model alias revision changed');
      }
      if (current.suspendedAt !== null) {
        throw new ConflictException('model alias is suspended');
      }
      if (canary.status !== 'monitoring') {
        throw new ConflictException('model canary run was superseded');
      }

      const evaluatedAt = new Date();
      const metrics = await this.aggregateCanaryMetrics(
        tx,
        canary,
        evaluatedAt,
      );
      const evaluation = evaluateModelCanary({
        ...metrics,
        minimumInvocationCount: canary.minimumInvocationCount,
        maximumErrorRateBasisPoints: canary.maximumErrorRateBasisPoints,
        maximumP95DurationMs: canary.maximumP95DurationMs,
        evaluatedAt,
        windowEndsAt: canary.windowEndsAt,
      });
      let rollbackRevision: number | null = null;
      let responseStatus:
        | 'monitoring'
        | 'passed'
        | 'rolled_back'
        | 'suspended' =
        evaluation.decision === 'rollback'
          ? 'rolled_back'
          : evaluation.decision;
      let persistedStatus:
        | 'monitoring'
        | 'passed'
        | 'rolled_back'
        | 'superseded' =
        evaluation.decision === 'rollback'
          ? 'rolled_back'
          : evaluation.decision;
      let decisionReason: ModelCanaryDecisionReason = evaluation.reason;

      if (evaluation.decision === 'rollback') {
        const audit: CanaryRollbackAudit = {
          trigger,
          evaluatedRevision: current.revision,
          reason: evaluation.reason,
          ...metrics,
          errorRateBasisPoints: evaluation.errorRateBasisPoints,
        };
        try {
          const rolledBack = await this.rollbackLocked(
            tx,
            current,
            userId,
            evaluatedAt,
            audit,
          );
          rollbackRevision = rolledBack.revision;
          responseStatus = 'rolled_back';
          persistedStatus = 'rolled_back';
        } catch (error: unknown) {
          if (!(error instanceof ConflictException)) {
            throw error;
          }
          await tx
            .update(schema.modelAliases)
            .set({
              suspendedAt: evaluatedAt,
              suspensionReason: `canary_rollback_unavailable:${evaluation.reason}`,
              updatedAt: evaluatedAt,
            })
            .where(eq(schema.modelAliases.id, current.id));
          responseStatus = 'suspended';
          persistedStatus = 'superseded';
          decisionReason = 'rollback_unavailable';
        }
      }

      await tx
        .update(schema.modelCanaryRuns)
        .set({
          status: persistedStatus,
          observedInvocationCount: metrics.invocationCount,
          observedFailedInvocationCount: metrics.failedInvocationCount,
          observedErrorRateBasisPoints: evaluation.errorRateBasisPoints,
          observedP95DurationMs: metrics.p95DurationMs,
          decisionReason:
            evaluation.decision === 'monitoring' ? null : decisionReason,
          rollbackRevision,
          lastEvaluatedAt: evaluatedAt,
          lastEvaluationTrigger: trigger,
          updatedAt: evaluatedAt,
        })
        .where(eq(schema.modelCanaryRuns.id, canary.id));

      if (responseStatus === 'rolled_back' || responseStatus === 'suspended') {
        await tx
          .insert(schema.operationalAlerts)
          .values({
            dedupeKey: `model-canary:${canary.id}:terminal`,
            kind:
              responseStatus === 'rolled_back'
                ? 'canary_rolled_back'
                : 'canary_suspended',
            severity: 'critical',
            sourceType: 'model_canary_run',
            sourceId: canary.id,
            summary:
              `${current.task} ${current.alias} canary ` +
              (responseStatus === 'rolled_back'
                ? 'rolled back'
                : 'suspended'),
            details: {
              task: current.task,
              alias: current.alias,
              evaluatedRevision: current.revision,
              rollbackRevision,
              reason: decisionReason,
              trigger,
              invocationCount: metrics.invocationCount,
              failedInvocationCount: metrics.failedInvocationCount,
              errorRateBasisPoints: evaluation.errorRateBasisPoints,
              p95DurationMs: metrics.p95DurationMs,
            },
            occurredAt: evaluatedAt,
          })
          .onConflictDoNothing({
            target: schema.operationalAlerts.dedupeKey,
          });
      }

      return {
        aliasId: current.id,
        evaluatedRevision: current.revision,
        status: responseStatus,
        reason: decisionReason,
        trigger,
        invocationCount: metrics.invocationCount,
        failedInvocationCount: metrics.failedInvocationCount,
        errorRateBasisPoints: evaluation.errorRateBasisPoints,
        p95DurationMs: metrics.p95DurationMs,
        minimumInvocationCount: canary.minimumInvocationCount,
        maximumErrorRateBasisPoints: canary.maximumErrorRateBasisPoints,
        maximumP95DurationMs: canary.maximumP95DurationMs,
        windowStartedAt: canary.windowStartedAt.toISOString(),
        windowEndsAt: canary.windowEndsAt.toISOString(),
        rollbackRevision,
        evaluatedAt: evaluatedAt.toISOString(),
      };
    });
  }

  /** 현재 alias와 모델 identity를 조회한다. */
  async getAlias(
    userId: string,
    alias: string,
    input: ModelAliasRollbackRequest,
  ): Promise<ModelAliasSummary> {
    const scope = normalizeScope(input);
    await this.assertScopeOperator(userId, scope);
    const [row] = await this.db
      .select({ alias: schema.modelAliases, model: schema.modelRegistry })
      .from(schema.modelAliases)
      .innerJoin(
        schema.modelRegistry,
        eq(schema.modelAliases.modelRegistryId, schema.modelRegistry.id),
      )
      .where(
        and(
          this.aliasScopeCondition(scope),
          eq(schema.modelAliases.task, input.task),
          eq(schema.modelAliases.alias, alias),
        ),
      )
      .limit(1);
    if (!row) {
      throw new NotFoundException('model alias not found');
    }
    return this.toAliasSummary(row.alias, row.model);
  }

  private async createCanaryRun(
    tx: DbTransaction,
    modelAliasId: string,
    aliasRevision: number,
    windowStartedAt: Date,
    policy: ModelCanaryPolicyRequest,
    userId: string,
  ): Promise<void> {
    const windowEndsAt = new Date(
      windowStartedAt.getTime() + policy.observationWindowSeconds * 1_000,
    );
    await tx.insert(schema.modelCanaryRuns).values({
      modelAliasId,
      aliasRevision,
      minimumInvocationCount: policy.minimumInvocationCount,
      maximumErrorRateBasisPoints: policy.maximumErrorRateBasisPoints,
      maximumP95DurationMs: policy.maximumP95DurationMs,
      windowStartedAt,
      windowEndsAt,
      createdBy: userId,
    });
  }

  private async supersedeMonitoringCanary(
    tx: DbTransaction,
    modelAliasId: string,
    changedAt: Date,
  ): Promise<void> {
    await tx
      .update(schema.modelCanaryRuns)
      .set({
        status: 'superseded',
        decisionReason: 'alias_revision_changed',
        lastEvaluatedAt: changedAt,
        updatedAt: changedAt,
      })
      .where(
        and(
          eq(schema.modelCanaryRuns.modelAliasId, modelAliasId),
          eq(schema.modelCanaryRuns.status, 'monitoring'),
        ),
      );
  }

  private toDecidedCanarySummary(
    canary: schema.ModelCanaryRun,
  ): ModelCanaryEvaluationSummary | null {
    let status: 'passed' | 'rolled_back' | 'suspended';
    if (canary.status === 'passed') {
      status = 'passed';
    } else if (canary.status === 'rolled_back') {
      status = 'rolled_back';
    } else if (
      canary.status === 'superseded' &&
      canary.decisionReason === 'rollback_unavailable'
    ) {
      status = 'suspended';
    } else {
      return null;
    }
    if (
      !isModelCanaryDecisionReason(canary.decisionReason) ||
      canary.lastEvaluatedAt === null ||
      (canary.lastEvaluationTrigger !== 'manual' &&
        canary.lastEvaluationTrigger !== 'scheduled')
    ) {
      throw new Error('model canary decision audit is incomplete');
    }
    return {
      aliasId: canary.modelAliasId,
      evaluatedRevision: canary.aliasRevision,
      status,
      reason: canary.decisionReason,
      trigger: canary.lastEvaluationTrigger,
      invocationCount: canary.observedInvocationCount,
      failedInvocationCount: canary.observedFailedInvocationCount,
      errorRateBasisPoints: canary.observedErrorRateBasisPoints,
      p95DurationMs: canary.observedP95DurationMs,
      minimumInvocationCount: canary.minimumInvocationCount,
      maximumErrorRateBasisPoints: canary.maximumErrorRateBasisPoints,
      maximumP95DurationMs: canary.maximumP95DurationMs,
      windowStartedAt: canary.windowStartedAt.toISOString(),
      windowEndsAt: canary.windowEndsAt.toISOString(),
      rollbackRevision: canary.rollbackRevision,
      evaluatedAt: canary.lastEvaluatedAt.toISOString(),
    };
  }

  private async aggregateCanaryMetrics(
    tx: DbTransaction,
    canary: schema.ModelCanaryRun,
    evaluatedAt: Date,
  ): Promise<CanaryMetrics> {
    const observedUntil = new Date(
      Math.min(evaluatedAt.getTime(), canary.windowEndsAt.getTime()),
    );
    const [metrics] = await tx
      .select({
        invocationCount: count(schema.aiInvocations.id),
        failedInvocationCount: sql<number>`count(*) filter (where ${schema.aiInvocations.outcome} = 'failed')::int`,
        p95DurationMs: sql<number>`coalesce(ceil(percentile_cont(0.95) within group (order by ${schema.aiInvocations.durationMs})), 0)::int`,
      })
      .from(schema.aiInvocations)
      .innerJoin(
        schema.modelAliasRevisions,
        and(
          eq(
            schema.aiInvocations.modelAliasId,
            schema.modelAliasRevisions.modelAliasId,
          ),
          eq(
            schema.aiInvocations.modelAliasRevision,
            schema.modelAliasRevisions.revision,
          ),
          eq(
            schema.aiInvocations.modelRegistryId,
            schema.modelAliasRevisions.modelRegistryId,
          ),
        ),
      )
      .where(
        and(
          eq(schema.aiInvocations.modelAliasId, canary.modelAliasId),
          eq(schema.aiInvocations.modelAliasRevision, canary.aliasRevision),
          gte(schema.aiInvocations.startedAt, canary.windowStartedAt),
          lte(schema.aiInvocations.startedAt, observedUntil),
        ),
      );
    return {
      invocationCount: metrics?.invocationCount ?? 0,
      failedInvocationCount: metrics?.failedInvocationCount ?? 0,
      p95DurationMs: metrics?.p95DurationMs ?? 0,
    };
  }

  /** advisory lock과 alias row lock을 획득한 호출부에서만 사용하는 rollback 핵심. */
  private async rollbackLocked(
    tx: DbTransaction,
    current: schema.ModelAlias,
    userId: string,
    changedAt: Date,
    canaryAudit?: CanaryRollbackAudit,
  ): Promise<ModelAliasSummary> {
    await this.supersedeActiveTrafficPolicy(tx, current.id, changedAt);
    const [currentRevision] = await tx
      .select()
      .from(schema.modelAliasRevisions)
      .where(
        and(
          eq(schema.modelAliasRevisions.modelAliasId, current.id),
          eq(schema.modelAliasRevisions.revision, current.revision),
        ),
      )
      .limit(1);
    if (!currentRevision?.previousModelRegistryId) {
      throw new ConflictException('model alias has no previous revision');
    }
    const [target] = await tx
      .select()
      .from(schema.modelRegistry)
      .where(
        eq(schema.modelRegistry.id, currentRevision.previousModelRegistryId),
      )
      .limit(1)
      .for('update');
    if (!target || target.status !== 'approved') {
      throw new ConflictException('previous model is not approved');
    }
    const [approval] = await tx
      .select({
        evaluationRunId: schema.modelRegistryApprovals.evaluationRunId,
      })
      .from(schema.modelRegistryApprovals)
      .where(eq(schema.modelRegistryApprovals.modelRegistryId, target.id))
      .limit(1);
    if (!approval) {
      throw new ConflictException('previous model has no approval evidence');
    }
    await this.loadPromotionEvidence(tx, target, approval.evaluationRunId);
    const runtimeGateDetails = await this.assertRuntimePromotionGates(
      tx,
      target,
    );
    const gateDetails: Record<string, unknown> =
      canaryAudit === undefined
        ? runtimeGateDetails
        : { ...runtimeGateDetails, canaryEvaluation: canaryAudit };

    const nextRevision = current.revision + 1;
    const [updatedAlias] = await tx
      .update(schema.modelAliases)
      .set({
        modelRegistryId: target.id,
        revision: nextRevision,
        evaluationRunId: approval.evaluationRunId,
        lastChangeType: 'rollback',
        activatedBy: userId,
        activatedAt: changedAt,
        suspendedAt: null,
        suspensionReason: null,
        updatedAt: changedAt,
      })
      .where(eq(schema.modelAliases.id, current.id))
      .returning();
    if (!updatedAlias) {
      throw new Error('model alias rollback returned no row');
    }
    await tx.insert(schema.modelAliasRevisions).values({
      modelAliasId: current.id,
      revision: nextRevision,
      previousModelRegistryId: current.modelRegistryId,
      modelRegistryId: target.id,
      evaluationRunId: approval.evaluationRunId,
      changeType: 'rollback',
      gateDetails,
      changedBy: userId,
      changedAt,
    });
    return this.toAliasSummary(updatedAlias, target);
  }

  private async supersedeActiveTrafficPolicy(
    tx: DbTransaction,
    modelAliasId: string,
    changedAt: Date,
  ): Promise<void> {
    await tx
      .update(schema.modelTrafficPolicies)
      .set({
        status: 'superseded',
        deactivatedAt: changedAt,
        updatedAt: changedAt,
      })
      .where(
        and(
          eq(schema.modelTrafficPolicies.modelAliasId, modelAliasId),
          eq(schema.modelTrafficPolicies.status, 'active'),
        ),
      );
  }

  private async findModel(modelId: string): Promise<schema.ModelRegistryEntry> {
    const [model] = await this.db
      .select()
      .from(schema.modelRegistry)
      .where(eq(schema.modelRegistry.id, modelId))
      .limit(1);
    if (!model) {
      throw new NotFoundException('model registry entry not found');
    }
    return model;
  }

  private async loadPromotionEvidence(
    tx: DbTransaction,
    model: schema.ModelRegistryEntry,
    evaluationRunId: string,
  ): Promise<{
    evaluation: schema.EvaluationRun;
    dataset: schema.DatasetSnapshot;
  }> {
    const [row] = await tx
      .select({
        evaluation: schema.evaluationRuns,
        dataset: schema.datasetSnapshots,
      })
      .from(schema.evaluationRuns)
      .innerJoin(
        schema.datasetSnapshots,
        eq(schema.evaluationRuns.datasetSnapshotId, schema.datasetSnapshots.id),
      )
      .where(eq(schema.evaluationRuns.id, evaluationRunId))
      .limit(1)
      .for('share');
    if (!row) {
      throw new NotFoundException('evaluation run not found');
    }
    if (row.evaluation.candidateModelId !== model.id) {
      throw new ConflictException(
        'evaluation does not target this candidate model',
      );
    }
    if (
      row.evaluation.status !== 'succeeded' ||
      row.evaluation.gateResult !== 'passed'
    ) {
      throw new ConflictException('evaluation gate did not pass');
    }
    if (row.dataset.status !== 'approved') {
      throw new ConflictException('evaluation dataset is no longer approved');
    }
    this.assertModelMatchesDataset(
      model,
      {
        workspaceId: row.dataset.workspaceId,
        householdId: row.dataset.householdId,
      },
      row.dataset.task,
    );
    return row;
  }

  /**
   * embedding alias 변경 전에 모든 활성 chunk의 후보 model revision 벡터가 있는지
   * 확인하고, 통과한 immutable version을 온라인 projection으로 원자적으로 전환한다.
   */
  private async assertRuntimePromotionGates(
    tx: DbTransaction,
    model: schema.ModelRegistryEntry,
  ): Promise<PromotionGateDetails> {
    if (model.task !== MODEL_SERVING_TASKS.RAG_EMBEDDING) {
      return { gate: 'embedding_index_coverage', required: false };
    }
    if (model.workspaceId === null || model.householdId !== null) {
      throw new ConflictException(
        'RAG embedding model requires a workspace scope',
      );
    }
    if (model.dimensions !== schema.EMBEDDING_DIM) {
      throw new ConflictException(
        'RAG embedding model dimensions do not match the vector schema',
      );
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`rag-index:${model.workspaceId}`}))`,
    );

    const [coverage] = await tx
      .select({
        activeChunkCount: count(schema.chunks.id),
        coveredChunkCount: count(schema.embeddingVersions.id),
      })
      .from(schema.chunks)
      .innerJoin(
        schema.chunkRevisions,
        eq(schema.chunks.currentRevisionId, schema.chunkRevisions.id),
      )
      .leftJoin(
        schema.embeddingVersions,
        and(
          eq(
            schema.embeddingVersions.chunkRevisionId,
            schema.chunkRevisions.id,
          ),
          eq(schema.embeddingVersions.provider, model.provider),
          eq(schema.embeddingVersions.model, model.model),
          eq(schema.embeddingVersions.modelRevision, model.version),
          eq(schema.embeddingVersions.dim, model.dimensions),
          eq(
            schema.embeddingVersions.preprocessingVersion,
            RAG_EMBEDDING_PREPROCESSING_VERSION,
          ),
        ),
      )
      .where(
        and(
          eq(schema.chunks.workspaceId, model.workspaceId),
          isNull(schema.chunks.deletedAt),
          isNull(schema.chunkRevisions.deletedAt),
          eq(schema.chunkRevisions.isTombstone, false),
        ),
      );
    const activeChunkCount = coverage?.activeChunkCount ?? 0;
    const coveredChunkCount = coverage?.coveredChunkCount ?? 0;
    const coverageBasisPoints =
      activeChunkCount === 0
        ? 0
        : Math.floor((coveredChunkCount * 10_000) / activeChunkCount);
    if (activeChunkCount === 0 || coveredChunkCount !== activeChunkCount) {
      throw new ConflictException(
        `embedding coverage gate failed: ${coveredChunkCount}/${activeChunkCount}`,
      );
    }

    // alias와 실제 검색 projection이 같은 트랜잭션에서 함께 전환되도록 한다.
    await tx.execute(sql`
      insert into embeddings (
        id,
        chunk_id,
        model,
        dim,
        embedding,
        current_version_id,
        created_at,
        updated_at
      )
      select
        gen_random_uuid(),
        c.id,
        ${model.model},
        ${model.dimensions},
        ev.embedding,
        ev.id,
        now(),
        now()
      from chunks c
      join chunk_revisions cr
        on cr.id = c.current_revision_id
      join embedding_versions ev
        on ev.chunk_revision_id = cr.id
       and ev.provider = ${model.provider}
       and ev.model = ${model.model}
       and ev.model_revision = ${model.version}
       and ev.dim = ${model.dimensions}
       and ev.preprocessing_version = ${RAG_EMBEDDING_PREPROCESSING_VERSION}
      where c.workspace_id = ${model.workspaceId}
        and c.deleted_at is null
        and cr.deleted_at is null
        and cr.is_tombstone = false
      on conflict (chunk_id) do update set
        model = excluded.model,
        dim = excluded.dim,
        embedding = excluded.embedding,
        current_version_id = excluded.current_version_id,
        updated_at = excluded.updated_at
    `);

    return {
      gate: 'embedding_index_coverage',
      required: true,
      activeChunkCount,
      coveredChunkCount,
      coverageBasisPoints,
      provider: model.provider,
      model: model.model,
      modelRevision: model.version,
      dimensions: model.dimensions,
      preprocessingVersion: RAG_EMBEDDING_PREPROCESSING_VERSION,
    };
  }

  private assertModelMatchesDataset(
    model: schema.ModelRegistryEntry,
    datasetScope: StoredScope,
    datasetTask: string,
  ): void {
    if (!scopesMatch(model, datasetScope) || model.task !== datasetTask) {
      throw new ConflictException(
        'model and dataset must have the same scope and task',
      );
    }
  }

  private async assertScopeOperator(
    userId: string,
    scope: StoredScope,
  ): Promise<void> {
    const scopeCount =
      Number(scope.workspaceId !== null) + Number(scope.householdId !== null);
    if (scopeCount !== 1) {
      throw new BadRequestException('exactly one learning scope is required');
    }
    if (scope.workspaceId !== null) {
      const [workspace] = await this.db
        .select({ ownerUserId: schema.workspaces.ownerUserId })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, scope.workspaceId))
        .limit(1);
      if (!workspace) {
        throw new NotFoundException('workspace not found');
      }
      if (workspace.ownerUserId !== userId) {
        throw new ForbiddenException('not the workspace owner');
      }
      return;
    }
    if (scope.householdId !== null) {
      const [membership] = await this.db
        .select({ id: schema.householdMembers.id })
        .from(schema.householdMembers)
        .where(
          and(
            eq(schema.householdMembers.householdId, scope.householdId),
            eq(schema.householdMembers.userId, userId),
            eq(schema.householdMembers.status, 'active'),
            inArray(schema.householdMembers.role, PRIVILEGED_HOUSEHOLD_ROLES),
          ),
        )
        .limit(1);
      if (!membership) {
        throw new ForbiddenException('household owner or admin required');
      }
      return;
    }
    throw new BadRequestException('learning scope is missing');
  }

  private modelScopeCondition(scope: StoredScope) {
    return scope.workspaceId !== null
      ? and(
          eq(schema.modelRegistry.workspaceId, scope.workspaceId),
          isNull(schema.modelRegistry.householdId),
        )
      : and(
          eq(schema.modelRegistry.householdId, scope.householdId!),
          isNull(schema.modelRegistry.workspaceId),
        );
  }

  private aliasScopeCondition(scope: StoredScope) {
    return scope.workspaceId !== null
      ? and(
          eq(schema.modelAliases.workspaceId, scope.workspaceId),
          isNull(schema.modelAliases.householdId),
        )
      : and(
          eq(schema.modelAliases.householdId, scope.householdId!),
          isNull(schema.modelAliases.workspaceId),
        );
  }

  private aliasLockKey(
    scope: StoredScope,
    task: string,
    alias: string,
  ): string {
    const scopeKey =
      scope.workspaceId !== null
        ? `workspace:${scope.workspaceId}`
        : `household:${scope.householdId}`;
    return `model-alias:${scopeKey}:${task}:${alias}`;
  }

  private toModelSummary(
    model: schema.ModelRegistryEntry,
  ): ModelRegistrySummary {
    return {
      id: model.id,
      workspaceId: model.workspaceId,
      householdId: model.householdId,
      task: model.task,
      provider: model.provider,
      model: model.model,
      version: model.version,
      artifactHash: model.artifactHash,
      dimensions: model.dimensions,
      status: model.status,
      approvedAt: model.approvedAt?.toISOString() ?? null,
      createdAt: model.createdAt.toISOString(),
    };
  }

  private toTrafficPolicySummary(
    policy: schema.ModelTrafficPolicy,
  ): ModelTrafficPolicySummary {
    return {
      id: policy.id,
      modelAliasId: policy.modelAliasId,
      aliasRevision: policy.aliasRevision,
      candidateModelId: policy.candidateModelRegistryId,
      evaluationRunId: policy.evaluationRunId,
      mode: policy.mode,
      trafficBasisPoints: policy.trafficBasisPoints,
      status: policy.status,
      activatedAt: policy.activatedAt.toISOString(),
      deactivatedAt: policy.deactivatedAt?.toISOString() ?? null,
    };
  }

  private toEvaluationSummary(
    evaluation: schema.EvaluationRun,
  ): EvaluationRunSummary {
    return {
      id: evaluation.id,
      datasetSnapshotId: evaluation.datasetSnapshotId,
      baselineModelId: evaluation.baselineModelId,
      candidateModelId: evaluation.candidateModelId,
      evaluatorVersion: evaluation.evaluatorVersion,
      baselineMetrics: evaluation.baselineMetrics,
      candidateMetrics: evaluation.candidateMetrics,
      baselineSliceMetrics: evaluation.baselineSliceMetrics,
      candidateSliceMetrics: evaluation.candidateSliceMetrics,
      criteria: evaluation.gateCriteria as ModelGateCriterion[],
      gateDetails: evaluation.gateDetails as ModelGateCriterionResult[],
      gateResult: evaluation.gateResult,
      evaluationHash: evaluation.evaluationHash,
      completedAt: evaluation.completedAt.toISOString(),
    };
  }

  private toAliasSummary(
    alias: schema.ModelAlias,
    model: schema.ModelRegistryEntry,
  ): ModelAliasSummary {
    return {
      id: alias.id,
      workspaceId: alias.workspaceId,
      householdId: alias.householdId,
      task: alias.task,
      alias: alias.alias,
      model: this.toModelSummary(model),
      revision: alias.revision,
      evaluationRunId: alias.evaluationRunId,
      changeType: alias.lastChangeType,
      status: alias.suspendedAt === null ? 'active' : 'suspended',
      suspendedAt: alias.suspendedAt?.toISOString() ?? null,
      activatedAt: alias.activatedAt.toISOString(),
    };
  }
}
