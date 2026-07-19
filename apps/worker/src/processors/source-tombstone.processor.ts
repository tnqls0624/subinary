/**
 * source tombstone을 object storage와 파생 학습 projection으로 전파한다.
 * 개인정보 삭제를 우선해 삭제 source가 한 번이라도 기여한 chunk는 보수적으로
 * 비활성화하며, lineage 식별자는 감사·영향 분석을 위해 유지한다.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import {
  markTrainingArtifactsPurged,
  revokeTrainingRuns,
  schema,
  trackPipelineExecution,
  type Db,
} from '@family/database';
import {
  createLogger,
  OUTBOX_EVENT_TYPES,
  QUEUE_NAMES,
} from '@family/shared';

import { DB } from '../database/database.module';
import { ObjectStorageService } from '../storage/object-storage.service';

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TOMBSTONE_VERSION = 'source-tombstone-v1';

interface SourceTombstoneJobData {
  sourceItemId: string;
}

interface SourceTombstoneJobResult {
  sourceItemId: string;
  objectDeleteCount: number;
  normalizedDeleteCount: number;
  chunkTombstoneCount: number;
  revokedDatasetCount: number;
  revokedMemoryCount: number;
  revokedRetrievalExampleCount: number;
}

@Processor(QUEUE_NAMES.SOURCE_TOMBSTONE)
export class SourceTombstoneProcessor extends WorkerHost {
  private readonly logger = createLogger('worker:source-tombstone-processor', {
    pretty: process.env.NODE_ENV !== 'production',
  });

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {
    super();
  }

  /** tombstone propagation 실행과 단계별 집계를 pipeline run으로 기록한다. */
  async process(
    job: Job<SourceTombstoneJobData>,
  ): Promise<SourceTombstoneJobResult> {
    return trackPipelineExecution(
      this.db,
      {
        pipelineName: 'source-tombstone',
        pipelineVersion: TOMBSTONE_VERSION,
        stepName: 'erase-and-propagate',
        stepVersion: TOMBSTONE_VERSION,
        trigger: 'bullmq',
        scopeType: 'source_item',
        scopeId: job.data.sourceItemId || 'missing',
        externalRunId: String(job.id ?? 'unknown'),
        attempt: job.attemptsMade + 1,
        maximumAttempts: job.opts?.attempts ?? 1,
        summarize: (result) => ({
          inputCount: 1,
          outputCount:
            result.normalizedDeleteCount + result.chunkTombstoneCount,
          rejectedCount: 0,
          metrics: {
            objectDeleteCount: result.objectDeleteCount,
            revokedDatasetCount: result.revokedDatasetCount,
            revokedMemoryCount: result.revokedMemoryCount,
            revokedRetrievalExampleCount:
              result.revokedRetrievalExampleCount,
          },
        }),
      },
      ({ pipelineRunId }) => this.processTracked(job, pipelineRunId),
    );
  }

  private async processTracked(
    job: Job<SourceTombstoneJobData>,
    pipelineRunId: string,
  ): Promise<SourceTombstoneJobResult> {
    const { sourceItemId } = job.data;
    if (!sourceItemId) {
      throw new Error('source tombstone job payload is missing sourceItemId');
    }

    const [source] = await this.db
      .select({
        id: schema.sourceItems.id,
        kind: schema.sourceItems.kind,
        workspaceId: schema.sourceItems.workspaceId,
        currentRevisionId: schema.sourceItems.currentRevisionId,
        deletedAt: schema.sourceItems.deletedAt,
      })
      .from(schema.sourceItems)
      .where(eq(schema.sourceItems.id, sourceItemId))
      .limit(1);
    if (!source || source.deletedAt === null || source.currentRevisionId === null) {
      throw new Error('source tombstone projection is unavailable');
    }

    const revisions = await this.db
      .select({
        id: schema.sourceRevisions.id,
        objectKey: schema.sourceRevisions.objectKey,
        isTombstone: schema.sourceRevisions.isTombstone,
      })
      .from(schema.sourceRevisions)
      .where(eq(schema.sourceRevisions.sourceItemId, sourceItemId));
    const current = revisions.find(
      (revision) => revision.id === source.currentRevisionId,
    );
    if (!current?.isTombstone) {
      throw new Error('source current revision is not a tombstone');
    }

    const objectKeys = [
      ...new Set(
        revisions
          .filter((revision) => !revision.isTombstone)
          .map((revision) => revision.objectKey),
      ),
    ];
    for (const objectKey of objectKeys) {
      await this.storage.deleteObject(objectKey);
    }

    const result = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`source-tombstone:${sourceItemId}`}))`,
      );
      if (source.workspaceId !== null) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`rag-index:${source.workspaceId}`}))`,
        );
      }
      const now = new Date();
      const sourceRevisionIds = revisions
        .filter((revision) => !revision.isTombstone)
        .map((revision) => revision.id);
      if (sourceRevisionIds.length > 0) {
        await tx
          .update(schema.sourceRevisions)
          .set({ deletedAt: now })
          .where(inArray(schema.sourceRevisions.id, sourceRevisionIds));
      }

      let normalizedDeleteCount = 0;
      if (source.kind === 'slack') {
        const deletedMessages = await tx
          .delete(schema.slackMessages)
          .where(eq(schema.slackMessages.sourceItemId, sourceItemId))
          .returning({ id: schema.slackMessages.id });
        normalizedDeleteCount += deletedMessages.length;
        if (source.workspaceId !== null) {
          await tx.execute(sql`
            delete from slack_threads st
            using slack_workspaces sw
            where st.slack_workspace_id = sw.id
              and sw.workspace_id = ${source.workspaceId}
              and not exists (
                select 1
                from slack_messages sm
                where sm.slack_channel_id = st.slack_channel_id
                  and sm.thread_ts = st.thread_ts
              )
          `);
        }
      } else if (source.kind === 'card_sms') {
        const cardEvents = await tx
          .select({ id: schema.cardSmsEvents.id })
          .from(schema.cardSmsEvents)
          .where(eq(schema.cardSmsEvents.sourceItemId, sourceItemId));
        const cardEventIds = cardEvents.map((event) => event.id);
        if (cardEventIds.length > 0) {
          const scrubbedEvents = await tx
            .update(schema.cardSmsEvents)
            .set({
              sender: '',
              rawContent: '',
              contentHash: EMPTY_SHA256,
              parseStatus: 'parse_failed',
              parseError: 'SourceTombstoned',
              merchantRaw: null,
              maskedCardNumber: null,
              updatedAt: now,
            })
            .where(inArray(schema.cardSmsEvents.id, cardEventIds))
            .returning({ id: schema.cardSmsEvents.id });
          normalizedDeleteCount += scrubbedEvents.length;
          await tx
            .update(schema.cardTransactions)
            .set({
              merchantRaw: null,
              merchantNormalized: null,
              authorizationCode: null,
              memo: null,
              excludedAt: now,
              updatedAt: now,
            })
            .where(inArray(schema.cardTransactions.sourceEventId, cardEventIds));
        }
      }

      const lineageRows =
        sourceRevisionIds.length === 0
          ? []
          : await tx
              .select({ chunkRevisionId: schema.lineageEdges.toNodeId })
              .from(schema.lineageEdges)
              .where(
                and(
                  eq(schema.lineageEdges.fromNodeType, 'source_revision'),
                  inArray(schema.lineageEdges.fromNodeId, sourceRevisionIds),
                  eq(schema.lineageEdges.toNodeType, 'chunk_revision'),
                ),
              );
      const affectedRevisionIds = [
        ...new Set(lineageRows.map((row) => row.chunkRevisionId)),
      ];
      const affectedRevisionRows =
        affectedRevisionIds.length === 0
          ? []
          : await tx
              .select({ chunkId: schema.chunkRevisions.chunkId })
              .from(schema.chunkRevisions)
              .where(inArray(schema.chunkRevisions.id, affectedRevisionIds));
      const chunkIds = [
        ...new Set(affectedRevisionRows.map((row) => row.chunkId)),
      ];
      const allChunkRevisions =
        chunkIds.length === 0
          ? []
          : await tx
              .select({
                id: schema.chunkRevisions.id,
                chunkId: schema.chunkRevisions.chunkId,
                revision: schema.chunkRevisions.revision,
                isTombstone: schema.chunkRevisions.isTombstone,
                validFrom: schema.chunkRevisions.validFrom,
                validUntil: schema.chunkRevisions.validUntil,
              })
              .from(schema.chunkRevisions)
              .where(inArray(schema.chunkRevisions.chunkId, chunkIds));
      const allChunkRevisionIds = allChunkRevisions.map(
        (revision) => revision.id,
      );

      let revokedDatasetCount = 0;
      let revokedRetrievalExampleCount = 0;
      let retrievalQueryObjectKeys: string[] = [];
      let revokedDatasetObjectKeys: string[] = [];
      let revokedTrainingRunIds: string[] = [];
      if (allChunkRevisionIds.length > 0) {
        const retrievalExamples = await tx
          .select({
            queryObjectKey: schema.ragRetrievalExamples.queryObjectKey,
          })
          .from(schema.ragRetrievalExamples)
          .where(
            inArray(
              schema.ragRetrievalExamples.chunkRevisionId,
              allChunkRevisionIds,
            ),
          );
        retrievalQueryObjectKeys = [
          ...new Set(
            retrievalExamples.map((example) => example.queryObjectKey),
          ),
        ];
        const revokedRetrievalExamples = await tx
          .update(schema.ragRetrievalExamples)
          .set({
            revokedAt: now,
            revocationReason: 'source_tombstoned',
          })
          .where(
            and(
              inArray(
                schema.ragRetrievalExamples.chunkRevisionId,
                allChunkRevisionIds,
              ),
              isNull(schema.ragRetrievalExamples.revokedAt),
            ),
          )
          .returning({ id: schema.ragRetrievalExamples.id });
        revokedRetrievalExampleCount = revokedRetrievalExamples.length;

        const snapshotRows = await tx
          .select({
            id: schema.datasetSnapshotItems.datasetSnapshotId,
            artifactKey: schema.datasetSnapshots.artifactKey,
            manifestKey: schema.datasetSnapshots.manifestKey,
          })
          .from(schema.datasetSnapshotItems)
          .innerJoin(
            schema.datasetSnapshots,
            eq(
              schema.datasetSnapshotItems.datasetSnapshotId,
              schema.datasetSnapshots.id,
            ),
          )
          .where(
            inArray(
              schema.datasetSnapshotItems.chunkRevisionId,
              allChunkRevisionIds,
            ),
          );
        const snapshotIds = [...new Set(snapshotRows.map((row) => row.id))];
        revokedDatasetObjectKeys = [
          ...new Set(
            snapshotRows.flatMap((row) => [
              row.artifactKey,
              row.manifestKey,
            ]),
          ),
        ];
        if (snapshotIds.length > 0) {
          const revoked = await tx
            .update(schema.datasetSnapshots)
            .set({
              status: 'revoked',
              revokedAt: now,
              revocationReason: 'source_tombstoned',
              updatedAt: now,
            })
            .where(
              and(
                inArray(schema.datasetSnapshots.id, snapshotIds),
                ne(schema.datasetSnapshots.status, 'revoked'),
              ),
            )
            .returning({ id: schema.datasetSnapshots.id });
          revokedDatasetCount = revoked.length;
          const trainingArtifacts = await revokeTrainingRuns(
            tx,
            snapshotIds,
            'source_tombstoned',
            now,
          );
          revokedTrainingRunIds = trainingArtifacts.trainingRunIds;
          revokedDatasetObjectKeys = [
            ...new Set([
              ...revokedDatasetObjectKeys,
              ...trainingArtifacts.objectKeys,
            ]),
          ];
          if (revoked.length > 0) {
            const revokedEvaluations = await tx
              .update(schema.evaluationRuns)
              .set({
                status: 'revoked',
                revokedAt: now,
                revocationReason: 'source_tombstoned',
              })
              .where(
                and(
                  inArray(
                    schema.evaluationRuns.datasetSnapshotId,
                    revoked.map((snapshot) => snapshot.id),
                  ),
                  ne(schema.evaluationRuns.status, 'revoked'),
                ),
              )
              .returning({ id: schema.evaluationRuns.id });
            if (revokedEvaluations.length > 0) {
              const suspendedAliases = await tx
                .update(schema.modelAliases)
                .set({
                  suspendedAt: now,
                  suspensionReason: 'evaluation_revoked',
                  updatedAt: now,
                })
                .where(
                  inArray(
                    schema.modelAliases.evaluationRunId,
                    revokedEvaluations.map((evaluation) => evaluation.id),
                  ),
                )
                .returning({ id: schema.modelAliases.id });
              if (suspendedAliases.length > 0) {
                await tx
                  .update(schema.modelCanaryRuns)
                  .set({
                    status: 'superseded',
                    decisionReason: 'evaluation_revoked',
                    lastEvaluatedAt: now,
                    updatedAt: now,
                  })
                  .where(
                    and(
                      inArray(
                        schema.modelCanaryRuns.modelAliasId,
                        suspendedAliases.map((alias) => alias.id),
                      ),
                      eq(schema.modelCanaryRuns.status, 'monitoring'),
                    ),
                  );
              }
            }
          }
        }
      }

      let revokedMemoryCount = 0;
      if (chunkIds.length > 0) {
        const candidates = await tx
          .select({
            id: schema.memoryCandidates.id,
            promotedMemoryId: schema.memoryCandidates.promotedMemoryId,
          })
          .from(schema.memoryCandidates)
          .where(inArray(schema.memoryCandidates.sourceChunkId, chunkIds));
        const memoryIds = [
          ...new Set(
            candidates
              .map((candidate) => candidate.promotedMemoryId)
              .filter((id): id is string => id !== null),
          ),
        ];
        if (candidates.length > 0) {
          await tx
            .update(schema.memoryCandidates)
            .set({
              subject: '',
              content: '',
              status: 'rejected',
              updatedAt: now,
            })
            .where(
              inArray(
                schema.memoryCandidates.id,
                candidates.map((candidate) => candidate.id),
              ),
            );
        }
        if (memoryIds.length > 0) {
          await tx
            .update(schema.memoryVersions)
            .set({ subject: '', content: '' })
            .where(inArray(schema.memoryVersions.memoryId, memoryIds));
          const revokedMemories = await tx
            .update(schema.memories)
            .set({
              subject: '',
              content: '',
              status: 'rejected',
              validUntil: now,
              deletedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                inArray(schema.memories.id, memoryIds),
                isNull(schema.memories.deletedAt),
              ),
            )
            .returning({ id: schema.memories.id });
          revokedMemoryCount = revokedMemories.length;
        }
      }

      let chunkTombstoneCount = 0;
      const tombstoneBindings: {
        chunkId: string;
        chunkRevisionId: string;
      }[] = [];
      if (chunkIds.length > 0) {
        await tx
          .delete(schema.embeddings)
          .where(inArray(schema.embeddings.chunkId, chunkIds));
        if (allChunkRevisionIds.length > 0) {
          await tx
            .delete(schema.embeddingVersions)
            .where(
              inArray(
                schema.embeddingVersions.chunkRevisionId,
                allChunkRevisionIds,
              ),
            );
        }
        if (allChunkRevisionIds.length > 0) {
          await tx
            .update(schema.chunkRevisions)
            .set({
              text: '',
              contentHash: EMPTY_SHA256,
              deletedAt: now,
            })
            .where(inArray(schema.chunkRevisions.id, allChunkRevisionIds));
        }

        for (const chunkId of chunkIds) {
          const history = allChunkRevisions.filter(
            (revision) => revision.chunkId === chunkId,
          );
          const currentRevision = history.find(
            (revision) => revision.validUntil === null,
          );
          let tombstoneRevisionId = currentRevision?.id;
          if (!currentRevision?.isTombstone) {
            const tombstoneAt =
              currentRevision && now <= currentRevision.validFrom
                ? new Date(currentRevision.validFrom.getTime() + 1)
                : now;
            if (currentRevision) {
              await tx
                .update(schema.chunkRevisions)
                .set({ validUntil: tombstoneAt, deletedAt: tombstoneAt })
                .where(eq(schema.chunkRevisions.id, currentRevision.id));
            }
            const nextRevision =
              history.reduce(
                (maximum, revision) =>
                  Math.max(maximum, revision.revision),
                0,
              ) + 1;
            const [created] = await tx
              .insert(schema.chunkRevisions)
              .values({
                chunkId,
                revision: nextRevision,
                contentHash: EMPTY_SHA256,
                sourceFingerprint: EMPTY_SHA256,
                text: '',
                chunkerVersion: TOMBSTONE_VERSION,
                redactionVersion: TOMBSTONE_VERSION,
                isTombstone: true,
                pipelineRunId,
                validFrom: tombstoneAt,
                deletedAt: tombstoneAt,
              })
              .returning({ id: schema.chunkRevisions.id });
            if (!created) {
              throw new Error('chunk tombstone revision insert returned no row');
            }
            tombstoneRevisionId = created.id;
            chunkTombstoneCount += 1;
          }
          if (tombstoneRevisionId !== undefined) {
            await tx
              .update(schema.chunks)
              .set({
                text: '',
                metadata: { status: 'deleted' },
                currentRevisionId: tombstoneRevisionId,
                deletedAt: now,
                updatedAt: now,
              })
              .where(eq(schema.chunks.id, chunkId));
            tombstoneBindings.push({
              chunkId,
              chunkRevisionId: tombstoneRevisionId,
            });
          }
        }
        if (source.workspaceId !== null && tombstoneBindings.length > 0) {
          await tx
            .insert(schema.dataEvents)
            .values(
              tombstoneBindings.flatMap((binding) =>
                [
                  OUTBOX_EVENT_TYPES.RAG_CHUNK_MEMORY_READY,
                  OUTBOX_EVENT_TYPES.RAG_CHUNK_GRAPH_READY,
                ].map((eventType) => ({
                  aggregateType: 'chunk',
                  aggregateId: binding.chunkId,
                  eventType,
                  revisionId: binding.chunkRevisionId,
                  workspaceId: source.workspaceId,
                  payload: {
                    workspaceId: source.workspaceId,
                    chunkId: binding.chunkId,
                    chunkRevisionId: binding.chunkRevisionId,
                  },
                  producerPipelineRunId: pipelineRunId,
                  occurredAt: now,
                })),
              ),
            )
            .onConflictDoNothing();
        }
      }

      return {
        normalizedDeleteCount,
        chunkTombstoneCount,
        revokedDatasetCount,
        revokedMemoryCount,
        revokedRetrievalExampleCount,
        retrievalQueryObjectKeys,
        revokedDatasetObjectKeys,
        revokedTrainingRunIds,
      };
    });

    const derivedObjectKeys = [
      ...new Set([
        ...result.retrievalQueryObjectKeys,
        ...result.revokedDatasetObjectKeys,
      ]),
    ];
    for (const objectKey of derivedObjectKeys) {
      await this.storage.deleteObject(objectKey);
    }
    await markTrainingArtifactsPurged(
      this.db,
      result.revokedTrainingRunIds,
    );

    const summary: SourceTombstoneJobResult = {
      sourceItemId,
      objectDeleteCount:
        objectKeys.length + derivedObjectKeys.length,
      normalizedDeleteCount: result.normalizedDeleteCount,
      chunkTombstoneCount: result.chunkTombstoneCount,
      revokedDatasetCount: result.revokedDatasetCount,
      revokedMemoryCount: result.revokedMemoryCount,
      revokedRetrievalExampleCount: result.revokedRetrievalExampleCount,
    };
    this.logger.info(summary, 'source tombstone propagated');
    return summary;
  }
}
