import { createHash } from 'node:crypto';

/** dataset split 이름. */
export type DatasetSplitName = 'train' | 'validation' | 'test';

/** group hash를 10,000분율 bucket에 배정하는 기존 split 정책. */
export interface DatasetGroupHashSplitPolicy {
  strategy: 'group_hash';
  seed: string;
  trainBasisPoints: number;
  validationBasisPoints: number;
  testBasisPoints: number;
}

/** group의 최신 event 시각을 기준으로 미래 holdout을 만드는 정책. */
export interface DatasetGroupTimeSplitPolicy {
  strategy: 'group_time';
  seed: string;
  validationWindowDays: number;
  testWindowDays: number;
}

/** snapshot 생성 요청에서 사용하는 split 정책. */
export type DatasetSplitPolicy =
  | DatasetGroupHashSplitPolicy
  | DatasetGroupTimeSplitPolicy;

/** 입력 데이터로부터 확정된 time cutoff를 포함하는 재현 가능 정책. */
export interface ResolvedDatasetGroupTimeSplitPolicy
  extends DatasetGroupTimeSplitPolicy {
  groupTimestamp: 'latest_event';
  referenceAt: string;
  validationCutoffAt: string;
  testCutoffAt: string;
}

/** manifest와 DB에 고정되는 최종 split 정책. */
export type ResolvedDatasetSplitPolicy =
  | DatasetGroupHashSplitPolicy
  | ResolvedDatasetGroupTimeSplitPolicy;

/** split 배정을 위해 필요한 원문 없는 row metadata. */
export interface DatasetSplitAssignmentInput {
  rowId: string;
  targetId: string;
  groupKey: string;
  relatedGroupKeys?: readonly string[];
  occurredAt: Date | string;
}

/** 각 row에 고정되는 split 감사 metadata. */
export interface DatasetSplitAssignment {
  rowId: string;
  targetId: string;
  splitGroupHash: string;
  occurredAt: string;
  split: DatasetSplitName;
}

/** snapshot 승인 전 다시 계산하는 누수 감사 결과. */
export interface DatasetLeakageAudit {
  status: 'passed' | 'failed';
  rowCount: number;
  groupCount: number;
  groupOverlapCount: number;
  targetOverlapCount: number;
  temporalViolationCount: number;
}

/** split 배정과 재현용 정책·누수 감사를 묶은 결과. */
export interface DatasetSplitPlan {
  assignments: DatasetSplitAssignment[];
  policy: ResolvedDatasetSplitPolicy;
  leakageAudit: DatasetLeakageAudit;
}

/** 기존 80/10/10 group hash split. */
export const DEFAULT_DATASET_SPLIT_POLICY: DatasetGroupHashSplitPolicy = {
  strategy: 'group_hash',
  seed: 'memory-candidate-v1',
  trainBasisPoints: 8_000,
  validationBasisPoints: 1_000,
  testBasisPoints: 1_000,
};

/** 최신 event 기준 validation 28일, test 14일 holdout. */
export const DEFAULT_DATASET_TIME_SPLIT_POLICY: DatasetGroupTimeSplitPolicy = {
  strategy: 'group_time',
  seed: 'dataset-time-split-v1',
  validationWindowDays: 28,
  testWindowDays: 14,
};

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function splitGroupHash(seed: string, groupKey: string): string {
  return sha256Hex(JSON.stringify([seed, groupKey]));
}

function normalizeOccurredAt(value: Date | string): string {
  const occurredAt = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new Error('dataset split occurredAt must be a valid timestamp');
  }
  return occurredAt.toISOString();
}

function validateSeed(seed: string): void {
  if (seed.trim().length === 0) {
    throw new Error('dataset split seed must not be empty');
  }
}

