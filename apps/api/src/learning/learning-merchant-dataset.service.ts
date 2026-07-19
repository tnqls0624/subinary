/** 사람 확정 가맹점 규칙으로 household-only Gold dataset을 생성한다. */
import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type {
  DatasetSnapshotSummary,
  MerchantCategoryDatasetCreateRequest,
} from '@family/contracts';
import { schema, trackPipelineExecution, type Db } from '@family/database';
import {
  buildMerchantCategoryDatasetArtifact,
  canonicalJson,
  sha256Hex,
  type DatasetSplitName,
  type MerchantCategoryDatasetInput,
} from '@family/rag';
import { createMerchantCategoryTargetId } from '@family/shared';

import { DB } from '../database/database.constants';
import { ObjectStorageService } from '../storage/object-storage.service';
import {
  createDatasetSnapshotVersion,
  createLearningDatasetSplitPolicy,
  toStoredSplitPolicy,
} from './learning-dataset-split';

const MERCHANT_DATASET_TASK = 'merchant-category' as const;
const MERCHANT_DATASET_SCHEMA_VERSION = 'merchant-category-dataset-v2';
const MERCHANT_FEATURE_SCHEMA_VERSION = 'merchant-normalized-v1';
const PRIVILEGED_HOUSEHOLD_ROLES = ['owner', 'admin'] as const;

interface DatasetBuildResult {
  summary: DatasetSnapshotSummary;
  reused: boolean;
}

function emptySplitCounts(): Record<DatasetSplitName, number> {
  return { train: 0, validation: 0, test: 0 };
}

function labelCategoryId(label: Record<string, unknown>): string | null {
  return typeof label.categoryId === 'string' ? label.categoryId : null;
}

