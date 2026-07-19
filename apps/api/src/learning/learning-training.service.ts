/** 승인 dataset의 별도 Training Runner 실행 요청과 조회 제어 평면. */
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type {
  TrainingEnvironmentSummary,
  TrainingMetricsSummary,
  TrainingRunCreateRequest,
  TrainingRunListQuery,
  TrainingRunSummary,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import {
  MERCHANT_CLASSIFIER_TRAINER_VERSION,
  MERCHANT_TRAINING_READINESS,
} from '@family/shared';

import { DB } from '../database/database.constants';

const MERCHANT_CATEGORY_TASK = 'merchant-category';
const PRIVILEGED_HOUSEHOLD_ROLES = ['owner', 'admin'] as const;

function storedString(
  value: Record<string, unknown>,
  key: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`training metadata ${key} is invalid`);
  }
  return candidate;
}

function toEnvironmentSummary(
  value: Record<string, unknown> | null,
): TrainingEnvironmentSummary | null {
  if (value === null) {
    return null;
  }
  return {
    codeHash: storedString(value, 'codeHash'),
    dependencyLockHash: storedString(value, 'dependencyLockHash'),
    nodeVersion: storedString(value, 'nodeVersion'),
    platform: storedString(value, 'platform'),
    architecture: storedString(value, 'architecture'),
  };
}

function storedMetric(
  value: Record<string, unknown>,
  key: 'training' | 'validation' | 'test',
): TrainingMetricsSummary[typeof key] {
  const metric = value[key];
  if (metric === null || typeof metric !== 'object') {
    throw new Error(`training metric ${key} is invalid`);
  }
  const row = metric as Record<string, unknown>;
  const rowCount = row.rowCount;
  const correctCount = row.correctCount;
  const accuracy = row.accuracy;
  const macroF1 = row.macroF1;
  if (
    typeof rowCount !== 'number' ||
    !Number.isInteger(rowCount) ||
    rowCount < 0 ||
    typeof correctCount !== 'number' ||
    !Number.isInteger(correctCount) ||
    correctCount < 0 ||
    typeof accuracy !== 'number' ||
    !Number.isFinite(accuracy) ||
    typeof macroF1 !== 'number' ||
    !Number.isFinite(macroF1)
  ) {
    throw new Error(`training metric ${key} is invalid`);
  }
  return { rowCount, correctCount, accuracy, macroF1 };
}

function toMetricsSummary(
  value: Record<string, unknown> | null,
): TrainingMetricsSummary | null {
  if (value === null) {
    return null;
  }
  return {
    training: storedMetric(value, 'training'),
    validation: storedMetric(value, 'validation'),
    test: storedMetric(value, 'test'),
  };
}