function validateHashPolicy(policy: DatasetGroupHashSplitPolicy): void {
  validateSeed(policy.seed);
  const values = [
    policy.trainBasisPoints,
    policy.validationBasisPoints,
    policy.testBasisPoints,
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error('dataset split basis points must be non-negative integers');
  }
  if (values.reduce((sum, value) => sum + value, 0) !== 10_000) {
    throw new Error('dataset split basis points must sum to 10000');
  }
}

function validateTimePolicy(policy: DatasetGroupTimeSplitPolicy): void {
  validateSeed(policy.seed);
  const windows = [policy.validationWindowDays, policy.testWindowDays];
  if (
    windows.some(
      (value) => !Number.isInteger(value) || value < 1 || value > 3_650,
    )
  ) {
    throw new Error('dataset time split windows must be 1..3650 days');
  }
}

/** 동일 seed/group key를 항상 같은 hash split에 배정한다. */
export function assignDatasetSplit(
  groupKey: string,
  policy: DatasetGroupHashSplitPolicy = DEFAULT_DATASET_SPLIT_POLICY,
): DatasetSplitName {
  validateHashPolicy(policy);
  if (groupKey.trim().length === 0) {
    throw new Error('dataset split group key must not be empty');
  }
  const bucket =
    Number.parseInt(splitGroupHash(policy.seed, groupKey).slice(0, 8), 16) %
    10_000;
  if (bucket < policy.trainBasisPoints) {
    return 'train';
  }
  if (bucket < policy.trainBasisPoints + policy.validationBasisPoints) {
    return 'validation';
  }
  return 'test';
}

function resolvePolicy(
  inputs: readonly DatasetSplitAssignmentInput[],
  policy: DatasetSplitPolicy,
): ResolvedDatasetSplitPolicy {
  if (policy.strategy === 'group_hash') {
    validateHashPolicy(policy);
    return { ...policy };
  }
  validateTimePolicy(policy);
  const referenceMs = Math.max(
    ...inputs.map((input) =>
      new Date(normalizeOccurredAt(input.occurredAt)).getTime(),
    ),
  );
  const testCutoffMs =
    referenceMs - policy.testWindowDays * MILLISECONDS_PER_DAY;
  const validationCutoffMs =
    testCutoffMs - policy.validationWindowDays * MILLISECONDS_PER_DAY;
  return {
    ...policy,
    groupTimestamp: 'latest_event',
    referenceAt: new Date(referenceMs).toISOString(),
    validationCutoffAt: new Date(validationCutoffMs).toISOString(),
    testCutoffAt: new Date(testCutoffMs).toISOString(),
  };
}

function splitForGroupTimestamp(
  groupTimestamp: number,
  policy: ResolvedDatasetGroupTimeSplitPolicy,
): DatasetSplitName {
  if (groupTimestamp < new Date(policy.validationCutoffAt).getTime()) {
    return 'train';
  }
  if (groupTimestamp < new Date(policy.testCutoffAt).getTime()) {
    return 'validation';
  }
  return 'test';
}