@Injectable()
export class LearningMerchantDatasetService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  /** 확정 가맹점 규칙과 최신 human feedback으로 immutable snapshot을 만든다. */
  async createSnapshot(
    userId: string,
    input: MerchantCategoryDatasetCreateRequest,
  ): Promise<DatasetSnapshotSummary> {
    await this.assertHouseholdOperator(userId, input.householdId);
    const result = await trackPipelineExecution<DatasetBuildResult>(
      this.db,
      {
        pipelineName: 'dataset-snapshot-build',
        pipelineVersion: MERCHANT_DATASET_SCHEMA_VERSION,
        stepName: 'resolve-build-publish',
        stepVersion: MERCHANT_DATASET_SCHEMA_VERSION,
        trigger: 'api',
        scopeType: 'household',
        scopeId: input.householdId,
        externalRunId: randomUUID(),
        summarize: (buildResult) => ({
          inputCount: buildResult.summary.rowCount,
          outputCount: buildResult.summary.rowCount,
          rejectedCount: 0,
          metrics: {
            datasetReused: buildResult.reused,
            rowCount: buildResult.summary.rowCount,
          },
        }),
      },
      ({ pipelineRunId }) =>
        this.createSnapshotTracked(userId, input, pipelineRunId),
    );
    return result.summary;
  }

  /** household 가맹점 dataset snapshot을 최신순으로 조회한다. */
  async listSnapshots(
    userId: string,
    householdId: string,
  ): Promise<DatasetSnapshotSummary[]> {
    await this.assertHouseholdOperator(userId, householdId);
    const snapshots = await this.db
      .select()
      .from(schema.datasetSnapshots)
      .where(
        and(
          eq(schema.datasetSnapshots.householdId, householdId),
          eq(schema.datasetSnapshots.task, MERCHANT_DATASET_TASK),
        ),
      )
      .orderBy(desc(schema.datasetSnapshots.createdAt));
    if (snapshots.length === 0) {
      return [];
    }
    const itemRows = await this.db
      .select({
        datasetSnapshotId: schema.datasetSnapshotItems.datasetSnapshotId,
        split: schema.datasetSnapshotItems.split,
      })
      .from(schema.datasetSnapshotItems)
      .where(
        inArray(
          schema.datasetSnapshotItems.datasetSnapshotId,
          snapshots.map((snapshot) => snapshot.id),
        ),
      );
    const countsBySnapshot = new Map<
      string,
      Record<DatasetSplitName, number>
    >();
    for (const item of itemRows) {
      const counts = countsBySnapshot.get(item.datasetSnapshotId) ??
        emptySplitCounts();
      counts[item.split] += 1;
      countsBySnapshot.set(item.datasetSnapshotId, counts);
    }
    return snapshots.map((snapshot) =>
      this.toSummary(
        snapshot,
        countsBySnapshot.get(snapshot.id) ?? emptySplitCounts(),
      ),
    );
  }

  private async createSnapshotTracked(
    userId: string,
    input: MerchantCategoryDatasetCreateRequest,
    pipelineRunId: string,
  ): Promise<DatasetBuildResult> {
    const feedbackRows = await this.db
      .select({
        id: schema.feedbackEvents.id,
        targetId: schema.feedbackEvents.targetId,
        labelSchemaVersion: schema.feedbackEvents.labelSchemaVersion,
        label: schema.feedbackEvents.label,
        source: schema.feedbackEvents.source,
        occurredAt: schema.feedbackEvents.occurredAt,
      })
      .from(schema.feedbackEvents)
      .where(
        and(
          eq(schema.feedbackEvents.householdId, input.householdId),
          eq(schema.feedbackEvents.targetType, MERCHANT_DATASET_TASK),
          eq(schema.feedbackEvents.source, 'human_confirmed'),
        ),
      )
      .orderBy(
        desc(schema.feedbackEvents.occurredAt),
        desc(schema.feedbackEvents.id),
      );
    const latestByTarget = new Map<string, (typeof feedbackRows)[number]>();
    for (const feedback of feedbackRows) {
      if (!latestByTarget.has(feedback.targetId)) {
        latestByTarget.set(feedback.targetId, feedback);
      }
    }
    if (latestByTarget.size === 0) {
      throw new BadRequestException(
        'merchant dataset requires at least one human-confirmed rule',
      );
    }

    const ruleRows = await this.db
      .select({
        id: schema.merchantCategoryRules.id,
        merchantPattern: schema.merchantCategoryRules.merchantPattern,
        categoryId: schema.merchantCategoryRules.categoryId,
        categorySlug: schema.expenseCategories.slug,
      })
      .from(schema.merchantCategoryRules)
      .innerJoin(
        schema.expenseCategories,
        eq(
          schema.merchantCategoryRules.categoryId,
          schema.expenseCategories.id,
        ),
      )
      .where(
        and(
          eq(schema.merchantCategoryRules.householdId, input.householdId),
          eq(schema.merchantCategoryRules.source, 'human_confirmed'),
          isNotNull(schema.merchantCategoryRules.confirmedAt),
        ),
      );
    const ruleByTarget = new Map(
      ruleRows.map((rule) => [
        createMerchantCategoryTargetId(
          input.householdId,
          rule.merchantPattern,
        ),
        rule,
      ]),
    );
    const datasetInputs: MerchantCategoryDatasetInput[] = [];
    for (const feedback of latestByTarget.values()) {
      const rule = ruleByTarget.get(feedback.targetId);
      const feedbackCategoryId = labelCategoryId(feedback.label);
      if (!rule || feedbackCategoryId !== rule.categoryId) {
        throw new BadRequestException(
          'merchant dataset lineage is incomplete or stale',
        );
      }
      datasetInputs.push({
        feedbackEventId: feedback.id,
        targetId: feedback.targetId,
        merchantCategoryRuleId: rule.id,
        merchantPattern: rule.merchantPattern,
        categoryId: rule.categoryId,
        categorySlug: rule.categorySlug,
        occurredAt: feedback.occurredAt,
        labelSchemaVersion: feedback.labelSchemaVersion,
        source: 'human_confirmed',
      });
    }

    const splitPolicy = createLearningDatasetSplitPolicy(
      input,
      MERCHANT_DATASET_SCHEMA_VERSION,
    );
    const artifact = buildMerchantCategoryDatasetArtifact(
      datasetInputs,
      splitPolicy,
    );
    const version = createDatasetSnapshotVersion(
      MERCHANT_DATASET_SCHEMA_VERSION,
      artifact.artifactHash,
      artifact.splitPolicy,
    );
    const baseKey = `gold/${MERCHANT_DATASET_TASK}/${input.householdId}/${version}`;
    const artifactKey = `${baseKey}/examples.jsonl`;
    const manifestKey = `${baseKey}/manifest.json`;
    const manifest = {
      task: MERCHANT_DATASET_TASK,
      version,
      schemaVersion: MERCHANT_DATASET_SCHEMA_VERSION,
      featureSchemaVersion: MERCHANT_FEATURE_SCHEMA_VERSION,
      scope: { type: 'household', id: input.householdId },
      artifact: {
        key: artifactKey,
        format: 'jsonl',
        sha256: artifact.artifactHash,
      },
      rowCount: artifact.rows.length,
      splitPolicy: artifact.splitPolicy,
      splitCounts: artifact.splitCounts,
      leakageAudit: artifact.leakageAudit,
      labelSources: ['human_confirmed'],
      inputNodeType: 'merchant_category_rule',
      consentScope: { mode: 'household-only', crossHousehold: false },
    };
    const manifestJson = `${canonicalJson(manifest)}\n`;
    const manifestHash = sha256Hex(manifestJson);

    const [existing] = await this.db
      .select()
      .from(schema.datasetSnapshots)
      .where(
        and(
          eq(schema.datasetSnapshots.householdId, input.householdId),
          eq(schema.datasetSnapshots.task, MERCHANT_DATASET_TASK),
          eq(schema.datasetSnapshots.version, version),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        summary: this.toSummary(existing, artifact.splitCounts),
        reused: true,
      };
    }

    try {
      await this.storage.putObject(
        artifactKey,
        artifact.jsonl,
        'application/x-ndjson; charset=utf-8',
      );
      await this.storage.putObject(
        manifestKey,
        manifestJson,
        'application/json; charset=utf-8',
      );
    } catch {
      throw new ServiceUnavailableException(
        'dataset artifact storage is unavailable',
      );
    }

    const created = await this.db.transaction(async (tx) => {
      const [snapshot] = await tx
        .insert(schema.datasetSnapshots)
        .values({
          householdId: input.householdId,
          task: MERCHANT_DATASET_TASK,
          version,
          schemaVersion: MERCHANT_DATASET_SCHEMA_VERSION,
          artifactKey,
          artifactHash: artifact.artifactHash,
          manifestKey,
          manifestHash,
          splitPolicy: toStoredSplitPolicy(
            artifact.splitPolicy,
            artifact.leakageAudit,
          ),
          consentScope: { mode: 'household-only', crossHousehold: false },
          rowCount: artifact.rows.length,
          status: 'validated',
          pipelineRunId,
          createdBy: userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!snapshot) {
        return null;
      }
      await tx.insert(schema.datasetSnapshotItems).values(
        artifact.rows.map((row) => ({
          datasetSnapshotId: snapshot.id,
          feedbackEventId: row.feedbackEventId,
          merchantCategoryRuleId: row.merchantCategoryRuleId,
          targetType: row.targetType,
          targetId: row.targetId,
          split: row.split,
          splitGroupHash: row.splitGroupHash,
          occurredAt: new Date(row.occurredAt),
        })),
      );
      await tx
        .insert(schema.lineageEdges)
        .values([
          ...artifact.rows.map((row) => ({
            fromNodeType: 'merchant_category_rule',
            fromNodeId: row.merchantCategoryRuleId,
            toNodeType: 'dataset_snapshot',
            toNodeId: snapshot.id,
            transformVersion: MERCHANT_DATASET_SCHEMA_VERSION,
            pipelineRunId,
          })),
          ...artifact.rows.map((row) => ({
            fromNodeType: 'feedback_event',
            fromNodeId: row.feedbackEventId,
            toNodeType: 'dataset_snapshot',
            toNodeId: snapshot.id,
            transformVersion: MERCHANT_DATASET_SCHEMA_VERSION,
            pipelineRunId,
          })),
        ])
        .onConflictDoNothing();
      return snapshot;
    });
    if (created) {
      return {
        summary: this.toSummary(created, artifact.splitCounts),
        reused: false,
      };
    }
    const [concurrent] = await this.db
      .select()
      .from(schema.datasetSnapshots)
      .where(
        and(
          eq(schema.datasetSnapshots.householdId, input.householdId),
          eq(schema.datasetSnapshots.task, MERCHANT_DATASET_TASK),
          eq(schema.datasetSnapshots.version, version),
        ),
      )
      .limit(1);
    if (!concurrent) {
      throw new Error('merchant dataset conflict resolved without a stored row');
    }
    return {
      summary: this.toSummary(concurrent, artifact.splitCounts),
      reused: true,
    };
  }

  private async assertHouseholdOperator(
    userId: string,
    householdId: string,
  ): Promise<void> {
    const [household] = await this.db
      .select({ id: schema.households.id })
      .from(schema.households)
      .where(eq(schema.households.id, householdId))
      .limit(1);
    if (!household) {
      throw new NotFoundException('household not found');
    }
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

  private toSummary(
    snapshot: schema.DatasetSnapshot,
    splitCounts: Record<DatasetSplitName, number>,
  ): DatasetSnapshotSummary {
    if (snapshot.task !== MERCHANT_DATASET_TASK) {
      throw new Error('unsupported dataset task stored in merchant dataset service');
    }
    return {
      id: snapshot.id,
      task: MERCHANT_DATASET_TASK,
      version: snapshot.version,
      schemaVersion: snapshot.schemaVersion,
      status: snapshot.status,
      rowCount: snapshot.rowCount,
      artifactHash: snapshot.artifactHash,
      manifestHash: snapshot.manifestHash,
      splitCounts,
      createdAt: snapshot.createdAt.toISOString(),
    };
  }
}
