/** 승인된 후보 모델 traffic 정책의 serving-time 검증. */
import { and, eq } from 'drizzle-orm';

import type { Db } from './client.js';
import type { ResolvedModelAlias } from './model-alias.js';
import * as schema from './schema.js';

export type ModelTrafficResolutionErrorCode =
  | 'candidate_runtime_missing'
  | 'candidate_scope_mismatch'
  | 'candidate_not_approved'
  | 'candidate_evaluation_invalid'
  | 'candidate_dataset_invalid'
  | 'candidate_approval_invalid'
  | 'candidate_provider_mismatch'
  | 'candidate_model_mismatch'
  | 'candidate_version_mismatch'
  | 'candidate_dimensions_invalid';

/** 정책 오류 원문이나 scope 식별자를 노출하지 않는 traffic 검증 오류. */
export class ModelTrafficResolutionError extends Error {
  constructor(readonly code: ModelTrafficResolutionErrorCode) {
    super(`model traffic resolution failed: ${code}`);
    this.name = 'ModelTrafficResolutionError';
  }
}

/** 후보 LLM 프로세스 구성 identity. credential은 포함하지 않는다. */
export interface CandidateLlmRuntimeIdentity {
  provider: string;
  model: string;
  version: string;
}

/** serving-time traffic 정책 조회 입력. */
export interface ResolveModelTrafficPolicyInput {
  primary: ResolvedModelAlias;
  candidateRuntime: CandidateLlmRuntimeIdentity | null;
}

/** 승인·평가·runtime identity를 모두 통과한 활성 traffic 정책. */
export interface ResolvedModelTrafficPolicy {
  id: string;
  modelAliasId: string;
  aliasRevision: number;
  candidateModelRegistryId: string;
  mode: 'shadow' | 'live';
  trafficBasisPoints: number;
  routingSalt: string;
}

/**
 * 현재 alias revision에 고정된 활성 정책을 조회한다. 정책이 없으면 null이며,
 * 있으면 후보의 승인 평가·dataset·프로세스 runtime identity를 fail-closed 검증한다.
 */
export async function resolveModelTrafficPolicy(
  db: Db,
  input: ResolveModelTrafficPolicyInput,
): Promise<ResolvedModelTrafficPolicy | null> {
  if (
    input.primary.source !== 'alias' ||
    input.primary.aliasId === null ||
    input.primary.revision === null ||
    input.primary.modelRegistryId === null
  ) {
    return null;
  }

  const [row] = await db
    .select({
      policy: schema.modelTrafficPolicies,
      alias: schema.modelAliases,
      candidate: schema.modelRegistry,
      evaluation: schema.evaluationRuns,
      dataset: schema.datasetSnapshots,
      approval: schema.modelRegistryApprovals,
    })
    .from(schema.modelTrafficPolicies)
    .innerJoin(
      schema.modelAliases,
      eq(schema.modelTrafficPolicies.modelAliasId, schema.modelAliases.id),
    )
    .innerJoin(
      schema.modelRegistry,
      eq(
        schema.modelTrafficPolicies.candidateModelRegistryId,
        schema.modelRegistry.id,
      ),
    )
    .innerJoin(
      schema.evaluationRuns,
      eq(schema.modelTrafficPolicies.evaluationRunId, schema.evaluationRuns.id),
    )
    .innerJoin(
      schema.datasetSnapshots,
      eq(schema.evaluationRuns.datasetSnapshotId, schema.datasetSnapshots.id),
    )
    .leftJoin(
      schema.modelRegistryApprovals,
      eq(
        schema.modelRegistryApprovals.modelRegistryId,
        schema.modelRegistry.id,
      ),
    )
    .where(
      and(
        eq(schema.modelTrafficPolicies.modelAliasId, input.primary.aliasId),
        eq(schema.modelTrafficPolicies.aliasRevision, input.primary.revision),
        eq(schema.modelTrafficPolicies.status, 'active'),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }
  if (input.candidateRuntime === null) {
    throw new ModelTrafficResolutionError('candidate_runtime_missing');
  }
  if (
    row.candidate.task !== row.alias.task ||
    row.candidate.workspaceId !== row.alias.workspaceId ||
    row.candidate.householdId !== row.alias.householdId ||
    row.candidate.id === input.primary.modelRegistryId
  ) {
    throw new ModelTrafficResolutionError('candidate_scope_mismatch');
  }
  if (row.candidate.status !== 'approved') {
    throw new ModelTrafficResolutionError('candidate_not_approved');
  }
  if (
    row.evaluation.status !== 'succeeded' ||
    row.evaluation.gateResult !== 'passed' ||
    row.evaluation.candidateModelId !== row.candidate.id
  ) {
    throw new ModelTrafficResolutionError('candidate_evaluation_invalid');
  }
  if (row.dataset.status !== 'approved') {
    throw new ModelTrafficResolutionError('candidate_dataset_invalid');
  }
  if (
    row.approval === null ||
    row.approval.evaluationRunId !== row.evaluation.id
  ) {
    throw new ModelTrafficResolutionError('candidate_approval_invalid');
  }
  if (row.candidate.provider !== input.candidateRuntime.provider) {
    throw new ModelTrafficResolutionError('candidate_provider_mismatch');
  }
  if (row.candidate.model !== input.candidateRuntime.model) {
    throw new ModelTrafficResolutionError('candidate_model_mismatch');
  }
  if (row.candidate.version !== input.candidateRuntime.version) {
    throw new ModelTrafficResolutionError('candidate_version_mismatch');
  }
  if (row.candidate.dimensions !== null) {
    throw new ModelTrafficResolutionError('candidate_dimensions_invalid');
  }

  return {
    id: row.policy.id,
    modelAliasId: row.alias.id,
    aliasRevision: row.policy.aliasRevision,
    candidateModelRegistryId: row.candidate.id,
    mode: row.policy.mode,
    trafficBasisPoints: row.policy.trafficBasisPoints,
    routingSalt: row.policy.routingSalt,
  };
}
