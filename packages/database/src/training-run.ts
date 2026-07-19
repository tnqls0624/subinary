/** dataset 무효화 시 학습 실행·로컬 모델 artifact 수명주기를 함께 전파한다. */
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Db } from './client.js';
import { modelRegistry, trainingRuns } from './schema.js';

type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface RevokedTrainingArtifacts {
  affectedTrainingRunCount: number;
  trainingRunIds: string[];
  objectKeys: string[];
  modelRegistryIds: string[];
}

/**
 * snapshot 파생 학습을 revoke하고 후보 모델을 serving 불가 상태로 바꾼다.
 * 이미 revoke된 run도 아직 purge되지 않은 object key를 반환해 재시도를 보장한다.
 */
export async function revokeTrainingRuns(
  tx: DbTransaction,
  datasetSnapshotIds: readonly string[],
  reason: string,
  now: Date,
): Promise<RevokedTrainingArtifacts> {
  if (datasetSnapshotIds.length === 0) {
    return {
      affectedTrainingRunCount: 0,
      trainingRunIds: [],
      objectKeys: [],
      modelRegistryIds: [],
    };
  }
  const existing = await tx
    .select({
      id: trainingRuns.id,
      status: trainingRuns.status,
      artifactKey: trainingRuns.artifactKey,
      artifactPurgedAt: trainingRuns.artifactPurgedAt,
      modelRegistryId: trainingRuns.modelRegistryId,
      completedAt: trainingRuns.completedAt,
    })
    .from(trainingRuns)
    .where(inArray(trainingRuns.datasetSnapshotId, [...datasetSnapshotIds]));
  const activeIds = existing
    .filter((run) => run.status !== 'revoked')
    .map((run) => run.id);
  const unfinishedIds = existing
    .filter((run) => run.status !== 'revoked' && run.completedAt === null)
    .map((run) => run.id);
  if (unfinishedIds.length > 0) {
    await tx
      .update(trainingRuns)
      .set({
        status: 'revoked',
        completedAt: now,
        revokedAt: now,
        revocationReason: reason,
        updatedAt: now,
      })
      .where(inArray(trainingRuns.id, unfinishedIds));
  }
  const finishedIds = activeIds.filter((id) => !unfinishedIds.includes(id));
  if (finishedIds.length > 0) {
    await tx
      .update(trainingRuns)
      .set({
        status: 'revoked',
        revokedAt: now,
        revocationReason: reason,
        updatedAt: now,
      })
      .where(inArray(trainingRuns.id, finishedIds));
  }
  const modelRegistryIds = [
    ...new Set(
      existing
        .map((run) => run.modelRegistryId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (modelRegistryIds.length > 0) {
    await tx
      .update(modelRegistry)
      .set({ status: 'rejected', rejectedAt: now, updatedAt: now })
      .where(
        and(
          inArray(modelRegistry.id, modelRegistryIds),
          eq(modelRegistry.status, 'candidate'),
        ),
      );
    await tx
      .update(modelRegistry)
      .set({ status: 'retired', retiredAt: now, updatedAt: now })
      .where(
        and(
          inArray(modelRegistry.id, modelRegistryIds),
          eq(modelRegistry.status, 'approved'),
        ),
      );
  }
  const unpurged = existing.filter(
    (run) => run.artifactKey !== null && run.artifactPurgedAt === null,
  );
  return {
    affectedTrainingRunCount: existing.length,
    trainingRunIds: unpurged.map((run) => run.id),
    objectKeys: [
      ...new Set(
        unpurged
          .map((run) => run.artifactKey)
          .filter((key): key is string => key !== null),
      ),
    ],
    modelRegistryIds,
  };
}

/** 실제 storage 삭제가 성공한 run만 purge 완료로 표시한다. */
export async function markTrainingArtifactsPurged(
  db: Db,
  trainingRunIds: readonly string[],
  purgedAt: Date = new Date(),
): Promise<void> {
  if (trainingRunIds.length === 0) {
    return;
  }
  await db
    .update(trainingRuns)
    .set({ artifactPurgedAt: purgedAt, updatedAt: purgedAt })
    .where(
      and(
        inArray(trainingRuns.id, [...trainingRunIds]),
        eq(trainingRuns.status, 'revoked'),
        isNull(trainingRuns.artifactPurgedAt),
      ),
    );
}
