/**
 * Slack export를 정규화하고 current projection과 비교해 change-set을 발행한다.
 * `merge`는 생성·편집만, 명시적 `snapshot`은 번들 채널 내부 누락 삭제까지 반영한다.
 * 기존 tombstone은 재수집으로 복구하지 않으며 첫 import만 전체 RAG build를 요청한다.
 * 이후 import는 변경된 메시지/스레드 target event만 발행한다.
 */
import { randomUUID } from 'node:crypto';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import {
  schema,
  trackPipelineExecution,
  type Db,
} from '@family/database';
import {
  createLogger,
  OUTBOX_EVENT_TYPES,
  QUEUE_NAMES,
} from '@family/shared';
import {
  compareTs,
  parseSlackExport,
  reconcileSlackMessages,
  type CurrentSlackMessageProjection,
  type IncomingSlackMessageProjection,
  type SlackImportSyncMode,
} from '@family/slack-parser';
import type { Job } from 'bullmq';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DB } from '../database/database.module';
import { ObjectStorageService } from '../storage/object-storage.service';

/** 기존 outbox job 호환을 위해 syncMode 누락은 merge로 해석한다. */
interface SlackImportJobData {
  sourceItemId: string;
  slackWorkspaceId: string;
  syncMode?: SlackImportSyncMode;
}

/** 잡 결과. 정상 import는 count 집계, source_item 미존재는 skipped 로 구분한다. */
type SlackImportJobResult =
  | {
      sourceItemId: string;
      slackWorkspaceId: string;
      syncMode: SlackImportSyncMode;
      channelCount: number;
      userCount: number;
      messageCount: number;
      threadCount: number;
      createdMessageCount: number;
      updatedMessageCount: number;
      deletedMessageCount: number;
      incrementalTargetCount: number;
      ignoredTombstoneCount: number;
      ignoredStaleUpdateCount: number;
      duplicateIncomingCount: number;
      skippedMessageCount: number;
      warningCount: number;
    }
  | { sourceItemId: string; skipped: true };

/**
 * 대량 insert 시 Postgres 파라미터 상한(65535)을 넘지 않도록 나누는 배치 크기.
 * 메시지 한 행당 컬럼 수를 고려한 보수적 값이다.
 */
const BATCH_SIZE = 500;

type TargetSourceType = 'slack_thread' | 'slack_message';
type TargetChangeType = 'created' | 'edited' | 'deleted';

interface IncrementalTarget {
  sourceType: TargetSourceType;
  sourceRefId: string;
  changeType: TargetChangeType;
}

const TARGET_PRIORITY: Record<TargetChangeType, number> = {
  created: 1,
  edited: 2,
  deleted: 3,
};

function messageTarget(message: {
  ts: string;
  threadTs: string | null;
}): Omit<IncrementalTarget, 'changeType'> {
  return message.threadTs === null
    ? { sourceType: 'slack_message', sourceRefId: message.ts }
    : { sourceType: 'slack_thread', sourceRefId: message.threadTs };
}

function addTarget(
  targets: Map<string, IncrementalTarget>,
  message: { ts: string; threadTs: string | null },
  changeType: TargetChangeType,
): void {
  const target = messageTarget(message);
  const key = `${target.sourceType}\u0000${target.sourceRefId}`;
  const existing = targets.get(key);
  if (
    existing === undefined ||
    TARGET_PRIORITY[changeType] > TARGET_PRIORITY[existing.changeType]
  ) {
    targets.set(key, { ...target, changeType });
  }
}

