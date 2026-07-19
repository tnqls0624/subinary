/** Slack 메시지 편집·삭제를 current projection과 outbox revision에 원자적으로 기록한다. */
import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import type {
  SlackMessageChangeResponse,
  SlackMessageEditRequest,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { OUTBOX_EVENT_TYPES } from '@family/shared';

import { DB } from '../database/database.constants';

type SlackMessageChangeType = 'edited' | 'deleted';
type SlackChunkSourceType = 'slack_thread' | 'slack_message';
type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

interface MutableMessage {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  ts: string;
  threadTs: string | null;
  text: string;
  editedTs: string | null;
  deletedAt: Date | null;
}

@Injectable()
export class SlackMessageMutationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 소유자의 메시지 편집을 target RAG 증분 event로 발행한다. */
  async editMessage(
    userId: string,
    messageId: string,
    input: SlackMessageEditRequest,
  ): Promise<SlackMessageChangeResponse> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`slack-message:${messageId}`}))`,
      );
      const message = await this.requireOwnedMessage(tx, userId, messageId);
      if (message.deletedAt !== null) {
        throw new ConflictException('deleted slack message cannot be edited');
      }
      if (
        message.text === input.text &&
        (input.editedTs === undefined || message.editedTs === input.editedTs)
      ) {
        throw new ConflictException('slack message edit has no changes');
      }
      const editedTs = input.editedTs ?? this.toSlackTs(new Date());
      const changedAt = new Date();
      await tx
        .update(schema.slackMessages)
        .set({ text: input.text, editedTs, updatedAt: changedAt })
        .where(eq(schema.slackMessages.id, messageId));
      return this.insertChangeEvent(tx, {
        messageId,
        workspaceId: message.workspaceId,
        ts: message.ts,
        threadTs: message.threadTs,
        changeType: 'edited',
        changedAt,
      });
    });
  }

  /** 소유자의 메시지를 tombstone 처리하고 target RAG 삭제 event를 발행한다. */
  async deleteMessage(
    userId: string,
    messageId: string,
  ): Promise<SlackMessageChangeResponse> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`slack-message:${messageId}`}))`,
      );
      const message = await this.requireOwnedMessage(tx, userId, messageId);
      if (message.deletedAt !== null) {
        const existing = await this.findDeleteEvent(tx, messageId);
        if (!existing) {
          throw new ConflictException('deleted slack message has no change event');
        }
        return {
          messageId,
          eventId: existing.id,
          operation: 'deleted',
          status: 'queued',
          changedAt: existing.occurredAt.toISOString(),
        };
      }
      const changedAt = new Date();
      await tx
        .update(schema.slackMessages)
        .set({ text: '', deletedAt: changedAt, updatedAt: changedAt })
        .where(eq(schema.slackMessages.id, messageId));
      return this.insertChangeEvent(tx, {
        messageId,
        workspaceId: message.workspaceId,
        ts: message.ts,
        threadTs: message.threadTs,
        changeType: 'deleted',
        changedAt,
      });
    });
  }

  private async requireOwnedMessage(
    tx: DbTransaction,
    userId: string,
    messageId: string,
  ): Promise<MutableMessage> {
    const [message] = await tx
      .select({
        id: schema.slackMessages.id,
        workspaceId: schema.slackWorkspaces.workspaceId,
        ownerUserId: schema.workspaces.ownerUserId,
        ts: schema.slackMessages.ts,
        threadTs: schema.slackMessages.threadTs,
        text: schema.slackMessages.text,
        editedTs: schema.slackMessages.editedTs,
        deletedAt: schema.slackMessages.deletedAt,
      })
      .from(schema.slackMessages)
      .innerJoin(
        schema.slackWorkspaces,
        eq(
          schema.slackMessages.slackWorkspaceId,
          schema.slackWorkspaces.id,
        ),
      )
      .innerJoin(
        schema.workspaces,
        eq(schema.slackWorkspaces.workspaceId, schema.workspaces.id),
      )
      .where(eq(schema.slackMessages.id, messageId))
      .limit(1);
    if (!message) {
      throw new NotFoundException('slack message not found');
    }
    if (message.ownerUserId !== userId) {
      throw new ForbiddenException('not the workspace owner');
    }
    return message;
  }

  private async insertChangeEvent(
    tx: DbTransaction,
    change: {
      messageId: string;
      workspaceId: string;
      ts: string;
      threadTs: string | null;
      changeType: SlackMessageChangeType;
      changedAt: Date;
    },
  ): Promise<SlackMessageChangeResponse> {
    const eventId = randomUUID();
    const sourceType: SlackChunkSourceType =
      change.threadTs === null ? 'slack_message' : 'slack_thread';
    const sourceRefId = change.threadTs ?? change.ts;
    await tx.insert(schema.dataEvents).values({
      id: eventId,
      aggregateType: 'slack_message',
      aggregateId: change.messageId,
      eventType: OUTBOX_EVENT_TYPES.SLACK_MESSAGE_CHANGED,
      revisionId: eventId,
      workspaceId: change.workspaceId,
      payload: {
        workspaceId: change.workspaceId,
        sourceType,
        sourceRefId,
        changeType: change.changeType,
        changeEventId: eventId,
      },
      occurredAt: change.changedAt,
    });
    return {
      messageId: change.messageId,
      eventId,
      operation: change.changeType,
      status: 'queued',
      changedAt: change.changedAt.toISOString(),
    };
  }

  private async findDeleteEvent(
    tx: DbTransaction,
    messageId: string,
  ): Promise<{ id: string; occurredAt: Date } | null> {
    const rows = await tx
      .select({
        id: schema.dataEvents.id,
        occurredAt: schema.dataEvents.occurredAt,
        payload: schema.dataEvents.payload,
      })
      .from(schema.dataEvents)
      .where(
        and(
          eq(schema.dataEvents.aggregateType, 'slack_message'),
          eq(schema.dataEvents.aggregateId, messageId),
          eq(
            schema.dataEvents.eventType,
            OUTBOX_EVENT_TYPES.SLACK_MESSAGE_CHANGED,
          ),
        ),
      )
      .orderBy(desc(schema.dataEvents.occurredAt));
    const match = rows.find((row) => row.payload.changeType === 'deleted');
    return match ? { id: match.id, occurredAt: match.occurredAt } : null;
  }

  private toSlackTs(value: Date): string {
    const seconds = Math.floor(value.getTime() / 1_000);
    const micros = String((value.getTime() % 1_000) * 1_000).padStart(6, '0');
    return `${seconds}.${micros}`;
  }
}
