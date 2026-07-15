/**
 * Slack export import processor (Phase 6 Build Spec §6).
 *
 * Consumes the `slack-import` queue. For each job it loads the raw JSON bundle
 * from MinIO (persisted by the API on upload), runs the pure
 * `@family/slack-parser`, and persists the normalized channels / users /
 * messages / threads in a single transaction.
 *
 * Idempotency (spec §1.3): `slack_channels` / `slack_users` use
 * `onConflictDoUpdate` (name refresh) and `slack_messages` use
 * `onConflictDoNothing` on `UNIQUE(slackChannelId, ts)`, so re-importing the
 * same bundle never stores duplicate messages. `slack_threads` are recomputed
 * and upserted.
 *
 * Channel-id mapping (spec §6 note): the parser emits Slack channel-id strings
 * (e.g. "C1"). Messages/threads reference `slack_channels.id` (uuid), so
 * channels are upserted first and a `slackChannelId → uuid` map is built before
 * inserting messages/threads.
 *
 * Secret hygiene (spec §1/§6): message text, PII, secrets and tokens are never
 * logged — only counts and identifiers.
 */
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import { schema, type Db } from '@family/database';
import { createLogger, QUEUE_NAMES } from '@family/shared';
import { parseSlackExport } from '@family/slack-parser';
import type { Job, Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';

import { DB } from '../database/database.module';
import { ObjectStorageService } from '../storage/object-storage.service';

/** slack-import 잡 payload(스펙 §5.2/§6: { sourceItemId, slackWorkspaceId }). */
interface SlackImportJobData {
  sourceItemId: string;
  slackWorkspaceId: string;
}

/** 잡 결과. 정상 import는 count 집계, source_item 미존재는 skipped 로 구분한다. */
type SlackImportJobResult =
  | {
      sourceItemId: string;
      slackWorkspaceId: string;
      channelCount: number;
      userCount: number;
      messageCount: number;
      threadCount: number;
      skippedMessageCount: number;
      warningCount: number;
    }
  | { sourceItemId: string; skipped: true };

/**
 * 대량 insert 시 Postgres 파라미터 상한(65535)을 넘지 않도록 나누는 배치 크기.
 * 메시지 한 행당 컬럼 수를 고려한 보수적 값이다.
 */
const BATCH_SIZE = 500;

@Processor(QUEUE_NAMES.SLACK_IMPORT)
export class SlackImportProcessor extends WorkerHost {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
    // import 성공 후 RAG 인덱싱을 트리거하기 위한 rag-index 큐(스펙 §5).
    @InjectQueue(QUEUE_NAMES.RAG_INDEX) private readonly ragIndexQueue: Queue,
    configService: ConfigService,
  ) {
    super();
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:slack-import-processor', {
      pretty: nodeEnv !== 'production',
    });
  }

  async process(job: Job<SlackImportJobData>): Promise<SlackImportJobResult> {
    const { sourceItemId, slackWorkspaceId } = job.data;

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

    const [sourceItem] = await this.db
      .select({
        id: schema.sourceItems.id,
        objectKey: schema.sourceItems.objectKey,
      })
      .from(schema.sourceItems)
      .where(eq(schema.sourceItems.id, sourceItemId))
      .limit(1);

    if (!sourceItem) {
      // 레코드 미존재(삭제/경합) — import 대상 없음. 로그 후 정상 종료.
      this.logger.warn(
        { jobId: job.id, sourceItemId, queue: job.queueName },
        'source item not found; skipping slack import',
      );
      return { sourceItemId, skipped: true };
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
      /* ---------------------------------------------------------------- */
      /* 1) 채널 upsert → Slack 채널 id 문자열 → slack_channels.id(uuid) 매핑  */
      /* ---------------------------------------------------------------- */
      // 번들 내 동일 slackChannelId 중복 방어(배치 DO UPDATE의 "affect row twice" 회피).
      const uniqueChannels = new Map<string, { slackChannelId: string; name: string }>();
      for (const channel of parsed.channels) {
        uniqueChannels.set(channel.slackChannelId, channel);
      }

      const channelIdBySlackId = new Map<string, string>();
      for (const channel of uniqueChannels.values()) {
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
        }
      }

      /* ---------------------------------------------------------------- */
      /* 2) 사용자 upsert(이름/실명 갱신)                                    */
      /* ---------------------------------------------------------------- */
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
      const userRows = [...uniqueUsers.values()].map((u) => ({
        slackWorkspaceId,
        slackUserId: u.slackUserId,
        name: u.name,
        realName: u.realName,
      }));
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
      /* 3) 메시지 insert(멱등: UNIQUE(slackChannelId, ts) onConflictDoNothing) */
      /* ---------------------------------------------------------------- */
      let skippedMessageCount = 0;
      const messageRows: (typeof schema.slackMessages.$inferInsert)[] = [];
      for (const message of parsed.messages) {
        const channelUuid = channelIdBySlackId.get(message.slackChannelId);
        if (!channelUuid) {
          // 채널 매핑 실패(파서가 걸러야 하지만 방어). 건너뛰고 카운트만 남긴다.
          skippedMessageCount += 1;
          continue;
        }
        messageRows.push({
          slackWorkspaceId,
          slackChannelId: channelUuid,
          slackUserId: message.slackUserId,
          ts: message.ts,
          threadTs: message.threadTs,
          text: message.text,
          editedTs: message.editedTs,
          occurredAt: message.occurredAt,
          sourceItemId,
        });
      }
      for (let i = 0; i < messageRows.length; i += BATCH_SIZE) {
        await tx
          .insert(schema.slackMessages)
          .values(messageRows.slice(i, i + BATCH_SIZE))
          .onConflictDoNothing({
            target: [schema.slackMessages.slackChannelId, schema.slackMessages.ts],
          });
      }

      /* ---------------------------------------------------------------- */
      /* 4) 스레드 upsert(재계산: rootTs/replyCount/lastReplyAt 갱신)         */
      /* ---------------------------------------------------------------- */
      // (channelUuid, threadTs) 중복 방어(배치 DO UPDATE의 "affect row twice" 회피).
      const uniqueThreads = new Map<
        string,
        typeof schema.slackThreads.$inferInsert
      >();
      for (const thread of parsed.threads) {
        const channelUuid = channelIdBySlackId.get(thread.slackChannelId);
        if (!channelUuid) {
          continue;
        }
        uniqueThreads.set(`${channelUuid} ${thread.threadTs}`, {
          slackWorkspaceId,
          slackChannelId: channelUuid,
          threadTs: thread.threadTs,
          rootTs: thread.rootTs,
          replyCount: thread.replyCount,
          lastReplyAt: thread.lastReplyAt,
        });
      }
      const threadRows = [...uniqueThreads.values()];
      for (let i = 0; i < threadRows.length; i += BATCH_SIZE) {
        await tx
          .insert(schema.slackThreads)
          .values(threadRows.slice(i, i + BATCH_SIZE))
          .onConflictDoUpdate({
            target: [
              schema.slackThreads.slackChannelId,
              schema.slackThreads.threadTs,
            ],
            set: {
              rootTs: sql`excluded.root_ts`,
              replyCount: sql`excluded.reply_count`,
              lastReplyAt: sql`excluded.last_reply_at`,
              updatedAt: now,
            },
          });
      }

      /* ---------------------------------------------------------------- */
      /* 5) workspace.lastImportedAt 갱신                                   */
      /* ---------------------------------------------------------------- */
      // 범용 workspaces.id(= RAG 인덱싱 잡 payload)를 함께 회수한다.
      const [updatedWorkspace] = await tx
        .update(schema.slackWorkspaces)
        .set({ lastImportedAt: now, updatedAt: now })
        .where(eq(schema.slackWorkspaces.id, slackWorkspaceId))
        .returning({ workspaceId: schema.slackWorkspaces.workspaceId });

      return {
        workspaceId: updatedWorkspace?.workspaceId ?? null,
        channelCount: channelIdBySlackId.size,
        userCount: userRows.length,
        messageCount: messageRows.length,
        threadCount: threadRows.length,
        skippedMessageCount,
      };
    });

    // 로그는 식별자/count만(원문·PII·secret·경고 원문 미기록, 스펙 §1/§6).
    this.logger.info(
      {
        jobId: job.id,
        sourceItemId,
        slackWorkspaceId,
        channelCount: counts.channelCount,
        userCount: counts.userCount,
        messageCount: counts.messageCount,
        threadCount: counts.threadCount,
        skippedMessageCount: counts.skippedMessageCount,
        warningCount: parsed.warnings.length,
      },
      'slack export imported',
    );

    // import 성공 후 RAG 인덱싱을 enqueue한다(스펙 §5). jobId를 workspaceId 기반으로
    // 고정해 과다 enqueue를 흡수하고, 완료 잡은 재인덱싱을 위해 제거한다(removeOnComplete).
    // 주의: BullMQ 커스텀 jobId 에는 ':' 를 쓸 수 없다(Custom Id cannot contain :) —
    // 구분자로 밑줄을 사용한다. workspaceId 는 slack_workspaces.workspaceId(= workspaces.id).
    if (counts.workspaceId) {
      await this.ragIndexQueue.add(
        'index',
        { workspaceId: counts.workspaceId },
        { jobId: `rag-index_${counts.workspaceId}`, removeOnComplete: true },
      );
    }

    return {
      sourceItemId,
      slackWorkspaceId,
      channelCount: counts.channelCount,
      userCount: counts.userCount,
      messageCount: counts.messageCount,
      threadCount: counts.threadCount,
      skippedMessageCount: counts.skippedMessageCount,
      warningCount: parsed.warnings.length,
    };
  }
}