@Processor(QUEUE_NAMES.SLACK_IMPORT)
export class SlackImportProcessor extends WorkerHost {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
    configService: ConfigService,
  ) {
    super();
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:slack-import-processor', {
      pretty: nodeEnv !== 'production',
    });
  }

  async process(job: Job<SlackImportJobData>): Promise<SlackImportJobResult> {
    return trackPipelineExecution(
      this.db,
      {
        pipelineName: 'slack-import',
        pipelineVersion: 'slack-import-v3',
        stepName: 'parse-and-normalize',
        stepVersion: 'slack-reconciliation-v1',
        trigger: 'bullmq',
        scopeType: 'slack-workspace',
        scopeId: job.data.slackWorkspaceId || 'missing',
        externalRunId: String(job.id ?? 'unknown'),
        attempt: job.attemptsMade + 1,
        maximumAttempts: job.opts?.attempts ?? 1,
        summarize: (result) =>
          'skipped' in result
            ? {
                inputCount: 0,
                outputCount: 0,
                rejectedCount: 0,
                metrics: { skipped: true },
              }
            : {
                inputCount: 1,
                outputCount: result.messageCount,
                rejectedCount: result.skippedMessageCount,
                metrics: {
                  channelCount: result.channelCount,
                  userCount: result.userCount,
                  threadCount: result.threadCount,
                  syncMode: result.syncMode,
                  createdMessageCount: result.createdMessageCount,
                  updatedMessageCount: result.updatedMessageCount,
                  deletedMessageCount: result.deletedMessageCount,
                  incrementalTargetCount: result.incrementalTargetCount,
                  ignoredTombstoneCount: result.ignoredTombstoneCount,
                  ignoredStaleUpdateCount: result.ignoredStaleUpdateCount,
                  duplicateIncomingCount: result.duplicateIncomingCount,
                  warningCount: result.warningCount,
                },
              },
      },
      ({ pipelineRunId }) => this.processTracked(job, pipelineRunId),
    );
  }

  /** 실제 Slack 정규화. 바깥 wrapper가 실행 상태를 기록한다. */
  private async processTracked(
    job: Job<SlackImportJobData>,
    pipelineRunId: string,
  ): Promise<SlackImportJobResult> {
    const { sourceItemId, slackWorkspaceId } = job.data;
    const syncMode = job.data.syncMode ?? 'merge';

    if (!sourceItemId || !slackWorkspaceId) {
      // 방어: payload 결손은 재시도해도 무의미하므로 즉시 실패시킨다(민감정보 없음).
      this.logger.warn(
        { jobId: job.id, queue: job.queueName },
        'slack-import job missing sourceItemId/slackWorkspaceId',
      );
      throw new Error(
        'slack-import job payload is missing sourceItemId or slackWorkspaceId',
      );
    }
    if (syncMode !== 'merge' && syncMode !== 'snapshot') {
      throw new Error('slack-import syncMode is unsupported');
    }

    const [sourceItem] = await this.db
      .select({
        id: schema.sourceItems.id,
        objectKey: schema.sourceItems.objectKey,
        currentRevisionId: schema.sourceItems.currentRevisionId,
        deletedAt: schema.sourceItems.deletedAt,
      })
      .from(schema.sourceItems)
      .where(eq(schema.sourceItems.id, sourceItemId))
      .limit(1);

    if (!sourceItem || sourceItem.deletedAt !== null) {
      // 레코드 미존재(삭제/경합) — import 대상 없음. 로그 후 정상 종료.
      this.logger.warn(
        { jobId: job.id, sourceItemId, queue: job.queueName },
        'source item unavailable or tombstoned; skipping slack import',
      );
      return { sourceItemId, skipped: true };
    }
    if (sourceItem.currentRevisionId === null) {
      throw new Error('slack source item has no current revision');
    }

    // MinIO에서 원문 번들을 읽어 파싱한다. 원문 text·PII·secret은 로그에 남기지 않는다.
    const raw = await this.storage.getObject(sourceItem.objectKey);
    let bundle: unknown;
    try {
      bundle = JSON.parse(raw.toString('utf8'));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'invalid JSON';
      throw new Error(
        `slack bundle is not valid JSON (sourceItemId=${sourceItemId}): ${message}`,
      );
    }

    // 구조 검증·정규화·스레드 그룹핑은 순수 파서가 담당한다(형식 오류는 throw).
    const parsed = parseSlackExport(bundle);
    const now = new Date();

    const counts = await this.db.transaction(async (tx) => {
      // 같은 workspace의 import끼리 직렬화하고 API mutation과는 message lock으로 조정한다.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`slack-import:${slackWorkspaceId}`}))`,
      );
      const [workspaceState] = await tx
        .select({
          workspaceId: schema.slackWorkspaces.workspaceId,
          lastImportedAt: schema.slackWorkspaces.lastImportedAt,
        })
        .from(schema.slackWorkspaces)
        .where(eq(schema.slackWorkspaces.id, slackWorkspaceId))
        .limit(1);
      if (!workspaceState) {
        throw new Error('slack workspace not found during import');
      }
      const isInitialImport = workspaceState.lastImportedAt === null;

      /* ---------------------------------------------------------------- */
      /* 1) 채널·사용자 metadata upsert와 RAG 영향 범위 식별                 */
      /* ---------------------------------------------------------------- */
      const existingChannels = await tx
        .select({
          id: schema.slackChannels.id,
          slackChannelId: schema.slackChannels.slackChannelId,
          name: schema.slackChannels.name,
        })
        .from(schema.slackChannels)
        .where(eq(schema.slackChannels.slackWorkspaceId, slackWorkspaceId));
      const existingChannelBySlackId = new Map(
        existingChannels.map((channel) => [channel.slackChannelId, channel]),
      );
      const uniqueChannels = new Map<
        string,
        { slackChannelId: string; name: string }
      >();
      for (const channel of parsed.channels) {
        uniqueChannels.set(channel.slackChannelId, channel);
      }
      const changedChannelIds = new Set<string>();
      const channelIdBySlackId = new Map<string, string>();
      for (const channel of uniqueChannels.values()) {
        const existing = existingChannelBySlackId.get(channel.slackChannelId);
        const [row] = await tx
          .insert(schema.slackChannels)
          .values({
            slackWorkspaceId,
            slackChannelId: channel.slackChannelId,
            name: channel.name,
          })
          .onConflictDoUpdate({
            target: [
              schema.slackChannels.slackWorkspaceId,
              schema.slackChannels.slackChannelId,
            ],
            set: { name: channel.name, updatedAt: now },
          })
          .returning({
            id: schema.slackChannels.id,
            slackChannelId: schema.slackChannels.slackChannelId,
          });
        if (row) {
          channelIdBySlackId.set(row.slackChannelId, row.id);
          if (existing !== undefined && existing.name !== channel.name) {
            changedChannelIds.add(row.id);
          }
        }
      }

      const existingUsers = await tx
        .select({
          slackUserId: schema.slackUsers.slackUserId,
          name: schema.slackUsers.name,
        })
        .from(schema.slackUsers)
        .where(eq(schema.slackUsers.slackWorkspaceId, slackWorkspaceId));
      const existingUserBySlackId = new Map(
        existingUsers.map((user) => [user.slackUserId, user]),
      );
      const uniqueUsers = new Map<
        string,
        { slackUserId: string; name: string; realName: string | null }
      >();
      for (const user of parsed.users) {
        uniqueUsers.set(user.slackUserId, {
          slackUserId: user.slackUserId,
          name: user.name,
          realName: user.realName ?? null,
        });
      }
      const changedSlackUserIds = new Set<string>();
      const userRows = [...uniqueUsers.values()].map((user) => {
        const existing = existingUserBySlackId.get(user.slackUserId);
        if (
          !isInitialImport &&
          (existing === undefined || existing.name !== user.name)
        ) {
          changedSlackUserIds.add(user.slackUserId);
        }
        return {
          slackWorkspaceId,
          slackUserId: user.slackUserId,
          name: user.name,
          realName: user.realName,
        };
      });
      for (let i = 0; i < userRows.length; i += BATCH_SIZE) {
        await tx
          .insert(schema.slackUsers)
          .values(userRows.slice(i, i + BATCH_SIZE))
          .onConflictDoUpdate({
            target: [
              schema.slackUsers.slackWorkspaceId,
              schema.slackUsers.slackUserId,
            ],
            set: {
              name: sql`excluded.name`,
              realName: sql`excluded.real_name`,
              updatedAt: now,
            },
          });
      }

      /* ---------------------------------------------------------------- */
      /* 2) 수신/current 메시지 비교 후 projection 원자적 갱신               */
      /* ---------------------------------------------------------------- */
      let skippedMessageCount = 0;
      const incomingMessages: IncomingSlackMessageProjection[] = [];
      for (const message of parsed.messages) {
        const channelUuid = channelIdBySlackId.get(message.slackChannelId);
        if (!channelUuid) {
          skippedMessageCount += 1;
          continue;
        }
        incomingMessages.push({
          slackChannelId: channelUuid,
          slackUserId: message.slackUserId,
          ts: message.ts,
          threadTs: message.threadTs,
          text: message.text,
          editedTs: message.editedTs,
          occurredAt: message.occurredAt,
        });
      }

      const snapshotChannelIds = new Set(channelIdBySlackId.values());
      const currentMessageColumns = {
        id: schema.slackMessages.id,
        slackChannelId: schema.slackMessages.slackChannelId,
        slackUserId: schema.slackMessages.slackUserId,
        ts: schema.slackMessages.ts,
        threadTs: schema.slackMessages.threadTs,
        text: schema.slackMessages.text,
        editedTs: schema.slackMessages.editedTs,
        occurredAt: schema.slackMessages.occurredAt,
        deletedAt: schema.slackMessages.deletedAt,
      };
      let currentMessages: CurrentSlackMessageProjection[] = [];
      if (snapshotChannelIds.size > 0) {
        currentMessages = await tx
          .select(currentMessageColumns)
          .from(schema.slackMessages)
          .where(
            and(
              eq(schema.slackMessages.slackWorkspaceId, slackWorkspaceId),
              inArray(
                schema.slackMessages.slackChannelId,
                [...snapshotChannelIds],
              ),
            ),
          );
        for (const messageId of currentMessages
          .map((message) => message.id)
          .sort()) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`slack-message:${messageId}`}))`,
          );
        }
        // message lock 대기 중 발생한 API 변경까지 반영해 change-set을 다시 계산한다.
        currentMessages = await tx
          .select(currentMessageColumns)
          .from(schema.slackMessages)
          .where(
            and(
              eq(schema.slackMessages.slackWorkspaceId, slackWorkspaceId),
              inArray(
                schema.slackMessages.slackChannelId,
                [...snapshotChannelIds],
              ),
            ),
          );
      }

      const reconciliation = reconcileSlackMessages({
        syncMode,
        incoming: incomingMessages,
        current: currentMessages,
        snapshotChannelIds,
      });
      for (let i = 0; i < reconciliation.created.length; i += BATCH_SIZE) {
        await tx
          .insert(schema.slackMessages)
          .values(
            reconciliation.created.slice(i, i + BATCH_SIZE).map((message) => ({
              slackWorkspaceId,
              slackChannelId: message.slackChannelId,
              slackUserId: message.slackUserId,
              ts: message.ts,
              threadTs: message.threadTs,
              text: message.text,
              editedTs: message.editedTs,
              occurredAt: message.occurredAt,
              sourceItemId,
            })),
          )
          .onConflictDoNothing({
            target: [
              schema.slackMessages.slackChannelId,
              schema.slackMessages.ts,
            ],
          });
      }
      for (const update of reconciliation.updated) {
        await tx
          .update(schema.slackMessages)
          .set({
            slackUserId: update.incoming.slackUserId,
            threadTs: update.incoming.threadTs,
            text: update.incoming.text,
            editedTs: update.incoming.editedTs,
            occurredAt: update.incoming.occurredAt,
            sourceItemId,
            updatedAt: now,
          })
          .where(eq(schema.slackMessages.id, update.id));
      }
      if (reconciliation.deleted.length > 0) {
        await tx
          .update(schema.slackMessages)
          .set({ text: '', deletedAt: now, updatedAt: now })
          .where(
            inArray(
              schema.slackMessages.id,
              reconciliation.deleted.map((message) => message.id),
            ),
          );
      }

      /* ---------------------------------------------------------------- */
      /* 3) 변경 target dedupe와 영향 스레드 projection 재계산               */
      /* ---------------------------------------------------------------- */
      const targets = new Map<string, IncrementalTarget>();
      for (const message of reconciliation.created) {
        addTarget(targets, message, 'created');
      }
      for (const update of reconciliation.updated) {
        addTarget(targets, update.previous, 'edited');
        addTarget(targets, update.incoming, 'edited');
      }
      for (const message of reconciliation.deleted) {
        addTarget(targets, message, 'deleted');
      }

      if (changedChannelIds.size > 0) {
        const rows = await tx
          .select({
            ts: schema.slackMessages.ts,
            threadTs: schema.slackMessages.threadTs,
          })
          .from(schema.slackMessages)
          .where(
            and(
              eq(schema.slackMessages.slackWorkspaceId, slackWorkspaceId),
              inArray(
                schema.slackMessages.slackChannelId,
                [...changedChannelIds],
              ),
              isNull(schema.slackMessages.deletedAt),
            ),
          );
        for (const message of rows) {
          addTarget(targets, message, 'edited');
        }
      }
      if (changedSlackUserIds.size > 0) {
        const rows = await tx
          .select({
            ts: schema.slackMessages.ts,
            threadTs: schema.slackMessages.threadTs,
          })
          .from(schema.slackMessages)
          .where(
            and(
              eq(schema.slackMessages.slackWorkspaceId, slackWorkspaceId),
              inArray(
                schema.slackMessages.slackUserId,
                [...changedSlackUserIds],
              ),
              isNull(schema.slackMessages.deletedAt),
            ),
          );
        for (const message of rows) {
          addTarget(targets, message, 'edited');
        }
      }

      const threadTargets = [...targets.values()]
        .filter((target) => target.sourceType === 'slack_thread')
        .map((target) => target.sourceRefId)
        .sort();
      let rebuiltThreadCount = 0;
      for (const threadTs of threadTargets) {
        await tx
          .delete(schema.slackThreads)
          .where(
            and(
              eq(schema.slackThreads.slackWorkspaceId, slackWorkspaceId),
              eq(schema.slackThreads.threadTs, threadTs),
            ),
          );
        const activeMessages = await tx
          .select({
            slackChannelId: schema.slackMessages.slackChannelId,
            ts: schema.slackMessages.ts,
            occurredAt: schema.slackMessages.occurredAt,
          })
          .from(schema.slackMessages)
          .where(
            and(
              eq(schema.slackMessages.slackWorkspaceId, slackWorkspaceId),
              eq(schema.slackMessages.threadTs, threadTs),
              isNull(schema.slackMessages.deletedAt),
            ),
          );
        const byChannel = new Map<string, typeof activeMessages>();
        for (const message of activeMessages) {
          const messages = byChannel.get(message.slackChannelId) ?? [];
          messages.push(message);
          byChannel.set(message.slackChannelId, messages);
        }
        const threadRows = [...byChannel.entries()].map(
          ([slackChannelId, messages]) => {
            const ordered = [...messages].sort((left, right) =>
              compareTs(left.ts, right.ts),
            );
            const lastReplyAt = ordered.reduce(
              (latest, message) =>
                message.occurredAt > latest ? message.occurredAt : latest,
              ordered[0].occurredAt,
            );
            return {
              slackWorkspaceId,
              slackChannelId,
              threadTs,
              rootTs: ordered[0].ts,
              replyCount: ordered.filter((message) => message.ts !== threadTs)
                .length,
              lastReplyAt,
            };
          },
        );
        if (threadRows.length > 0) {
          await tx.insert(schema.slackThreads).values(threadRows);
          rebuiltThreadCount += threadRows.length;
        }
      }

      /* ---------------------------------------------------------------- */
      /* 4) 첫 import는 전체 build, 이후에는 target event만 발행             */
      /* ---------------------------------------------------------------- */
      await tx
        .update(schema.slackWorkspaces)
        .set({ lastImportedAt: now, updatedAt: now })
        .where(eq(schema.slackWorkspaces.id, slackWorkspaceId));

      if (isInitialImport) {
        await tx
          .insert(schema.dataEvents)
          .values({
            aggregateType: 'slack_workspace',
            aggregateId: slackWorkspaceId,
            eventType: OUTBOX_EVENT_TYPES.SLACK_NORMALIZED,
            revisionId: sourceItem.currentRevisionId,
            workspaceId: workspaceState.workspaceId,
            payload: { workspaceId: workspaceState.workspaceId },
            producerPipelineRunId: pipelineRunId,
            occurredAt: now,
          })
          .onConflictDoNothing();
      } else {
        for (const target of [...targets.values()].sort((left, right) =>
          `${left.sourceType}:${left.sourceRefId}`.localeCompare(
            `${right.sourceType}:${right.sourceRefId}`,
          ),
        )) {
          const eventId = randomUUID();
          await tx
            .insert(schema.dataEvents)
            .values({
              id: eventId,
              aggregateType: 'slack_chunk_target',
              aggregateId: `${target.sourceType}:${target.sourceRefId}`,
              eventType: OUTBOX_EVENT_TYPES.SLACK_MESSAGE_CHANGED,
              revisionId: sourceItem.currentRevisionId,
              workspaceId: workspaceState.workspaceId,
              payload: {
                workspaceId: workspaceState.workspaceId,
                sourceType: target.sourceType,
                sourceRefId: target.sourceRefId,
                changeType: target.changeType,
                changeEventId: eventId,
              },
              producerPipelineRunId: pipelineRunId,
              occurredAt: now,
            })
            .onConflictDoNothing();
        }
      }

      return {
        channelCount: channelIdBySlackId.size,
        userCount: userRows.length,
        messageCount: incomingMessages.length,
        threadCount: rebuiltThreadCount,
        createdMessageCount: reconciliation.created.length,
        updatedMessageCount: reconciliation.updated.length,
        deletedMessageCount: reconciliation.deleted.length,
        incrementalTargetCount: isInitialImport ? 0 : targets.size,
        ignoredTombstoneCount: reconciliation.ignoredTombstoneCount,
        ignoredStaleUpdateCount: reconciliation.ignoredStaleUpdateCount,
        duplicateIncomingCount: reconciliation.duplicateIncomingCount,
        skippedMessageCount,
      };
    });

    // 로그는 식별자/count만(원문·PII·secret·경고 원문 미기록, 스펙 §1/§6).
    this.logger.info(
      {
        jobId: job.id,
        sourceItemId,
        slackWorkspaceId,
        syncMode,
        channelCount: counts.channelCount,
        userCount: counts.userCount,
        messageCount: counts.messageCount,
        threadCount: counts.threadCount,
        createdMessageCount: counts.createdMessageCount,
        updatedMessageCount: counts.updatedMessageCount,
        deletedMessageCount: counts.deletedMessageCount,
        incrementalTargetCount: counts.incrementalTargetCount,
        ignoredTombstoneCount: counts.ignoredTombstoneCount,
        ignoredStaleUpdateCount: counts.ignoredStaleUpdateCount,
        duplicateIncomingCount: counts.duplicateIncomingCount,
        skippedMessageCount: counts.skippedMessageCount,
        warningCount: parsed.warnings.length,
      },
      'slack export imported',
    );

    return {
      sourceItemId,
      slackWorkspaceId,
      syncMode,
      channelCount: counts.channelCount,
      userCount: counts.userCount,
      messageCount: counts.messageCount,
      threadCount: counts.threadCount,
      createdMessageCount: counts.createdMessageCount,
      updatedMessageCount: counts.updatedMessageCount,
      deletedMessageCount: counts.deletedMessageCount,
      incrementalTargetCount: counts.incrementalTargetCount,
      ignoredTombstoneCount: counts.ignoredTombstoneCount,
      ignoredStaleUpdateCount: counts.ignoredStaleUpdateCount,
      duplicateIncomingCount: counts.duplicateIncomingCount,
      skippedMessageCount: counts.skippedMessageCount,
      warningCount: parsed.warnings.length,
    };
  }
}
