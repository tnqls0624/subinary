/** 명시적 검색 관련성 피드백을 수집하고 RAG embedding 평가 snapshot을 생성한다. */
import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type {
  DatasetSnapshotSummary,
  RagEmbeddingDatasetCreateRequest,
  RagRetrievalFeedbackCreateRequest,
  RagRetrievalFeedbackResponse,
} from '@family/contracts';
import { schema, trackPipelineExecution, type Db } from '@family/database';
import {
  buildRagRetrievalDatasetArtifact,
  canonicalJson,
  sha256Hex,
  type DatasetSplitName,
  type RagRetrievalDatasetInput,
} from '@family/rag';

import { DB } from '../database/database.constants';
import { ObjectStorageService } from '../storage/object-storage.service';
import {
  createDatasetSnapshotVersion,
  createLearningDatasetSplitPolicy,
  toStoredSplitPolicy,
} from './learning-dataset-split';

const RAG_FEEDBACK_TARGET_TYPE = 'rag-retrieval' as const;
const RAG_DATASET_TASK = 'rag-embedding' as const;
const RAG_FEEDBACK_SCHEMA_VERSION = 'rag-retrieval-relevance-v1';
const RAG_DATASET_SCHEMA_VERSION = 'rag-embedding-dataset-v2';
const ELIGIBLE_FEEDBACK_SOURCES = ['human_confirmed', 'imported_gold'] as const;

interface DatasetBuildResult {
  summary: DatasetSnapshotSummary;
  reused: boolean;
}

