import { createHash } from 'node:crypto';

import {
  buildDatasetSplitPlan,
  DEFAULT_DATASET_SPLIT_POLICY,
  type DatasetLeakageAudit,
  type DatasetSplitName,
  type DatasetSplitPolicy,
  type ResolvedDatasetSplitPolicy,
} from './dataset-split.js';

/** 현재 Slack RAG 청커의 출력 계약 버전. */
export const RAG_CHUNKER_VERSION = 'slack-chunk-v1';

/** 아직 별도 redaction transform이 없음을 명시하는 버전. */
export const RAG_REDACTION_VERSION = 'none-v1';

/** 임베딩 입력 전처리 계약 버전. */
export const RAG_EMBEDDING_PREPROCESSING_VERSION = 'raw-chunk-v1';

/** JSON artifact에 허용되는 재귀 값. */
export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

/** chunk revision의 내용/입력 source 정체성. */
export interface ChunkRevisionIdentity {
  contentHash: string;
  sourceFingerprint: string;
}

/** memory-candidate dataset builder 입력. 원문 대신 revision 참조만 받는다. */
export interface MemoryCandidateDatasetInput {
  feedbackEventId: string;
  targetId: string;
  chunkRevisionId: string;
  groupKey: string;
  occurredAt: Date | string;
  labelSchemaVersion: string;
  label: Record<string, unknown>;
  source: 'human_confirmed' | 'human_rejected' | 'imported_gold';
}

/** JSONL에 기록되는 단일 학습/평가 예제. */
export interface MemoryCandidateDatasetRow {
  feedbackEventId: string;
  targetType: 'memory-candidate';
  targetId: string;
  chunkRevisionId: string;
  labelSchemaVersion: string;
  label: CanonicalJsonValue;
  source: 'human_confirmed' | 'human_rejected' | 'imported_gold';
  occurredAt: string;
  splitGroupHash: string;
  split: DatasetSplitName;
}

/** immutable JSONL artifact와 검증 집계. */
export interface MemoryCandidateDatasetArtifact {
  rows: MemoryCandidateDatasetRow[];
  jsonl: string;
  artifactHash: string;
  splitCounts: Record<DatasetSplitName, number>;
  splitPolicy: ResolvedDatasetSplitPolicy;
  leakageAudit: DatasetLeakageAudit;
}

/** 사람 확정 가맹점 규칙을 Gold artifact로 만드는 입력. */
export interface MerchantCategoryDatasetInput {
  feedbackEventId: string;
  targetId: string;
  merchantCategoryRuleId: string;
  merchantPattern: string;
  categoryId: string;
  categorySlug: string;
  occurredAt: Date | string;
  labelSchemaVersion: string;
  source: 'human_confirmed' | 'imported_gold';
}

/** 가맹점명 정규화 feature와 확정 category label의 단일 예제. */
export interface MerchantCategoryDatasetRow {
  feedbackEventId: string;
  targetType: 'merchant-category';
  targetId: string;
  merchantCategoryRuleId: string;
  merchantPattern: string;
  categoryId: string;
  categorySlug: string;
  labelSchemaVersion: string;
  source: 'human_confirmed' | 'imported_gold';
  occurredAt: string;
  splitGroupHash: string;
  split: DatasetSplitName;
}

/** immutable 가맹점 분류 JSONL artifact와 split 집계. */
export interface MerchantCategoryDatasetArtifact {
  rows: MerchantCategoryDatasetRow[];
  jsonl: string;
  artifactHash: string;
  splitCounts: Record<DatasetSplitName, number>;
  splitPolicy: ResolvedDatasetSplitPolicy;
  leakageAudit: DatasetLeakageAudit;
}

/** 명시적으로 확정된 RAG 질의–관련 chunk revision pair. */
export interface RagRetrievalDatasetInput {
  feedbackEventId: string;
  targetId: string;
  query: string;
  queryHash: string;
  chunkRevisionId: string;
  sourceGroupKey: string;
  occurredAt: Date | string;
  labelSchemaVersion: string;
  source: 'human_confirmed' | 'imported_gold';
}

