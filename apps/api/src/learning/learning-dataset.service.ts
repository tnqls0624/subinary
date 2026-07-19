/**
 * 승인된 피드백과 immutable chunk revision으로 workspace 내부 학습/평가용
 * dataset snapshot을 생성한다. memory-candidate 태스크는 원문을 artifact에
 * 복사하지 않고 revision 계보와 split 감사 metadata만 고정한다.
 */
import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';

import type {
  DatasetSnapshotApprovalResponse,
  DatasetSnapshotRevokeRequest,
  DatasetSnapshotRevokeResponse,
  DatasetSnapshotSummary,
  MemoryCandidateDatasetCreateRequest,
} from '@family/contracts';
import {
  markTrainingArtifactsPurged,
  revokeTrainingRuns,
  schema,
  trackPipelineExecution,
  type Db,
} from '@family/database';
import {
  buildMemoryCandidateDatasetArtifact,
  canonicalJson,
  parseResolvedDatasetSplitPolicy,
  sha256Hex,
  validateDatasetLeakage,
  type DatasetLeakageAudit,
  type DatasetSplitAssignment,
  type DatasetSplitName,
  type MemoryCandidateDatasetInput,
  type ResolvedDatasetSplitPolicy,
} from '@family/rag';

import { DB } from '../database/database.constants';
import { ObjectStorageService } from '../storage/object-storage.service';
import {
  createDatasetSnapshotVersion,
  createLearningDatasetSplitPolicy,
  toStoredSplitPolicy,
} from './learning-dataset-split';

const MEMORY_DATASET_TASK = 'memory-candidate' as const;
const RAG_DATASET_TASK = 'rag-embedding' as const;
const MEMORY_DATASET_SCHEMA_VERSION = 'memory-candidate-dataset-v2';
const ELIGIBLE_FEEDBACK_SOURCES = [
  'human_confirmed',
  'human_rejected',
  'imported_gold',
] as const;
const PRIVILEGED_HOUSEHOLD_ROLES = ['owner', 'admin'] as const;

type EligibleFeedbackSource = (typeof ELIGIBLE_FEEDBACK_SOURCES)[number];

interface DatasetBuildResult {
  summary: DatasetSnapshotSummary;
  reused: boolean;
}

function isEligibleFeedbackSource(value: string): value is EligibleFeedbackSource {
  return (ELIGIBLE_FEEDBACK_SOURCES as readonly string[]).includes(value);
}

function emptySplitCounts(): Record<DatasetSplitName, number> {
  return { train: 0, validation: 0, test: 0 };
}