/** 저장된 row metadata가 group·target·시간 누수 규칙을 만족하는지 계산한다. */
export function validateDatasetLeakage(
  rows: readonly DatasetSplitAssignment[],
  policy: ResolvedDatasetSplitPolicy,
): DatasetLeakageAudit {
  const groupSplits = new Map<string, Set<DatasetSplitName>>();
  const targetSplits = new Map<string, Set<DatasetSplitName>>();
  const latestByGroup = new Map<string, number>();

  for (const row of rows) {
    if (
      row.rowId.trim().length === 0 ||
      row.targetId.trim().length === 0 ||
      !/^[a-f0-9]{64}$/.test(row.splitGroupHash)
    ) {
      throw new Error('dataset leakage row metadata is invalid');
    }
    const occurredAt = new Date(normalizeOccurredAt(row.occurredAt)).getTime();
    const splits = groupSplits.get(row.splitGroupHash) ?? new Set();
    splits.add(row.split);
    groupSplits.set(row.splitGroupHash, splits);
    const target = targetSplits.get(row.targetId) ?? new Set();
    target.add(row.split);
    targetSplits.set(row.targetId, target);
    latestByGroup.set(
      row.splitGroupHash,
      Math.max(latestByGroup.get(row.splitGroupHash) ?? occurredAt, occurredAt),
    );
  }

  const groupOverlapCount = [...groupSplits.values()].filter(
    (splits) => splits.size > 1,
  ).length;
  const targetOverlapCount = [...targetSplits.values()].filter(
    (splits) => splits.size > 1,
  ).length;
  let temporalViolationCount = 0;
  if (policy.strategy === 'group_time') {
    for (const row of rows) {
      const groupTimestamp = latestByGroup.get(row.splitGroupHash);
      if (
        groupTimestamp === undefined ||
        row.split !== splitForGroupTimestamp(groupTimestamp, policy)
      ) {
        temporalViolationCount += 1;
      }
    }
  }
  return {
    status:
      groupOverlapCount === 0 &&
      targetOverlapCount === 0 &&
      temporalViolationCount === 0
        ? 'passed'
        : 'failed',
    rowCount: rows.length,
    groupCount: groupSplits.size,
    groupOverlapCount,
    targetOverlapCount,
    temporalViolationCount,
  };
}