@Injectable()
export class LearningRagDatasetService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  /**
   * owner가 관련 있다고 확정한 질의–현재 chunk revision pair를 기록한다.
   * 원문 질의는 object storage에만 저장하고 API 응답·DB label에는 포함하지 않는다.
   */
  async recordFeedback(
    userId: string,
    input: RagRetrievalFeedbackCreateRequest,
  ): Promise<RagRetrievalFeedbackResponse> {
    await this.assertOwnedWorkspace(userId, input.workspaceId);
    const query = input.query.trim();
    const queryHash = sha256Hex(query);
    const [chunk] = await this.db
      .select({
        id: schema.chunks.id,
        currentRevisionId: schema.chunks.currentRevisionId,
        revisionDeletedAt: schema.chunkRevisions.deletedAt,
        revisionIsTombstone: schema.chunkRevisions.isTombstone,
      })
      .from(schema.chunks)
      .leftJoin(
        schema.chunkRevisions,
        eq(schema.chunks.currentRevisionId, schema.chunkRevisions.id),
      )
      .where(
        and(
          eq(schema.chunks.id, input.relevantChunkId),
          eq(schema.chunks.workspaceId, input.workspaceId),
          isNull(schema.chunks.deletedAt),
        ),
      )
      .limit(1);
    if (!chunk) {
      throw new NotFoundException('active retrieval chunk not found');
    }
    if (
      chunk.currentRevisionId === null ||
      chunk.revisionDeletedAt !== null ||
      chunk.revisionIsTombstone !== false
    ) {
      throw new ConflictException('retrieval chunk revision is unavailable');
    }
    const chunkRevisionId = chunk.currentRevisionId;

    const queryObjectKey =
      `learning-inputs/${RAG_FEEDBACK_TARGET_TYPE}/${input.workspaceId}/` +
      `${queryHash}/${chunkRevisionId}.txt`;
    try {
      await this.storage.putObject(
        queryObjectKey,
        query,
        'text/plain; charset=utf-8',
      );
    } catch {
      throw new ServiceUnavailableException(
        'retrieval feedback storage is unavailable',
      );
    }

    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`rag-index:${input.workspaceId}`}))`,
        );
        const [currentChunk] = await tx
          .select({ id: schema.chunks.id })
          .from(schema.chunks)
          .innerJoin(
            schema.chunkRevisions,
            eq(schema.chunks.currentRevisionId, schema.chunkRevisions.id),
          )
          .where(
            and(
              eq(schema.chunks.id, chunk.id),
              eq(schema.chunks.workspaceId, input.workspaceId),
              eq(schema.chunks.currentRevisionId, chunkRevisionId),
              isNull(schema.chunks.deletedAt),
              isNull(schema.chunkRevisions.deletedAt),
              eq(schema.chunkRevisions.isTombstone, false),
            ),
          )
          .limit(1);
        if (!currentChunk) {
          throw new ConflictException(
            'retrieval chunk changed before feedback was recorded',
          );
        }
        const lockKey =
          `rag-feedback:${input.workspaceId}:${queryHash}:` +
          chunkRevisionId;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`,
        );
        const [existing] = await tx
          .select()
          .from(schema.ragRetrievalExamples)
          .where(
            and(
              eq(schema.ragRetrievalExamples.workspaceId, input.workspaceId),
              eq(schema.ragRetrievalExamples.queryHash, queryHash),
              eq(
                schema.ragRetrievalExamples.chunkRevisionId,
                chunkRevisionId,
              ),
              isNull(schema.ragRetrievalExamples.revokedAt),
            ),
          )
          .limit(1);
        if (existing) {
          return this.toFeedbackResponse(existing);
        }

        const occurredAt = new Date();
        const exampleId = randomUUID();
        const [feedback] = await tx
          .insert(schema.feedbackEvents)
          .values({
            workspaceId: input.workspaceId,
            targetType: RAG_FEEDBACK_TARGET_TYPE,
            targetId: exampleId,
            labelSchemaVersion: RAG_FEEDBACK_SCHEMA_VERSION,
            label: {
              consent: 'explicit',
              relevance: 'relevant',
              queryHash,
              chunkRevisionId,
            },
            source: 'human_confirmed',
            actorUserId: userId,
            occurredAt,
          })
          .returning({ id: schema.feedbackEvents.id });
        if (!feedback) {
          throw new Error('retrieval feedback event insert returned no row');
        }
        const [created] = await tx
          .insert(schema.ragRetrievalExamples)
          .values({
            id: exampleId,
            workspaceId: input.workspaceId,
            feedbackEventId: feedback.id,
            chunkId: chunk.id,
            chunkRevisionId,
            queryObjectKey,
            queryHash,
            labelSchemaVersion: RAG_FEEDBACK_SCHEMA_VERSION,
            occurredAt,
          })
          .returning();
        if (!created) {
          throw new Error('retrieval example insert returned no row');
        }
        return this.toFeedbackResponse(created);
      });
    } catch (error: unknown) {
      if (
        error instanceof ConflictException &&
        error.message ===
          'retrieval chunk changed before feedback was recorded'
      ) {
        try {
          await this.storage.deleteObject(queryObjectKey);
        } catch {
          // DB 참조가 없는 경합 orphan은 lifecycle cleanup에서 다시 정리한다.
        }
      }
      throw error;
    }
  }

  /** 확정 피드백을 rag-embedding offline 평가용 immutable snapshot으로 고정한다. */
  async createSnapshot(
    userId: string,
    input: RagEmbeddingDatasetCreateRequest,
  ): Promise<DatasetSnapshotSummary> {
    await this.assertOwnedWorkspace(userId, input.workspaceId);
    const result = await trackPipelineExecution<DatasetBuildResult>(
      this.db,
      {
        pipelineName: 'dataset-snapshot-build',
        pipelineVersion: RAG_DATASET_SCHEMA_VERSION,
        stepName: 'resolve-build-publish',
        stepVersion: RAG_DATASET_SCHEMA_VERSION,
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
        this.createSnapshotTracked(userId, input, pipelineRunId),
    );
    return result.summary;
  }

  private async createSnapshotTracked(
    userId: string,
    input: RagEmbeddingDatasetCreateRequest,
    pipelineRunId: string,
  ): Promise<DatasetBuildResult> {
    const rows = await this.db
      .select({
        id: schema.ragRetrievalExamples.id,
        feedbackEventId: schema.ragRetrievalExamples.feedbackEventId,
        chunkId: schema.ragRetrievalExamples.chunkId,
        chunkRevisionId: schema.ragRetrievalExamples.chunkRevisionId,
        queryObjectKey: schema.ragRetrievalExamples.queryObjectKey,
        queryHash: schema.ragRetrievalExamples.queryHash,
        labelSchemaVersion: schema.ragRetrievalExamples.labelSchemaVersion,
        occurredAt: schema.ragRetrievalExamples.occurredAt,
        source: schema.feedbackEvents.source,
      })
      .from(schema.ragRetrievalExamples)
      .innerJoin(
        schema.feedbackEvents,
        eq(
          schema.ragRetrievalExamples.feedbackEventId,
          schema.feedbackEvents.id,
        ),
      )
      .innerJoin(
        schema.chunks,
        and(
          eq(schema.ragRetrievalExamples.chunkId, schema.chunks.id),
          eq(
            schema.ragRetrievalExamples.chunkRevisionId,
            schema.chunks.currentRevisionId,
          ),
        ),
      )
      .innerJoin(
        schema.chunkRevisions,
        eq(
          schema.ragRetrievalExamples.chunkRevisionId,
          schema.chunkRevisions.id,
        ),
      )
      .where(
        and(
          eq(schema.ragRetrievalExamples.workspaceId, input.workspaceId),
          eq(schema.feedbackEvents.targetType, RAG_FEEDBACK_TARGET_TYPE),
          inArray(schema.feedbackEvents.source, ELIGIBLE_FEEDBACK_SOURCES),
          isNull(schema.ragRetrievalExamples.revokedAt),
          isNull(schema.chunks.deletedAt),
          isNull(schema.chunkRevisions.deletedAt),
          eq(schema.chunkRevisions.isTombstone, false),
        ),
      );
    if (rows.length === 0) {
      throw new BadRequestException(
        'RAG embedding dataset requires at least one active relevance example',
      );
    }

    let queries: string[];
    try {
      queries = await Promise.all(
        rows.map(async (row) => {
          const query = (await this.storage.getObject(row.queryObjectKey))
            .toString('utf8')
            .trim();
          if (sha256Hex(query) !== row.queryHash) {
            throw new Error('retrieval query object hash mismatch');
          }
          return query;
        }),
      );
    } catch {
      throw new ServiceUnavailableException(
        'retrieval feedback artifact is unavailable or invalid',
      );
    }

    const datasetInputs: RagRetrievalDatasetInput[] = rows.map((row, index) => {
      if (row.source !== 'human_confirmed' && row.source !== 'imported_gold') {
        throw new Error('retrieval feedback source is not eligible');
      }
      return {
        feedbackEventId: row.feedbackEventId,
        targetId: row.id,
        query: queries[index],
        queryHash: row.queryHash,
        chunkRevisionId: row.chunkRevisionId,
        sourceGroupKey: row.chunkId,
        occurredAt: row.occurredAt,
        labelSchemaVersion: row.labelSchemaVersion,
        source: row.source,
      };
    });
    const splitPolicy = createLearningDatasetSplitPolicy(
      input,
      RAG_DATASET_SCHEMA_VERSION,
    );
    const artifact = buildRagRetrievalDatasetArtifact(
      datasetInputs,
      splitPolicy,
    );
    const version = createDatasetSnapshotVersion(
      RAG_DATASET_SCHEMA_VERSION,
      artifact.artifactHash,
      artifact.splitPolicy,
    );
    const baseKey = `gold/${RAG_DATASET_TASK}/${input.workspaceId}/${version}`;
    const artifactKey = `${baseKey}/examples.jsonl`;
    const manifestKey = `${baseKey}/manifest.json`;
    const manifest = {
      task: RAG_DATASET_TASK,
      version,
      schemaVersion: RAG_DATASET_SCHEMA_VERSION,
      labelSchemaVersion: RAG_FEEDBACK_SCHEMA_VERSION,
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
      consentScope: {
        mode: 'explicit-retrieval-feedback',
        crossWorkspace: false,
      },
    };
    const manifestJson = `${canonicalJson(manifest)}\n`;
    const manifestHash = sha256Hex(manifestJson);

    const [existing] = await this.db
      .select()
      .from(schema.datasetSnapshots)
      .where(
        and(
          eq(schema.datasetSnapshots.workspaceId, input.workspaceId),
          eq(schema.datasetSnapshots.task, RAG_DATASET_TASK),
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

    let created: schema.DatasetSnapshot | null;
    try {
      created = await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`rag-index:${input.workspaceId}`}))`,
        );
        const activeInputs = await tx
          .select({ id: schema.ragRetrievalExamples.id })
          .from(schema.ragRetrievalExamples)
          .innerJoin(
            schema.chunks,
            and(
              eq(schema.ragRetrievalExamples.chunkId, schema.chunks.id),
              eq(
                schema.ragRetrievalExamples.chunkRevisionId,
                schema.chunks.currentRevisionId,
              ),
            ),
          )
          .innerJoin(
            schema.chunkRevisions,
            eq(
              schema.ragRetrievalExamples.chunkRevisionId,
              schema.chunkRevisions.id,
            ),
          )
          .where(
            and(
              inArray(
                schema.ragRetrievalExamples.id,
                rows.map((row) => row.id),
              ),
              isNull(schema.ragRetrievalExamples.revokedAt),
              isNull(schema.chunks.deletedAt),
              isNull(schema.chunkRevisions.deletedAt),
              eq(schema.chunkRevisions.isTombstone, false),
            ),
          );
        if (activeInputs.length !== rows.length) {
          throw new ConflictException(
            'RAG dataset inputs changed while the snapshot was built',
          );
        }

        const [snapshot] = await tx
          .insert(schema.datasetSnapshots)
          .values({
            workspaceId: input.workspaceId,
            task: RAG_DATASET_TASK,
            version,
            schemaVersion: RAG_DATASET_SCHEMA_VERSION,
            artifactKey,
            artifactHash: artifact.artifactHash,
            manifestKey,
            manifestHash,
            splitPolicy: toStoredSplitPolicy(
              artifact.splitPolicy,
              artifact.leakageAudit,
            ),
            consentScope: {
              mode: 'explicit-retrieval-feedback',
              crossWorkspace: false,
            },
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
            chunkRevisionId: row.positiveChunkRevisionId,
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
              fromNodeId: row.positiveChunkRevisionId,
              toNodeType: 'dataset_snapshot',
              toNodeId: snapshot.id,
              transformVersion: RAG_DATASET_SCHEMA_VERSION,
              pipelineRunId,
            })),
            ...artifact.rows.map((row) => ({
              fromNodeType: 'feedback_event',
              fromNodeId: row.feedbackEventId,
              toNodeType: 'dataset_snapshot',
              toNodeId: snapshot.id,
              transformVersion: RAG_DATASET_SCHEMA_VERSION,
              pipelineRunId,
            })),
          ])
          .onConflictDoNothing();
        return snapshot;
      });
    } catch (error: unknown) {
      if (
        error instanceof ConflictException &&
        error.message ===
          'RAG dataset inputs changed while the snapshot was built'
      ) {
        await Promise.allSettled([
          this.storage.deleteObject(artifactKey),
          this.storage.deleteObject(manifestKey),
        ]);
      }
      throw error;
    }
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
          eq(schema.datasetSnapshots.task, RAG_DATASET_TASK),
          eq(schema.datasetSnapshots.version, version),
        ),
      )
      .limit(1);
    if (!concurrent) {
      throw new Error('RAG dataset conflict resolved without a stored row');
    }
    return {
      summary: this.toSummary(concurrent, artifact.splitCounts),
      reused: true,
    };
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

  private toFeedbackResponse(
    example: schema.RagRetrievalExample,
  ): RagRetrievalFeedbackResponse {
    return {
      id: example.id,
      feedbackEventId: example.feedbackEventId,
      workspaceId: example.workspaceId,
      chunkId: example.chunkId,
      chunkRevisionId: example.chunkRevisionId,
      queryHash: example.queryHash,
      status: 'recorded',
      occurredAt: example.occurredAt.toISOString(),
    };
  }

  private toSummary(
    snapshot: schema.DatasetSnapshot,
    splitCounts: Record<DatasetSplitName, number>,
  ): DatasetSnapshotSummary {
    if (snapshot.task !== RAG_DATASET_TASK) {
      throw new Error('unsupported dataset task stored in RAG dataset service');
    }
    return {
      id: snapshot.id,
      task: RAG_DATASET_TASK,
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