@Injectable()
export class LearningDatasetService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  /** 소유 workspace에 대한 immutable memory-candidate snapshot을 생성한다. */
  async createMemoryCandidateSnapshot(
    userId: string,
    input: MemoryCandidateDatasetCreateRequest,
  ): Promise<DatasetSnapshotSummary> {
    await this.assertOwnedWorkspace(userId, input.workspaceId);
    const result = await trackPipelineExecution<DatasetBuildResult>(
      this.db,
      {
        pipelineName: 'dataset-snapshot-build',
        pipelineVersion: MEMORY_DATASET_SCHEMA_VERSION,
        stepName: 'resolve-build-publish',
        stepVersion: MEMORY_DATASET_SCHEMA_VERSION,
        trigger: 'api',
        scopeType: 'workspace',
        scopeId: input.workspaceId,
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
        this.createMemoryCandidateSnapshotTracked(
          userId,
          input,
          pipelineRunId,
        ),
    );
    return result.summary;
  }

  /** 소유 workspace의 snapshot 메타데이터를 최신순으로 조회한다. */
  async listSnapshots(
    userId: string,
    workspaceId: string,
  ): Promise<DatasetSnapshotSummary[]> {
    await this.assertOwnedWorkspace(userId, workspaceId);
    const snapshots = await this.db
      .select()
      .from(schema.datasetSnapshots)
      .where(
        and(
          eq(schema.datasetSnapshots.workspaceId, workspaceId),
          inArray(schema.datasetSnapshots.task, [
            MEMORY_DATASET_TASK,
            RAG_DATASET_TASK,
          ]),
        ),
      )
      .orderBy(desc(schema.datasetSnapshots.createdAt));
    if (snapshots.length === 0) {
      return [];
    }
    const snapshotIds = snapshots.map((snapshot) => snapshot.id);
    const itemRows = await this.db
      .select({
        datasetSnapshotId: schema.datasetSnapshotItems.datasetSnapshotId,
        split: schema.datasetSnapshotItems.split,
      })
      .from(schema.datasetSnapshotItems)
      .where(
        inArray(schema.datasetSnapshotItems.datasetSnapshotId, snapshotIds),
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

  /** validated snapshot만 승인한다. 승인 후 artifact와 manifest는 계속 immutable이다. */
  async approveSnapshot(
    userId: string,
    datasetSnapshotId: string,
  ): Promise<DatasetSnapshotApprovalResponse> {
    const [snapshot] = await this.db
      .select({
        id: schema.datasetSnapshots.id,
        workspaceId: schema.datasetSnapshots.workspaceId,
        householdId: schema.datasetSnapshots.householdId,
        status: schema.datasetSnapshots.status,
        approvedAt: schema.datasetSnapshots.approvedAt,
        rowCount: schema.datasetSnapshots.rowCount,
        splitPolicy: schema.datasetSnapshots.splitPolicy,
      })
      .from(schema.datasetSnapshots)
      .where(eq(schema.datasetSnapshots.id, datasetSnapshotId))
      .limit(1);
    if (!snapshot) {
      throw new NotFoundException('dataset snapshot not found');
    }
    if (snapshot.workspaceId !== null) {
      await this.assertOwnedWorkspace(userId, snapshot.workspaceId);
    } else if (snapshot.householdId !== null) {
      await this.assertHouseholdOperator(userId, snapshot.householdId);
    } else {
      throw new BadRequestException('dataset snapshot scope is missing');
    }
    if (snapshot.status === 'approved' && snapshot.approvedAt !== null) {
      return {
        id: snapshot.id,
        status: 'approved',
        approvedAt: snapshot.approvedAt.toISOString(),
      };
    }
    if (snapshot.status !== 'validated') {
      throw new BadRequestException(
        `dataset snapshot in ${snapshot.status} status cannot be approved`,
      );
    }
    await this.assertSnapshotLeakageAudit(
      snapshot.id,
      snapshot.rowCount,
      snapshot.splitPolicy,
    );

    const approvedAt = new Date();
    const [updated] = await this.db
      .update(schema.datasetSnapshots)
      .set({ status: 'approved', approvedAt, updatedAt: approvedAt })
      .where(
        and(
          eq(schema.datasetSnapshots.id, datasetSnapshotId),
          eq(schema.datasetSnapshots.status, 'validated'),
        ),
      )
      .returning({
        id: schema.datasetSnapshots.id,
        approvedAt: schema.datasetSnapshots.approvedAt,
      });
    if (!updated?.approvedAt) {
      const [concurrent] = await this.db
        .select({
          status: schema.datasetSnapshots.status,
          approvedAt: schema.datasetSnapshots.approvedAt,
        })
        .from(schema.datasetSnapshots)
        .where(eq(schema.datasetSnapshots.id, datasetSnapshotId))
        .limit(1);
      if (concurrent?.status === 'approved' && concurrent.approvedAt !== null) {
        return {
          id: datasetSnapshotId,
          status: 'approved',
          approvedAt: concurrent.approvedAt.toISOString(),
        };
      }
      throw new BadRequestException('dataset snapshot approval state changed');
    }
    return {
      id: updated.id,
      status: 'approved',
      approvedAt: updated.approvedAt.toISOString(),
    };
  }

  /** 개인정보 철회 dataset과 모든 평가·학습 artifact를 멱등 폐기한다. */
  async revokeSnapshot(
    userId: string,
    datasetSnapshotId: string,
    reason: DatasetSnapshotRevokeRequest['reason'],
  ): Promise<DatasetSnapshotRevokeResponse> {
    const [snapshot] = await this.db
      .select()
      .from(schema.datasetSnapshots)
      .where(eq(schema.datasetSnapshots.id, datasetSnapshotId))
      .limit(1);
    if (!snapshot) {
      throw new NotFoundException('dataset snapshot not found');
    }
    if (snapshot.workspaceId !== null) {
      await this.assertOwnedWorkspace(userId, snapshot.workspaceId);
    } else if (snapshot.householdId !== null) {
      await this.assertHouseholdOperator(userId, snapshot.householdId);
    } else {
      throw new BadRequestException('dataset snapshot scope is missing');
    }

    const revokedAt = snapshot.revokedAt ?? new Date();
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`dataset-revoke:${datasetSnapshotId}`}))`,
      );
      await tx
        .update(schema.datasetSnapshots)
        .set({
          status: 'revoked',
          revokedAt,
          revocationReason: reason,
          updatedAt: revokedAt,
        })
        .where(
          and(
            eq(schema.datasetSnapshots.id, datasetSnapshotId),
            ne(schema.datasetSnapshots.status, 'revoked'),
          ),
        );
      const evaluations = await tx
        .select({ id: schema.evaluationRuns.id })
        .from(schema.evaluationRuns)
        .where(
          eq(schema.evaluationRuns.datasetSnapshotId, datasetSnapshotId),
        );
      if (evaluations.length > 0) {
        const evaluationIds = evaluations.map((evaluation) => evaluation.id);
        await tx
          .update(schema.evaluationRuns)
          .set({
            status: 'revoked',
            revokedAt,
            revocationReason: reason,
          })
          .where(
            and(
              inArray(schema.evaluationRuns.id, evaluationIds),
              ne(schema.evaluationRuns.status, 'revoked'),
            ),
          );
        const aliases = await tx
          .update(schema.modelAliases)
          .set({
            suspendedAt: revokedAt,
            suspensionReason: 'evaluation_revoked',
            updatedAt: revokedAt,
          })
          .where(inArray(schema.modelAliases.evaluationRunId, evaluationIds))
          .returning({ id: schema.modelAliases.id });
        if (aliases.length > 0) {
          await tx
            .update(schema.modelCanaryRuns)
            .set({
              status: 'superseded',
              decisionReason: 'evaluation_revoked',
              lastEvaluatedAt: revokedAt,
              updatedAt: revokedAt,
            })
            .where(
              and(
                inArray(
                  schema.modelCanaryRuns.modelAliasId,
                  aliases.map((alias) => alias.id),
                ),
                eq(schema.modelCanaryRuns.status, 'monitoring'),
              ),
            );
        }
      }
      const trainingArtifacts = await revokeTrainingRuns(
        tx,
        [datasetSnapshotId],
        reason,
        revokedAt,
      );
      return trainingArtifacts;
    });

    const objectKeys = [
      ...new Set([
        snapshot.artifactKey,
        snapshot.manifestKey,
        ...result.objectKeys,
      ]),
    ];
    try {
      for (const objectKey of objectKeys) {
        await this.storage.deleteObject(objectKey);
      }
      await markTrainingArtifactsPurged(
        this.db,
        result.trainingRunIds,
        revokedAt,
      );
    } catch {
      throw new ServiceUnavailableException(
        'dataset revoked but artifact purge is incomplete; retry the request',
      );
    }
    return {
      id: datasetSnapshotId,
      status: 'revoked',
      revokedAt: revokedAt.toISOString(),
      purgedArtifactCount: objectKeys.length,
      revokedTrainingRunCount: result.affectedTrainingRunCount,
    };
  }

  private async createMemoryCandidateSnapshotTracked(
    userId: string,
    input: MemoryCandidateDatasetCreateRequest,
    pipelineRunId: string,
  ): Promise<DatasetBuildResult> {
    const feedbackRows = await this.db
      .select({
        feedbackEventId: schema.feedbackEvents.id,
        targetId: schema.feedbackEvents.targetId,
        labelSchemaVersion: schema.feedbackEvents.labelSchemaVersion,
        label: schema.feedbackEvents.label,
        source: schema.feedbackEvents.source,
        occurredAt: schema.feedbackEvents.occurredAt,
        chunkId: schema.memoryCandidates.sourceChunkId,
        chunkRevisionId: schema.chunkRevisions.id,
      })
      .from(schema.feedbackEvents)
      .leftJoin(
        schema.memoryCandidates,
        and(
          sql`${schema.feedbackEvents.targetId} = ${schema.memoryCandidates.id}::text`,
          eq(
            schema.memoryCandidates.workspaceId,
            schema.feedbackEvents.workspaceId,
          ),
        ),
      )
      .leftJoin(
        schema.chunkRevisions,
        and(
          eq(
            schema.chunkRevisions.id,
            schema.memoryCandidates.sourceChunkRevisionId,
          ),
          isNull(schema.chunkRevisions.deletedAt),
        ),
      )
      .where(
        and(
          eq(schema.feedbackEvents.workspaceId, input.workspaceId),
          eq(schema.feedbackEvents.targetType, MEMORY_DATASET_TASK),
          inArray(schema.feedbackEvents.source, ELIGIBLE_FEEDBACK_SOURCES),
        ),
      )
      .orderBy(
        desc(schema.feedbackEvents.occurredAt),
        desc(schema.feedbackEvents.id),
      );

    // 같은 candidate가 여러 번 검토된 경우 최신 확정만 snapshot에 포함한다.
    const latestByTarget = new Map<string, (typeof feedbackRows)[number]>();
    for (const row of feedbackRows) {
      if (!latestByTarget.has(row.targetId)) {
        latestByTarget.set(row.targetId, row);
      }
    }
    if (latestByTarget.size === 0) {
      throw new BadRequestException(
        'dataset snapshot requires at least one reviewed memory candidate',
      );
    }

    const unresolvedCount = [...latestByTarget.values()].filter(
      (row) => row.chunkId === null || row.chunkRevisionId === null,
    ).length;
    if (unresolvedCount > 0) {
      throw new BadRequestException(
        'dataset lineage is incomplete; run RAG indexing before creating a snapshot',
      );
    }

    const splitPolicy = createLearningDatasetSplitPolicy(
      input,
      MEMORY_DATASET_SCHEMA_VERSION,
    );
    const datasetInputs: MemoryCandidateDatasetInput[] = [
      ...latestByTarget.values(),
    ].map((row) => {
      if (
        row.chunkId === null ||
        row.chunkRevisionId === null ||
        !isEligibleFeedbackSource(row.source)
      ) {
        throw new Error('validated dataset row has incomplete lineage');
      }
      return {
        feedbackEventId: row.feedbackEventId,
        targetId: row.targetId,
        chunkRevisionId: row.chunkRevisionId,
        groupKey: row.chunkId,
        occurredAt: row.occurredAt,
        labelSchemaVersion: row.labelSchemaVersion,
        label: row.label,
        source: row.source,
      };
    });
    const artifact = buildMemoryCandidateDatasetArtifact(
      datasetInputs,
      splitPolicy,
    );
    const version = createDatasetSnapshotVersion(
      MEMORY_DATASET_SCHEMA_VERSION,
      artifact.artifactHash,
      artifact.splitPolicy,
    );
    const baseKey = `gold/${MEMORY_DATASET_TASK}/${input.workspaceId}/${version}`;
    const artifactKey = `${baseKey}/examples.jsonl`;
    const manifestKey = `${baseKey}/manifest.json`;
    const manifest = {
      task: MEMORY_DATASET_TASK,
      version,
      schemaVersion: MEMORY_DATASET_SCHEMA_VERSION,
      scope: { type: 'workspace', id: input.workspaceId },
      artifact: {
        key: artifactKey,
        format: 'jsonl',
        sha256: artifact.artifactHash,
      },
      rowCount: artifact.rows.length,
      splitPolicy: artifact.splitPolicy,
      splitCounts: artifact.splitCounts,
      leakageAudit: artifact.leakageAudit,
      labelSources: [...ELIGIBLE_FEEDBACK_SOURCES],
      inputNodeType: 'chunk_revision',
      consentScope: { mode: 'workspace-only' },
    };
    const manifestJson = `${canonicalJson(manifest)}\n`;
    const manifestHash = sha256Hex(manifestJson);

    const [existing] = await this.db
      .select()
      .from(schema.datasetSnapshots)
      .where(
        and(
          eq(schema.datasetSnapshots.workspaceId, input.workspaceId),
          eq(schema.datasetSnapshots.task, MEMORY_DATASET_TASK),
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
          workspaceId: input.workspaceId,
          task: MEMORY_DATASET_TASK,
          version,
          schemaVersion: MEMORY_DATASET_SCHEMA_VERSION,
          artifactKey,
          artifactHash: artifact.artifactHash,
          manifestKey,
          manifestHash,
          splitPolicy: toStoredSplitPolicy(
            artifact.splitPolicy,
            artifact.leakageAudit,
          ),
          consentScope: { mode: 'workspace-only' },
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
          chunkRevisionId: row.chunkRevisionId,
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
            fromNodeType: 'chunk_revision',
            fromNodeId: row.chunkRevisionId,
            toNodeType: 'dataset_snapshot',
            toNodeId: snapshot.id,
            transformVersion: MEMORY_DATASET_SCHEMA_VERSION,
            pipelineRunId,
          })),
          ...artifact.rows.map((row) => ({
            fromNodeType: 'feedback_event',
            fromNodeId: row.feedbackEventId,
            toNodeType: 'dataset_snapshot',
            toNodeId: snapshot.id,
            transformVersion: MEMORY_DATASET_SCHEMA_VERSION,
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
          eq(schema.datasetSnapshots.workspaceId, input.workspaceId),
          eq(schema.datasetSnapshots.task, MEMORY_DATASET_TASK),
          eq(schema.datasetSnapshots.version, version),
        ),
      )
      .limit(1);
    if (!concurrent) {
      throw new Error('dataset snapshot conflict resolved without a stored row');
    }
    return {
      summary: this.toSummary(concurrent, artifact.splitCounts),
      reused: true,
    };
  }

  /** 저장된 group hash·event time으로 승인 직전 누수를 독립 재검증한다. */
  private async assertSnapshotLeakageAudit(
    datasetSnapshotId: string,
    expectedRowCount: number,
    splitPolicyMetadata: Record<string, unknown>,
  ): Promise<void> {
    const items = await this.db
      .select({
        rowId: schema.datasetSnapshotItems.feedbackEventId,
        targetId: schema.datasetSnapshotItems.targetId,
        splitGroupHash: schema.datasetSnapshotItems.splitGroupHash,
        occurredAt: schema.datasetSnapshotItems.occurredAt,
        split: schema.datasetSnapshotItems.split,
      })
      .from(schema.datasetSnapshotItems)
      .where(
        eq(
          schema.datasetSnapshotItems.datasetSnapshotId,
          datasetSnapshotId,
        ),
      );
    if (
      items.length !== expectedRowCount ||
      items.some(
        (item) => item.splitGroupHash === null || item.occurredAt === null,
      )
    ) {
      throw new BadRequestException(
        'dataset leakage audit metadata is incomplete',
      );
    }
    let policy: ResolvedDatasetSplitPolicy;
    let audit: DatasetLeakageAudit;
    try {
      policy = parseResolvedDatasetSplitPolicy(splitPolicyMetadata);
      audit = validateDatasetLeakage(
        items.map(
          (item): DatasetSplitAssignment => ({
            rowId: item.rowId,
            targetId: item.targetId,
            splitGroupHash: item.splitGroupHash!,
            occurredAt: item.occurredAt!.toISOString(),
            split: item.split,
          }),
        ),
        policy,
      );
      if (
        canonicalJson(splitPolicyMetadata.leakageAudit) !==
        canonicalJson(audit)
      ) {
        throw new Error('stored dataset leakage audit does not match rows');
      }
    } catch {
      throw new BadRequestException('dataset leakage audit metadata is invalid');
    }
    if (audit.status !== 'passed') {
      throw new BadRequestException(
        `dataset leakage audit failed: group=${audit.groupOverlapCount}, ` +
          `target=${audit.targetOverlapCount}, temporal=${audit.temporalViolationCount}`,
      );
    }
  }

  private async assertOwnedWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    const [workspace] = await this.db
      .select({ ownerUserId: schema.workspaces.ownerUserId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) {
      throw new NotFoundException('workspace not found');
    }
    if (workspace.ownerUserId !== userId) {
      throw new ForbiddenException('not the workspace owner');
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

  private toSummary(
    snapshot: schema.DatasetSnapshot,
    splitCounts: Record<DatasetSplitName, number>,
  ): DatasetSnapshotSummary {
    if (
      snapshot.task !== MEMORY_DATASET_TASK &&
      snapshot.task !== RAG_DATASET_TASK
    ) {
      throw new Error('unsupported workspace dataset task');
    }
    return {
      id: snapshot.id,
      task: snapshot.task,
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
