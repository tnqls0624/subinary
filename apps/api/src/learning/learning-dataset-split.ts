import {
  canonicalJson,
  DEFAULT_DATASET_SPLIT_POLICY,
  DEFAULT_DATASET_TIME_SPLIT_POLICY,
  sha256Hex,
  type DatasetLeakageAudit,
  type DatasetSplitPolicy,
  type ResolvedDatasetSplitPolicy,
} from '@family/rag';

/** dataset 생성 API가 공통으로 받는 split 옵션. */
export interface LearningDatasetSplitOptions {
  splitSeed?: string;
  splitStrategy?: 'group_time' | 'group_hash';
  validationWindowDays?: number;
  testWindowDays?: number;
}

/** API 옵션을 builder가 사용하는 명시적 split 정책으로 정규화한다. */
export function createLearningDatasetSplitPolicy(
  options: LearningDatasetSplitOptions,
  defaultSeed: string,
): DatasetSplitPolicy {
  if (options.splitStrategy === 'group_hash') {
    if (
      options.validationWindowDays !== undefined ||
      options.testWindowDays !== undefined
    ) {
      throw new Error('time windows require group_time split strategy');
    }
    return {
      ...DEFAULT_DATASET_SPLIT_POLICY,
      seed: options.splitSeed ?? defaultSeed,
    };
  }
  return {
    ...DEFAULT_DATASET_TIME_SPLIT_POLICY,
    seed: options.splitSeed ?? defaultSeed,
    validationWindowDays:
      options.validationWindowDays ??
      DEFAULT_DATASET_TIME_SPLIT_POLICY.validationWindowDays,
    testWindowDays:
      options.testWindowDays ??
      DEFAULT_DATASET_TIME_SPLIT_POLICY.testWindowDays,
  };
}

/** cutoff와 누수 감사 결과를 snapshot JSON metadata로 고정한다. */
export function toStoredSplitPolicy(
  policy: ResolvedDatasetSplitPolicy,
  leakageAudit: DatasetLeakageAudit,
): Record<string, unknown> {
  return { ...policy, leakageAudit };
}

/** artifact와 정책이 모두 바뀌지 않아야 재사용되는 snapshot version을 만든다. */
export function createDatasetSnapshotVersion(
  schemaVersion: string,
  artifactHash: string,
  policy: ResolvedDatasetSplitPolicy,
): string {
  const identityHash = sha256Hex(
    canonicalJson({ artifactHash, splitPolicy: policy }),
  );
  return `${schemaVersion}-${identityHash.slice(0, 16)}`;
}
