/**
 * 가맹점 카테고리 규칙의 label이 바뀔 때 파생 학습 자산을 revoke하는 **단일 구현**.
 *
 * ## 왜 함수로 빼는가
 *
 * 같은 연쇄(dataset snapshot → training run → evaluation → model alias → canary)가
 * 이미 두 곳에 복사돼 있었다 — `transaction.service.ts`의 규칙 upsert 경로와
 * `learning-dataset.service.ts`의 스냅샷 revoke 경로. 소급 일괄 재분류가 세 번째
 * 사본을 만들면, 다섯 테이블 중 하나를 빠뜨린 사본이 조용히 남는다. 이 저장소가
 * 반복해서 앓은 병이 정확히 그것이다(로드맵 §2 "자동 승격 경로만 계약을 구현하고
 * 나중에 붙은 사람 개입 경로가 재사용하지 않고 각자 구현했다").
 *
 * ## 왜 ruleIds를 배열로 받는가
 *
 * 규칙 하나가 바뀔 때마다 부르면 거래 건수만큼 연쇄가 돈다. 각 단계에 `ne(status,
 * 'revoked')` + `returning()` 게이트가 있어 두 번째부터는 0행으로 단락되지만,
 * 그건 **우연히 싼 것**이지 설계가 아니다. 규칙 갱신을 전부 끝낸 뒤 한 번 부르면
 * 의도가 코드에 드러난다.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';

import type { Db } from './client.js';
import {
  datasetSnapshotItems,
  datasetSnapshots,
  evaluationRuns,
  modelAliases,
  modelCanaryRuns,
} from './schema.js';
import { revokeTrainingRuns, type RevokedTrainingArtifacts } from './training-run.js';

type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface MerchantRuleRevocation {
  /** revoke된 Gold snapshot. 비어 있으면 아래 단계는 돌지 않았다. */
  snapshotIds: string[];
  evaluationRunIds: string[];
  suspendedAliasIds: string[];
  supersededCanaryCount: number;
  training: RevokedTrainingArtifacts;
}

const EMPTY: MerchantRuleRevocation = {
  snapshotIds: [],
  evaluationRunIds: [],
  suspendedAliasIds: [],
  supersededCanaryCount: 0,
  training: {
    affectedTrainingRunCount: 0,
    trainingRunIds: [],
    objectKeys: [],
    modelRegistryIds: [],
  },
};

/**
 * 주어진 규칙들이 포함된 Gold snapshot과 그 파생 학습 자산을 revoke한다.
 *
 * 과거 artifact 자체는 immutable하게 보존하고 **평가 근거로서만** 무효화한다 —
 * 라벨이 바뀌었다는 사실이 과거에 그 라벨로 학습한 기록을 지우지는 않는다.
 *
 * 반환값의 `training.objectKeys`는 호출자가 저장소에서 지울 대상이다. 이 함수는
 * DB만 만지고 object storage는 건드리지 않는다 — 트랜잭션 안에서 외부 I/O를 하면
 * 롤백이 저장소 삭제를 되돌리지 못한다.
 */
export async function revokeMerchantRuleLineage(
  tx: DbTransaction,
  ruleIds: readonly string[],
  reason: string,
  now: Date,
): Promise<MerchantRuleRevocation> {
  if (ruleIds.length === 0) return EMPTY;

  const snapshotRows = await tx
    .select({ id: datasetSnapshotItems.datasetSnapshotId })
    .from(datasetSnapshotItems)
    .where(inArray(datasetSnapshotItems.merchantCategoryRuleId, [...ruleIds]));
  const candidateIds = [...new Set(snapshotRows.map((row) => row.id))];
  if (candidateIds.length === 0) return EMPTY;

  const revokedSnapshots = await tx
    .update(datasetSnapshots)
    .set({ status: 'revoked', revokedAt: now, revocationReason: reason, updatedAt: now })
    .where(and(inArray(datasetSnapshots.id, candidateIds), ne(datasetSnapshots.status, 'revoked')))
    .returning({ id: datasetSnapshots.id });
  if (revokedSnapshots.length === 0) return EMPTY;
  const snapshotIds = revokedSnapshots.map((snapshot) => snapshot.id);

  const training = await revokeTrainingRuns(tx, snapshotIds, reason, now);

  const revokedEvaluations = await tx
    .update(evaluationRuns)
    .set({ status: 'revoked', revokedAt: now, revocationReason: reason })
    .where(
      and(
        inArray(evaluationRuns.datasetSnapshotId, snapshotIds),
        ne(evaluationRuns.status, 'revoked'),
      ),
    )
    .returning({ id: evaluationRuns.id });
  if (revokedEvaluations.length === 0) {
    return { snapshotIds, evaluationRunIds: [], suspendedAliasIds: [], supersededCanaryCount: 0, training };
  }
  const evaluationRunIds = revokedEvaluations.map((evaluation) => evaluation.id);

  const suspendedAliases = await tx
    .update(modelAliases)
    .set({ suspendedAt: now, suspensionReason: 'evaluation_revoked', updatedAt: now })
    .where(inArray(modelAliases.evaluationRunId, evaluationRunIds))
    .returning({ id: modelAliases.id });
  if (suspendedAliases.length === 0) {
    return { snapshotIds, evaluationRunIds, suspendedAliasIds: [], supersededCanaryCount: 0, training };
  }
  const suspendedAliasIds = suspendedAliases.map((alias) => alias.id);

  const superseded = await tx
    .update(modelCanaryRuns)
    .set({
      status: 'superseded',
      decisionReason: 'evaluation_revoked',
      lastEvaluatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(modelCanaryRuns.modelAliasId, suspendedAliasIds),
        eq(modelCanaryRuns.status, 'monitoring'),
      ),
    )
    .returning({ id: modelCanaryRuns.id });

  return {
    snapshotIds,
    evaluationRunIds,
    suspendedAliasIds,
    supersededCanaryCount: superseded.length,
    training,
  };
}