/** embedding 검색 offline 평가에 사용하는 단일 positive 예제. */
export interface RagRetrievalDatasetRow {
  feedbackEventId: string;
  targetType: 'rag-retrieval';
  targetId: string;
  query: string;
  queryHash: string;
  positiveChunkRevisionId: string;
  labelSchemaVersion: string;
  source: 'human_confirmed' | 'imported_gold';
  occurredAt: string;
  splitGroupHash: string;
  split: DatasetSplitName;
}

/** immutable 검색 평가 JSONL artifact와 split 집계. */
export interface RagRetrievalDatasetArtifact {
  rows: RagRetrievalDatasetRow[];
  jsonl: string;
  artifactHash: string;
  splitCounts: Record<DatasetSplitName, number>;
  splitPolicy: ResolvedDatasetSplitPolicy;
  leakageAudit: DatasetLeakageAudit;
}

/** 문자열/바이트의 SHA-256 hex를 계산한다. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown, path: string): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`dataset JSON contains a non-finite number at ${path}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`dataset JSON contains a non-plain object at ${path}`);
    }
    const result: { [key: string]: CanonicalJsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        throw new Error(`dataset JSON contains undefined at ${path}.${key}`);
      }
      result[key] = canonicalize(item, `${path}.${key}`);
    }
    return result;
  }
  throw new Error(`dataset JSON contains an unsupported value at ${path}`);
}

/** 객체 key를 재귀 정렬해 동일 입력이 항상 같은 JSON 문자열이 되게 한다. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, '$'));
}

/**
 * chunk text와 정렬·중복 제거된 source revision id 목록으로 revision identity를
 * 계산한다. source가 없는 legacy chunk도 빈 목록 fingerprint로 결정적이다.
 */
export function createChunkRevisionIdentity(
  text: string,
  sourceRevisionIds: readonly string[],
): ChunkRevisionIdentity {
  const normalizedSourceIds = [...new Set(sourceRevisionIds)].sort();
  return {
    contentHash: sha256Hex(text),
    sourceFingerprint: sha256Hex(canonicalJson(normalizedSourceIds)),
  };
}

/** 벡터의 차원·유한성을 검증하고 재현 확인용 SHA-256 hash를 계산한다. */
export function createEmbeddingHash(vector: readonly number[]): string {
  if (vector.length === 0) {
    throw new Error('embedding vector must not be empty');
  }
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error('embedding vector must contain only finite numbers');
  }
  return sha256Hex(canonicalJson(vector));
}

/**
 * 승인/거절된 memory candidate 피드백을 원문 없는 immutable JSONL로 만든다.
 * feedback id 중복과 비어 있는 snapshot은 오류로 처리한다.
 */
