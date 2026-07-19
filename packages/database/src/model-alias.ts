/** model alias와 현재 runtime provider identity의 일치 여부를 검증한다. */
import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from './client.js';
import * as schema from './schema.js';

export type ModelAliasResolutionErrorCode =
  | 'scope_invalid'
  | 'alias_missing'
  | 'alias_suspended'
  | 'model_not_approved'
  | 'evaluation_invalid'
  | 'dataset_invalid'
  | 'provider_mismatch'
  | 'model_mismatch'
  | 'version_mismatch'
  | 'dimensions_mismatch';

/** 원문·scope id를 노출하지 않는 serving alias 검증 오류. */
export class ModelAliasResolutionError extends Error {
  constructor(readonly code: ModelAliasResolutionErrorCode) {
    super(`model alias resolution failed: ${code}`);
    this.name = 'ModelAliasResolutionError';
  }
}

export interface ResolveModelAliasInput {
  workspaceId?: string;
  householdId?: string;
  task: string;
  alias?: string;
  provider: string;
  model: string;
  version?: string;
  dimensions?: number;
  required: boolean;
}

export interface ResolvedModelAlias {
  source: 'alias' | 'configuration';
  aliasId: string | null;
  revision: number | null;
  modelRegistryId: string | null;
  provider: string;
  model: string;
  version: string | null;
  dimensions: number | null;
}

/** provider metadata로 전달할 수 있는 원문·scope 없는 serving trace. */
export interface ModelAliasTraceMetadata {
  modelAliasId?: string;
  modelAliasRevision?: number;
  modelRegistryId?: string;
}

/** 구성 fallback은 빈 trace, alias 결정은 세 상관키를 항상 함께 반환한다. */
export function modelAliasTraceMetadata(
  resolved: ResolvedModelAlias,
): ModelAliasTraceMetadata {
  if (
    resolved.source === 'configuration' ||
    resolved.aliasId === null ||
    resolved.revision === null ||
    resolved.modelRegistryId === null
  ) {
    return {};
  }
  return {
    modelAliasId: resolved.aliasId,
    modelAliasRevision: resolved.revision,
    modelRegistryId: resolved.modelRegistryId,
  };
}

/**
 * alias가 있으면 승인·평가·dataset과 runtime identity를 모두 fail-closed 검증한다.
 * alias가 없을 때만 `required=false`가 기존 구성 사용을 허용한다.
 */
export async function resolveModelAlias(
  db: Db,
  input: ResolveModelAliasInput,
): Promise<ResolvedModelAlias> {
  const workspaceId = input.workspaceId ?? null;
  const householdId = input.householdId ?? null;
  if (Number(workspaceId !== null) + Number(householdId !== null) !== 1) {
    throw new ModelAliasResolutionError('scope_invalid');
  }
  const scopeCondition = workspaceId !== null
    ? and(
        eq(schema.modelAliases.workspaceId, workspaceId),
        isNull(schema.modelAliases.householdId),
      )
    : and(
        eq(schema.modelAliases.householdId, householdId!),
        isNull(schema.modelAliases.workspaceId),
      );
  const [row] = await db
    .select({
      alias: schema.modelAliases,
      model: schema.modelRegistry,
      evaluation: schema.evaluationRuns,
      dataset: schema.datasetSnapshots,
    })
    .from(schema.modelAliases)
    .innerJoin(
      schema.modelRegistry,
      eq(schema.modelAliases.modelRegistryId, schema.modelRegistry.id),
    )
    .leftJoin(
      schema.evaluationRuns,
      eq(schema.modelAliases.evaluationRunId, schema.evaluationRuns.id),
    )
    .leftJoin(
      schema.datasetSnapshots,
      eq(
        schema.evaluationRuns.datasetSnapshotId,
        schema.datasetSnapshots.id,
      ),
    )
    .where(
      and(
        scopeCondition,
        eq(schema.modelAliases.task, input.task),
        eq(schema.modelAliases.alias, input.alias ?? 'production'),
      ),
    )
    .limit(1);

  if (!row) {
    if (input.required) {
      throw new ModelAliasResolutionError('alias_missing');
    }
    return {
      source: 'configuration',
      aliasId: null,
      revision: null,
      modelRegistryId: null,
      provider: input.provider,
      model: input.model,
      version: input.version ?? null,
      dimensions: input.dimensions ?? null,
    };
  }
  if (row.alias.suspendedAt !== null) {
    throw new ModelAliasResolutionError('alias_suspended');
  }
  if (row.model.status !== 'approved') {
    throw new ModelAliasResolutionError('model_not_approved');
  }
  if (
    row.evaluation === null ||
    row.evaluation.status !== 'succeeded' ||
    row.evaluation.gateResult !== 'passed' ||
    row.evaluation.candidateModelId !== row.model.id
  ) {
    throw new ModelAliasResolutionError('evaluation_invalid');
  }
  if (row.dataset === null || row.dataset.status !== 'approved') {
    throw new ModelAliasResolutionError('dataset_invalid');
  }
  if (row.model.provider !== input.provider) {
    throw new ModelAliasResolutionError('provider_mismatch');
  }
  if (row.model.model !== input.model) {
    throw new ModelAliasResolutionError('model_mismatch');
  }
  if (
    input.version !== undefined &&
    row.model.version !== input.version
  ) {
    throw new ModelAliasResolutionError('version_mismatch');
  }
  const runtimeDimensions = input.dimensions ?? null;
  if (row.model.dimensions !== runtimeDimensions) {
    throw new ModelAliasResolutionError('dimensions_mismatch');
  }
  return {
    source: 'alias',
    aliasId: row.alias.id,
    revision: row.alias.revision,
    modelRegistryId: row.model.id,
    provider: row.model.provider,
    model: row.model.model,
    version: row.model.version,
    dimensions: row.model.dimensions,
  };
}
