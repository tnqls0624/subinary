import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assignDatasetSplit,
  buildDatasetSplitPlan,
  DEFAULT_DATASET_TIME_SPLIT_POLICY,
  parseResolvedDatasetSplitPolicy,
  validateDatasetLeakage,
  type DatasetSplitAssignment,
  type DatasetSplitPolicy,
} from './dataset-split.js';
import {
  buildMemoryCandidateDatasetArtifact,
  buildMerchantCategoryDatasetArtifact,
  buildRagRetrievalDatasetArtifact,
  canonicalJson,
  createChunkRevisionIdentity,
  createEmbeddingHash,
} from './revisions.js';

describe('revision identity', () => {
  it('source 순서와 중복에 무관한 chunk identity를 만든다', () => {
    const first = createChunkRevisionIdentity('hello', ['b', 'a', 'a']);
    const second = createChunkRevisionIdentity('hello', ['a', 'b']);

    expect(first).toEqual(second);
    expect(first.contentHash).toHaveLength(64);
    expect(first.sourceFingerprint).toHaveLength(64);
    expect(
      createChunkRevisionIdentity('changed', ['a', 'b']).contentHash,
    ).not.toBe(first.contentHash);
  });

  it('유효 벡터 hash를 만들고 빈 값·비유한 값은 거부한다', () => {
    expect(createEmbeddingHash([0, 0.25, -1])).toHaveLength(64);
    expect(() => createEmbeddingHash([])).toThrow('must not be empty');
    expect(() => createEmbeddingHash([Number.NaN])).toThrow('finite numbers');
  });
});