export function buildMemoryCandidateDatasetArtifact(
  inputs: readonly MemoryCandidateDatasetInput[],
  policy: DatasetSplitPolicy = DEFAULT_DATASET_SPLIT_POLICY,
): MemoryCandidateDatasetArtifact {
  if (inputs.length === 0) {
    throw new Error('memory candidate dataset requires at least one input');
  }

  const feedbackIds = new Set<string>();
  const orderedInputs = [...inputs]
    .sort((left, right) =>
      left.feedbackEventId.localeCompare(right.feedbackEventId),
    )
    .map((input) => {
      if (feedbackIds.has(input.feedbackEventId)) {
        throw new Error(`duplicate feedback event: ${input.feedbackEventId}`);
      }
      feedbackIds.add(input.feedbackEventId);
      if (
        input.feedbackEventId.length === 0 ||
        input.targetId.length === 0 ||
        input.chunkRevisionId.length === 0 ||
        input.labelSchemaVersion.length === 0
      ) {
        throw new Error(
          'dataset identifiers and schema version must not be empty',
        );
      }
      return input;
    });
  const splitPlan = buildDatasetSplitPlan(
    orderedInputs.map((input) => ({
      rowId: input.feedbackEventId,
      targetId: input.targetId,
      groupKey: input.groupKey,
      occurredAt: input.occurredAt,
    })),
    policy,
  );
  const splitByRowId = new Map(
    splitPlan.assignments.map((assignment) => [assignment.rowId, assignment]),
  );
  const rows = orderedInputs.map((input): MemoryCandidateDatasetRow => {
    const assignment = splitByRowId.get(input.feedbackEventId);
    if (!assignment) {
      throw new Error('memory dataset split assignment is missing');
    }
    return {
      feedbackEventId: input.feedbackEventId,
      targetType: 'memory-candidate',
      targetId: input.targetId,
      chunkRevisionId: input.chunkRevisionId,
      labelSchemaVersion: input.labelSchemaVersion,
      label: canonicalize(input.label, '$.label'),
      source: input.source,
      occurredAt: assignment.occurredAt,
      splitGroupHash: assignment.splitGroupHash,
      split: assignment.split,
    };
  });

  const jsonl = `${rows.map((row) => canonicalJson(row)).join('\n')}\n`;
  const splitCounts: Record<DatasetSplitName, number> = {
    train: 0,
    validation: 0,
    test: 0,
  };
  for (const row of rows) {
    splitCounts[row.split] += 1;
  }
  return {
    rows,
    jsonl,
    artifactHash: sha256Hex(jsonl),
    splitCounts,
    splitPolicy: splitPlan.policy,
    leakageAudit: splitPlan.leakageAudit,
  };
}

/**
 * 사람 확정 가맹점 규칙을 household-only immutable JSONL로 만든다. 같은
 * `targetId`를 split group으로 사용해 동일 가맹점이 여러 split에 섞이지 않는다.
 */
export function buildMerchantCategoryDatasetArtifact(
  inputs: readonly MerchantCategoryDatasetInput[],
  policy: DatasetSplitPolicy,
): MerchantCategoryDatasetArtifact {
  if (inputs.length === 0) {
    throw new Error('merchant category dataset requires at least one input');
  }

  const feedbackIds = new Set<string>();
  const targetIds = new Set<string>();
  const orderedInputs = [...inputs]
    .sort((left, right) =>
      left.feedbackEventId.localeCompare(right.feedbackEventId),
    )
    .map((input) => {
      if (feedbackIds.has(input.feedbackEventId)) {
        throw new Error(`duplicate feedback event: ${input.feedbackEventId}`);
      }
      if (targetIds.has(input.targetId)) {
        throw new Error(`duplicate merchant target: ${input.targetId}`);
      }
      feedbackIds.add(input.feedbackEventId);
      targetIds.add(input.targetId);
      if (
        input.feedbackEventId.length === 0 ||
        input.targetId.length === 0 ||
        input.merchantCategoryRuleId.length === 0 ||
        input.merchantPattern.trim().length === 0 ||
        input.categoryId.length === 0 ||
        input.categorySlug.trim().length === 0 ||
        input.labelSchemaVersion.length === 0
      ) {
        throw new Error(
          'merchant dataset identifiers and values must not be empty',
        );
      }
      return input;
    });
  const splitPlan = buildDatasetSplitPlan(
    orderedInputs.map((input) => ({
      rowId: input.feedbackEventId,
      targetId: input.targetId,
      groupKey: input.targetId,
      occurredAt: input.occurredAt,
    })),
    policy,
  );
  const splitByRowId = new Map(
    splitPlan.assignments.map((assignment) => [assignment.rowId, assignment]),
  );
  const rows = orderedInputs.map((input): MerchantCategoryDatasetRow => {
    const assignment = splitByRowId.get(input.feedbackEventId);
    if (!assignment) {
      throw new Error('merchant dataset split assignment is missing');
    }
    return {
      feedbackEventId: input.feedbackEventId,
      targetType: 'merchant-category',
      targetId: input.targetId,
      merchantCategoryRuleId: input.merchantCategoryRuleId,
      merchantPattern: input.merchantPattern,
      categoryId: input.categoryId,
      categorySlug: input.categorySlug,
      labelSchemaVersion: input.labelSchemaVersion,
      source: input.source,
      occurredAt: assignment.occurredAt,
      splitGroupHash: assignment.splitGroupHash,
      split: assignment.split,
    };
  });

  const jsonl = `${rows.map((row) => canonicalJson(row)).join('\n')}\n`;
  const splitCounts: Record<DatasetSplitName, number> = {
    train: 0,
    validation: 0,
    test: 0,
  };
  for (const row of rows) {
    splitCounts[row.split] += 1;
  }
  return {
    rows,
    jsonl,
    artifactHash: sha256Hex(jsonl),
    splitCounts,
    splitPolicy: splitPlan.policy,
    leakageAudit: splitPlan.leakageAudit,
  };
}