@Injectable()
export class LearningTrainingService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 준비도와 승인 상태를 재검증하고 멱등 학습 요청을 생성한다. */
  async requestRun(
    userId: string,
    input: TrainingRunCreateRequest,
  ): Promise<TrainingRunSummary> {
    const [dataset] = await this.db
      .select()
      .from(schema.datasetSnapshots)
      .where(eq(schema.datasetSnapshots.id, input.datasetSnapshotId))
      .limit(1);
    if (!dataset || dataset.householdId === null) {
      throw new NotFoundException('household dataset snapshot not found');
    }
    await this.assertHouseholdOperator(userId, dataset.householdId);
    await this.assertDatasetReady(dataset);

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`training-request:${dataset.id}:${MERCHANT_CLASSIFIER_TRAINER_VERSION}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(schema.trainingRuns)
        .where(
          and(
            eq(schema.trainingRuns.datasetSnapshotId, dataset.id),
            eq(
              schema.trainingRuns.trainerVersion,
              MERCHANT_CLASSIFIER_TRAINER_VERSION,
            ),
            inArray(schema.trainingRuns.status, [
              'queued',
              'running',
              'succeeded',
            ]),
          ),
        )
        .orderBy(desc(schema.trainingRuns.createdAt))
        .limit(1);
      if (existing) {
        return this.toSummary(existing);
      }
      const [created] = await tx
        .insert(schema.trainingRuns)
        .values({
          datasetSnapshotId: dataset.id,
          task: MERCHANT_CATEGORY_TASK,
          trainerVersion: MERCHANT_CLASSIFIER_TRAINER_VERSION,
          requestedBy: userId,
        })
        .returning();
      if (!created) {
        throw new Error('training run insert returned no row');
      }
      return this.toSummary(created);
    });
  }

  /** household 운영자가 학습 이력을 최신순으로 조회한다. */
  async listRuns(
    userId: string,
    query: TrainingRunListQuery,
  ): Promise<TrainingRunSummary[]> {
    await this.assertHouseholdOperator(userId, query.householdId);
    const rows = await this.db
      .select({ run: schema.trainingRuns })
      .from(schema.trainingRuns)
      .innerJoin(
        schema.datasetSnapshots,
        eq(
          schema.trainingRuns.datasetSnapshotId,
          schema.datasetSnapshots.id,
        ),
      )
      .where(eq(schema.datasetSnapshots.householdId, query.householdId))
      .orderBy(desc(schema.trainingRuns.createdAt))
      .limit(query.limit);
    return rows.map(({ run }) => this.toSummary(run));
  }

  private async assertDatasetReady(
    dataset: schema.DatasetSnapshot,
  ): Promise<void> {
    const blockers: string[] = [];
    if (dataset.task !== MERCHANT_CATEGORY_TASK) {
      blockers.push('unsupported_task');
    }
    if (dataset.status !== 'approved') {
      blockers.push('dataset_not_approved');
    }
    if (dataset.rowCount < MERCHANT_TRAINING_READINESS.minimumLabels) {
      blockers.push('insufficient_labels');
    }
    if (
      dataset.splitPolicy.strategy !== 'group_time' ||
      !(
        dataset.splitPolicy.leakageAudit !== null &&
        typeof dataset.splitPolicy.leakageAudit === 'object' &&
        (dataset.splitPolicy.leakageAudit as Record<string, unknown>).status ===
          'passed'
      )
    ) {
      blockers.push('group_time_leakage_audit_required');
    }

    const rows = await this.db
      .select({
        split: schema.datasetSnapshotItems.split,
        categoryId: schema.merchantCategoryRules.categoryId,
        source: schema.merchantCategoryRules.source,
        confirmedAt: schema.merchantCategoryRules.confirmedAt,
      })
      .from(schema.datasetSnapshotItems)
      .innerJoin(
        schema.merchantCategoryRules,
        eq(
          schema.datasetSnapshotItems.merchantCategoryRuleId,
          schema.merchantCategoryRules.id,
        ),
      )
      .where(
        eq(schema.datasetSnapshotItems.datasetSnapshotId, dataset.id),
      );
    if (rows.length !== dataset.rowCount) {
      blockers.push('incomplete_lineage');
    }
    if (
      rows.some(
        (row) => row.source !== 'human_confirmed' || row.confirmedAt === null,
      )
    ) {
      blockers.push('non_human_label');
    }
    const countsByClass = new Map<string, number>();
    const trainClasses = new Set<string>();
    const splitCounts = { train: 0, validation: 0, test: 0 };
    for (const row of rows) {
      countsByClass.set(
        row.categoryId,
        (countsByClass.get(row.categoryId) ?? 0) + 1,
      );
      splitCounts[row.split] += 1;
      if (row.split === 'train') {
        trainClasses.add(row.categoryId);
      }
    }
    if (countsByClass.size < MERCHANT_TRAINING_READINESS.minimumClasses) {
      blockers.push('insufficient_classes');
    }
    if (
      [...countsByClass.values()].some(
        (count) =>
          count < MERCHANT_TRAINING_READINESS.minimumLabelsPerClass,
      )
    ) {
      blockers.push('insufficient_labels_per_class');
    }
    if (trainClasses.size !== countsByClass.size) {
      blockers.push('training_split_missing_class');
    }
    if (
      splitCounts.train === 0 ||
      splitCounts.validation === 0 ||
      splitCounts.test === 0
    ) {
      blockers.push('empty_dataset_split');
    }
    if (blockers.length > 0) {
      throw new ConflictException(
        `training gate blocked: ${[...new Set(blockers)].join(',')}`,
      );
    }
  }

  private async assertHouseholdOperator(
    userId: string,
    householdId: string,
  ): Promise<void> {
    const [membership] = await this.db
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
          inArray(
            schema.householdMembers.role,
            PRIVILEGED_HOUSEHOLD_ROLES,
          ),
        ),
      )
      .limit(1);
    if (!membership) {
      throw new ForbiddenException('household owner or admin required');
    }
  }

  private toSummary(run: schema.TrainingRun): TrainingRunSummary {
    return {
      id: run.id,
      datasetSnapshotId: run.datasetSnapshotId,
      modelRegistryId: run.modelRegistryId,
      task: run.task,
      trainerVersion: run.trainerVersion,
      status: run.status,
      artifactHash: run.artifactHash,
      environment: toEnvironmentSummary(run.environment),
      metrics: toMetricsSummary(run.metrics),
      errorCode: run.errorCode,
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
    };
  }
}