describe('canonical dataset artifact', () => {
  it('입력 순서와 label key 순서에 무관한 동일 artifact를 만든다', () => {
    const first = buildMemoryCandidateDatasetArtifact([
      {
        feedbackEventId: 'feedback-b',
        targetId: 'candidate-b',
        chunkRevisionId: 'revision-b',
        groupKey: 'thread-b',
        occurredAt: '2026-06-01T00:00:00.000Z',
        labelSchemaVersion: 'memory-candidate-v1',
        label: { type: 'fact', decision: 'approved' },
        source: 'human_confirmed',
      },
      {
        feedbackEventId: 'feedback-a',
        targetId: 'candidate-a',
        chunkRevisionId: 'revision-a',
        groupKey: 'thread-a',
        occurredAt: '2026-07-01T00:00:00.000Z',
        labelSchemaVersion: 'memory-candidate-v1',
        label: { decision: 'rejected', type: 'task' },
        source: 'human_rejected',
      },
    ]);
    const second = buildMemoryCandidateDatasetArtifact([
      {
        feedbackEventId: 'feedback-a',
        targetId: 'candidate-a',
        chunkRevisionId: 'revision-a',
        groupKey: 'thread-a',
        occurredAt: '2026-07-01T00:00:00.000Z',
        labelSchemaVersion: 'memory-candidate-v1',
        label: { type: 'task', decision: 'rejected' },
        source: 'human_rejected',
      },
      {
        feedbackEventId: 'feedback-b',
        targetId: 'candidate-b',
        chunkRevisionId: 'revision-b',
        groupKey: 'thread-b',
        occurredAt: '2026-06-01T00:00:00.000Z',
        labelSchemaVersion: 'memory-candidate-v1',
        label: { decision: 'approved', type: 'fact' },
        source: 'human_confirmed',
      },
    ]);

    expect(second.artifactHash).toBe(first.artifactHash);
    expect(second.jsonl).toBe(first.jsonl);
    expect(first.rows).toHaveLength(2);
    expect(
      Object.values(first.splitCounts).reduce((sum, value) => sum + value, 0),
    ).toBe(2);
  });

  it('같은 group은 결정적으로 같은 split을 사용한다', () => {
    expect(assignDatasetSplit('same-thread')).toBe(
      assignDatasetSplit('same-thread'),
    );
  });

  it('비어 있거나 잘못된 입력과 split 정책을 거부한다', () => {
    const invalidPolicy: DatasetSplitPolicy = {
      strategy: 'group_hash',
      seed: 'v1',
      trainBasisPoints: 9_000,
      validationBasisPoints: 500,
      testBasisPoints: 400,
    };
    expect(() => buildMemoryCandidateDatasetArtifact([])).toThrow(
      'at least one input',
    );
    expect(() => assignDatasetSplit('group', invalidPolicy)).toThrow(
      'sum to 10000',
    );
    expect(() => canonicalJson({ value: undefined })).toThrow('undefined');
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(
      'non-finite',
    );
  });

  it('가맹점 target 누수 없이 결정적인 Gold artifact를 만든다', () => {
    const policy: DatasetSplitPolicy = {
      strategy: 'group_hash',
      seed: 'merchant-category-v1',
      trainBasisPoints: 8_000,
      validationBasisPoints: 1_000,
      testBasisPoints: 1_000,
    };
    const first = buildMerchantCategoryDatasetArtifact(
      [
        {
          feedbackEventId: 'feedback-b',
          targetId: 'merchant-b',
          merchantCategoryRuleId: 'rule-b',
          merchantPattern: '스타벅스',
          categoryId: 'category-b',
          categorySlug: 'cafe',
          occurredAt: '2026-07-01T00:00:00.000Z',
          labelSchemaVersion: 'merchant-category-v1',
          source: 'human_confirmed',
        },
        {
          feedbackEventId: 'feedback-a',
          targetId: 'merchant-a',
          merchantCategoryRuleId: 'rule-a',
          merchantPattern: '서울교통공사',
          categoryId: 'category-a',
          categorySlug: 'transport',
          occurredAt: '2026-06-01T00:00:00.000Z',
          labelSchemaVersion: 'merchant-category-v1',
          source: 'human_confirmed',
        },
      ],
      policy,
    );
    const second = buildMerchantCategoryDatasetArtifact(
      [...first.rows].reverse().map((row) => ({
        feedbackEventId: row.feedbackEventId,
        targetId: row.targetId,
        merchantCategoryRuleId: row.merchantCategoryRuleId,
        merchantPattern: row.merchantPattern,
        categoryId: row.categoryId,
        categorySlug: row.categorySlug,
        occurredAt: row.occurredAt,
        labelSchemaVersion: row.labelSchemaVersion,
        source: row.source,
      })),
      policy,
    );

    expect(second.jsonl).toBe(first.jsonl);
    expect(second.artifactHash).toBe(first.artifactHash);
    expect(first.rows.every((row) => row.merchantPattern.length > 0)).toBe(
      true,
    );
  });

  it('중복 가맹점 target과 빈 입력을 거부한다', () => {
    const policy: DatasetSplitPolicy = {
      strategy: 'group_hash',
      seed: 'merchant-category-v1',
      trainBasisPoints: 8_000,
      validationBasisPoints: 1_000,
      testBasisPoints: 1_000,
    };
    const input = {
      feedbackEventId: 'feedback-a',
      targetId: 'merchant-a',
      merchantCategoryRuleId: 'rule-a',
      merchantPattern: '가맹점',
      categoryId: 'category-a',
      categorySlug: 'other',
      occurredAt: '2026-07-01T00:00:00.000Z',
      labelSchemaVersion: 'merchant-category-v1',
      source: 'human_confirmed' as const,
    };
    expect(() => buildMerchantCategoryDatasetArtifact([], policy)).toThrow(
      'at least one input',
    );
    expect(() =>
      buildMerchantCategoryDatasetArtifact(
        [input, { ...input, feedbackEventId: 'feedback-b' }],
        policy,
      ),
    ).toThrow('duplicate merchant target');
  });

  it('RAG 질의–관련 청크 pair를 hash 검증 후 결정적으로 고정한다', () => {
    const policy: DatasetSplitPolicy = {
      strategy: 'group_hash',
      seed: 'rag-embedding-v1',
      trainBasisPoints: 8_000,
      validationBasisPoints: 1_000,
      testBasisPoints: 1_000,
    };
    const query = '결제 장애 대응 절차';
    const queryHash = createHash('sha256').update(query).digest('hex');
    const first = buildRagRetrievalDatasetArtifact(
      [
        {
          feedbackEventId: 'feedback-b',
          targetId: 'example-b',
          query,
          queryHash,
          chunkRevisionId: 'revision-b',
          sourceGroupKey: 'source-b',
          occurredAt: '2026-07-01T00:00:00.000Z',
          labelSchemaVersion: 'rag-retrieval-relevance-v1',
          source: 'human_confirmed',
        },
        {
          feedbackEventId: 'feedback-a',
          targetId: 'example-a',
          query: '런북 위치',
          queryHash: createHash('sha256').update('런북 위치').digest('hex'),
          chunkRevisionId: 'revision-a',
          sourceGroupKey: 'source-a',
          occurredAt: '2026-06-01T00:00:00.000Z',
          labelSchemaVersion: 'rag-retrieval-relevance-v1',
          source: 'human_confirmed',
        },
      ],
      policy,
    );
    const second = buildRagRetrievalDatasetArtifact(
      [...first.rows].reverse().map((row) => ({
        feedbackEventId: row.feedbackEventId,
        targetId: row.targetId,
        query: row.query,
        queryHash: row.queryHash,
        chunkRevisionId: row.positiveChunkRevisionId,
        sourceGroupKey:
          row.positiveChunkRevisionId === 'revision-a'
            ? 'source-a'
            : 'source-b',
        occurredAt: row.occurredAt,
        labelSchemaVersion: row.labelSchemaVersion,
        source: row.source,
      })),
      policy,
    );

    expect(second.jsonl).toBe(first.jsonl);
    expect(second.artifactHash).toBe(first.artifactHash);
    expect(first.rows.every((row) => row.targetType === 'rag-retrieval')).toBe(
      true,
    );
  });

  it('RAG query hash 불일치와 중복 pair를 거부한다', () => {
    const policy: DatasetSplitPolicy = {
      strategy: 'group_hash',
      seed: 'rag-embedding-v1',
      trainBasisPoints: 8_000,
      validationBasisPoints: 1_000,
      testBasisPoints: 1_000,
    };
    const input = {
      feedbackEventId: 'feedback-a',
      targetId: 'example-a',
      query: '검색 질의',
      queryHash: createHash('sha256').update('검색 질의').digest('hex'),
      chunkRevisionId: 'revision-a',
      sourceGroupKey: 'source-a',
      occurredAt: '2026-07-01T00:00:00.000Z',
      labelSchemaVersion: 'rag-retrieval-relevance-v1',
      source: 'human_confirmed' as const,
    };
    expect(() =>
      buildRagRetrievalDatasetArtifact(
        [{ ...input, queryHash: '0'.repeat(64) }],
        policy,
      ),
    ).toThrow('hash does not match');
    expect(() =>
      buildRagRetrievalDatasetArtifact(
        [input, { ...input, feedbackEventId: 'feedback-b' }],
        policy,
      ),
    ).toThrow('duplicate RAG retrieval query/chunk pair');
  });
});