/**
 * 명시적 관련성 피드백을 embedding 검색 평가용 immutable JSONL로 만든다.
 * 같은 query hash는 항상 같은 split에 배정하며 query/hash 불일치는 거부한다.
 */
export function buildRagRetrievalDatasetArtifact(
  inputs: readonly RagRetrievalDatasetInput[],
  policy: DatasetSplitPolicy,
): RagRetrievalDatasetArtifact {
  if (inputs.length === 0) {
    throw new Error('RAG retrieval dataset requires at least one input');
  }

  const feedbackIds = new Set<string>();
  const pairs = new Set<string>();
  const orderedInputs = [...inputs]
    .sort((left, right) =>
      left.feedbackEventId.localeCompare(right.feedbackEventId),
    )
    .map((input) => {
      if (feedbackIds.has(input.feedbackEventId)) {
        throw new Error(`duplicate feedback event: ${input.feedbackEventId}`);
      }
      feedbackIds.add(input.feedbackEventId);
      const query = input.query.trim();
      if (
        input.feedbackEventId.length === 0 ||
        input.targetId.length === 0 ||
        query.length === 0 ||
        input.chunkRevisionId.length === 0 ||
        input.labelSchemaVersion.length === 0
      ) {
        throw new Error('RAG retrieval dataset values must not be empty');
      }
      if (sha256Hex(query) !== input.queryHash) {
        throw new Error('RAG retrieval query hash does not match query text');
      }
      const pairKey = canonicalJson([input.queryHash, input.chunkRevisionId]);
      if (pairs.has(pairKey)) {
        throw new Error('duplicate RAG retrieval query/chunk pair');
      }
      pairs.add(pairKey);
      return { ...input, query };
    });
  const splitPlan = buildDatasetSplitPlan(
    orderedInputs.map((input) => ({
      rowId: input.feedbackEventId,
      targetId: input.targetId,
      groupKey: input.queryHash,
      relatedGroupKeys: [input.sourceGroupKey],
      occurredAt: input.occurredAt,
    })),
    policy,
  );
  const splitByRowId = new Map(
    splitPlan.assignments.map((assignment) => [assignment.rowId, assignment]),
  );
  const rows = orderedInputs.map((input): RagRetrievalDatasetRow => {
    const assignment = splitByRowId.get(input.feedbackEventId);
    if (!assignment) {
      throw new Error('RAG dataset split assignment is missing');
    }
    return {
      feedbackEventId: input.feedbackEventId,
      targetType: 'rag-retrieval',
      targetId: input.targetId,
      query: input.query,
      queryHash: input.queryHash,
      positiveChunkRevisionId: input.chunkRevisionId,
      labelSchemaVersion: input.labelSchemaVersion,
      source: input.source,
      occurredAt: assignment.occurredAt,
      splitGroupHash: assignment.splitGroupHash,
      split: assignment.split,
    };
  });

  const jsonl = `${rows.map((row) => canonicalJson(row)).join('\n')}\n`;
  const splitCounts: Record<DatasetSplitName, number> = {
    train: 0,
    validation: 0,
    test: 0,
  };
  for (const row of rows) {
    splitCounts[row.split] += 1;
  }
  return {
    rows,
    jsonl,
    artifactHash: sha256Hex(jsonl),
    splitCounts,
    splitPolicy: splitPlan.policy,
    leakageAudit: splitPlan.leakageAudit,
  };
}