/** 입력을 group-aware split으로 배정하고 누수 감사를 즉시 수행한다. */
export function buildDatasetSplitPlan(
  inputs: readonly DatasetSplitAssignmentInput[],
  policy: DatasetSplitPolicy,
): DatasetSplitPlan {
  if (inputs.length === 0) {
    throw new Error('dataset split requires at least one input');
  }
  const rowIds = new Set<string>();
  const normalized = inputs.map((input) => {
    const groupKeys = [
      ...new Set([input.groupKey, ...(input.relatedGroupKeys ?? [])]),
    ];
    if (
      input.rowId.trim().length === 0 ||
      input.targetId.trim().length === 0 ||
      groupKeys.some((groupKey) => groupKey.trim().length === 0)
    ) {
      throw new Error('dataset split identifiers must not be empty');
    }
    if (rowIds.has(input.rowId)) {
      throw new Error(`duplicate dataset split row: ${input.rowId}`);
    }
    rowIds.add(input.rowId);
    return {
      ...input,
      groupKeys,
      occurredAt: normalizeOccurredAt(input.occurredAt),
    };
  });

  const parents = normalized.map((_, index) => index);
  const findRoot = (index: number): number => {
    let root = index;
    while (parents[root] !== root) {
      root = parents[root];
    }
    let current = index;
    while (parents[current] !== current) {
      const next = parents[current];
      parents[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = findRoot(left);
    const rightRoot = findRoot(right);
    if (leftRoot !== rightRoot) {
      parents[rightRoot] = leftRoot;
    }
  };
  const firstRowByGroup = new Map<string, number>();
  normalized.forEach((input, index) => {
    for (const groupKey of input.groupKeys) {
      const firstIndex = firstRowByGroup.get(groupKey);
      if (firstIndex === undefined) {
        firstRowByGroup.set(groupKey, index);
      } else {
        union(index, firstIndex);
      }
    }
  });
  const groupKeysByRoot = new Map<number, Set<string>>();
  normalized.forEach((input, index) => {
    const root = findRoot(index);
    const keys = groupKeysByRoot.get(root) ?? new Set<string>();
    input.groupKeys.forEach((groupKey) => keys.add(groupKey));
    groupKeysByRoot.set(root, keys);
  });
  const componentKeyByIndex = normalized.map((_, index) => {
    const keys = groupKeysByRoot.get(findRoot(index));
    if (!keys) {
      throw new Error('dataset split connected group is missing');
    }
    return JSON.stringify([...keys].sort());
  });
  const resolvedInputs = normalized.map((input, index) => ({
    ...input,
    groupKey: componentKeyByIndex[index],
  }));
  const resolvedPolicy = resolvePolicy(resolvedInputs, policy);
  const latestByGroup = new Map<string, number>();
  for (const input of resolvedInputs) {
    const occurredAt = new Date(input.occurredAt).getTime();
    latestByGroup.set(
      input.groupKey,
      Math.max(latestByGroup.get(input.groupKey) ?? occurredAt, occurredAt),
    );
  }
  const assignments = resolvedInputs.map((input): DatasetSplitAssignment => {
    const latest = latestByGroup.get(input.groupKey);
    if (latest === undefined) {
      throw new Error('dataset split group timestamp is missing');
    }
    return {
      rowId: input.rowId,
      targetId: input.targetId,
      splitGroupHash: splitGroupHash(resolvedPolicy.seed, input.groupKey),
      occurredAt: input.occurredAt,
      split:
        resolvedPolicy.strategy === 'group_hash'
          ? assignDatasetSplit(input.groupKey, resolvedPolicy)
          : splitForGroupTimestamp(latest, resolvedPolicy),
    };
  });
  const leakageAudit = validateDatasetLeakage(assignments, resolvedPolicy);
  if (leakageAudit.status !== 'passed') {
    throw new Error('dataset leakage validation failed');
  }
  return { assignments, policy: resolvedPolicy, leakageAudit };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** DB JSON metadata를 승인 재검증에 사용할 수 있는 정책으로 해석한다. */
export function parseResolvedDatasetSplitPolicy(
  value: unknown,
): ResolvedDatasetSplitPolicy {
  if (!isRecord(value)) {
    throw new Error('dataset split policy metadata is invalid');
  }
  if (value.strategy === 'group_time') {
    if (
      typeof value.seed !== 'string' ||
      typeof value.validationWindowDays !== 'number' ||
      typeof value.testWindowDays !== 'number' ||
      value.groupTimestamp !== 'latest_event' ||
      typeof value.referenceAt !== 'string' ||
      typeof value.validationCutoffAt !== 'string' ||
      typeof value.testCutoffAt !== 'string'
    ) {
      throw new Error('dataset time split policy metadata is incomplete');
    }
    const policy: ResolvedDatasetGroupTimeSplitPolicy = {
      strategy: 'group_time',
      seed: value.seed,
      validationWindowDays: value.validationWindowDays,
      testWindowDays: value.testWindowDays,
      groupTimestamp: value.groupTimestamp,
      referenceAt: value.referenceAt,
      validationCutoffAt: value.validationCutoffAt,
      testCutoffAt: value.testCutoffAt,
    };
    validateTimePolicy(policy);
    const timestamps = [
      policy.referenceAt,
      policy.validationCutoffAt,
      policy.testCutoffAt,
    ].map((item) => new Date(normalizeOccurredAt(item)).getTime());
    const expectedTestCutoff =
      timestamps[0] - policy.testWindowDays * MILLISECONDS_PER_DAY;
    const expectedValidationCutoff =
      expectedTestCutoff - policy.validationWindowDays * MILLISECONDS_PER_DAY;
    if (
      timestamps[2] !== expectedTestCutoff ||
      timestamps[1] !== expectedValidationCutoff
    ) {
      throw new Error('dataset time split cutoffs are invalid');
    }
    return policy;
  }
  if (
    typeof value.seed !== 'string' ||
    typeof value.trainBasisPoints !== 'number' ||
    typeof value.validationBasisPoints !== 'number' ||
    typeof value.testBasisPoints !== 'number'
  ) {
    throw new Error('dataset hash split policy metadata is incomplete');
  }
  const policy: DatasetGroupHashSplitPolicy = {
    strategy: 'group_hash',
    seed: value.seed,
    trainBasisPoints: value.trainBasisPoints,
    validationBasisPoints: value.validationBasisPoints,
    testBasisPoints: value.testBasisPoints,
  };
  validateHashPolicy(policy);
  return policy;
}