describe('group-aware time split leakage audit', () => {
  it('group의 최신 event를 기준으로 과거 row까지 같은 holdout에 격리한다', () => {
    const plan = buildDatasetSplitPlan(
      [
        {
          rowId: 'returning-old',
          targetId: 'target-old',
          groupKey: 'query-old',
          relatedGroupKeys: ['shared-source'],
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
        {
          rowId: 'train-row',
          targetId: 'target-train',
          groupKey: 'train-group',
          occurredAt: '2026-05-01T00:00:00.000Z',
        },
        {
          rowId: 'validation-row',
          targetId: 'target-validation',
          groupKey: 'validation-group',
          occurredAt: '2026-06-20T00:00:00.000Z',
        },
        {
          rowId: 'returning-new',
          targetId: 'target-new',
          groupKey: 'query-new',
          relatedGroupKeys: ['shared-source'],
          occurredAt: '2026-07-18T00:00:00.000Z',
        },
      ],
      { ...DEFAULT_DATASET_TIME_SPLIT_POLICY, seed: 'time-v1' },
    );

    expect(plan.policy.strategy).toBe('group_time');
    expect(plan.leakageAudit).toMatchObject({
      status: 'passed',
      rowCount: 4,
      groupCount: 3,
      groupOverlapCount: 0,
      targetOverlapCount: 0,
      temporalViolationCount: 0,
    });
    expect(
      plan.assignments.find((row) => row.rowId === 'train-row')?.split,
    ).toBe('train');
    expect(
      plan.assignments.find((row) => row.rowId === 'validation-row')?.split,
    ).toBe('validation');
    expect(
      plan.assignments
        .filter((row) => row.rowId.startsWith('returning-'))
        .map((row) => row.split),
    ).toEqual(['test', 'test']);
  });

  it('저장 split 변조로 생긴 group·time 누수를 실패로 판정한다', () => {
    const plan = buildDatasetSplitPlan(
      [
        {
          rowId: 'row-old',
          targetId: 'target-old',
          groupKey: 'shared-group',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
        {
          rowId: 'row-new',
          targetId: 'target-new',
          groupKey: 'shared-group',
          occurredAt: '2026-07-18T00:00:00.000Z',
        },
      ],
      { ...DEFAULT_DATASET_TIME_SPLIT_POLICY, seed: 'time-v1' },
    );
    const corrupted: DatasetSplitAssignment[] = plan.assignments.map((row) =>
      row.rowId === 'row-old' ? { ...row, split: 'train' } : row,
    );

    expect(validateDatasetLeakage(corrupted, plan.policy)).toMatchObject({
      status: 'failed',
      groupOverlapCount: 1,
      temporalViolationCount: 1,
    });
  });

  it('유효하지 않은 event time과 holdout 기간을 거부한다', () => {
    const input = {
      rowId: 'row-a',
      targetId: 'target-a',
      groupKey: 'group-a',
      occurredAt: 'not-a-date',
    };
    expect(() =>
      buildDatasetSplitPlan([input], DEFAULT_DATASET_TIME_SPLIT_POLICY),
    ).toThrow('valid timestamp');
    expect(() =>
      buildDatasetSplitPlan(
        [{ ...input, occurredAt: '2026-07-18T00:00:00.000Z' }],
        {
          ...DEFAULT_DATASET_TIME_SPLIT_POLICY,
          validationWindowDays: 0,
        },
      ),
    ).toThrow('1..3650 days');

    const validPlan = buildDatasetSplitPlan(
      [{ ...input, occurredAt: '2026-07-18T00:00:00.000Z' }],
      DEFAULT_DATASET_TIME_SPLIT_POLICY,
    );
    expect(() =>
      parseResolvedDatasetSplitPolicy({
        ...validPlan.policy,
        testCutoffAt: '2026-07-01T00:00:00.000Z',
      }),
    ).toThrow('cutoffs are invalid');
  });
});
