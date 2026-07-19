import { QUEUE_NAMES } from './constants.js';

/** 현재 dispatcher가 지원하는 versioned outbox event 종류. */
export const OUTBOX_EVENT_TYPES = {
  SOURCE_SLACK_RECEIVED: 'source.slack.received.v1',
  SOURCE_CARD_SMS_RECEIVED: 'source.card_sms.received.v1',
  SOURCE_TOMBSTONED: 'source.tombstoned.v1',
  SLACK_NORMALIZED: 'slack.normalized.v1',
  SLACK_MESSAGE_CHANGED: 'slack.message.changed.v1',
  RAG_CHUNK_MEMORY_READY: 'rag.chunk.memory-ready.v1',
  RAG_CHUNK_GRAPH_READY: 'rag.chunk.graph-ready.v1',
} as const;

export type OutboxEventType =
  (typeof OUTBOX_EVENT_TYPES)[keyof typeof OUTBOX_EVENT_TYPES];

/** outbox payload나 event type이 consumer 계약과 맞지 않을 때의 결정적 오류. */
export class OutboxPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxPayloadError';
  }
}

/** dispatcher가 BullMQ에 전달할 검증된 route. */
export type OutboxQueueRoute =
  | {
      queueName: typeof QUEUE_NAMES.SLACK_IMPORT;
      jobName: 'import';
      jobData: {
        sourceItemId: string;
        slackWorkspaceId: string;
        syncMode: 'merge' | 'snapshot';
      };
    }
  | {
      queueName: typeof QUEUE_NAMES.CARD_SMS_PARSE;
      jobName: 'parse';
      jobData: { cardSmsEventId: string };
    }
  | {
      queueName: typeof QUEUE_NAMES.RAG_INDEX;
      jobName: 'index';
      jobData:
        | { workspaceId: string }
        | {
            workspaceId: string;
            sourceType: 'slack_thread' | 'slack_message';
            sourceRefId: string;
            changeType: 'created' | 'edited' | 'deleted';
            changeEventId: string;
          };
    }
  | {
      queueName: typeof QUEUE_NAMES.SOURCE_TOMBSTONE;
      jobName: 'propagate';
      jobData: { sourceItemId: string };
    }
  | {
      queueName:
        | typeof QUEUE_NAMES.MEMORY_EXTRACT
        | typeof QUEUE_NAMES.GRAPH_EXTRACT;
      jobName: 'extract';
      jobData: {
        workspaceId: string;
        chunkId: string;
        chunkRevisionId: string;
      };
    };

function asPayloadRecord(payload: unknown): Record<string, unknown> {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new OutboxPayloadError('outbox payload must be a plain object');
  }
  return payload as Record<string, unknown>;
}

function requiredIdentifier(
  payload: Record<string, unknown>,
  field: string,
): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OutboxPayloadError(
      `outbox payload field "${field}" must be a non-empty string`,
    );
  }
  return value;
}

function requiredLiteral<T extends string>(
  payload: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = requiredIdentifier(payload, field);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new OutboxPayloadError(
      `outbox payload field "${field}" has an unsupported value`,
    );
  }
  return value as T;
}

function optionalLiteral<T extends string>(
  payload: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return payload[field] === undefined
    ? fallback
    : requiredLiteral(payload, field, allowed);
}

/** event type별 payload를 검증하고 정적 BullMQ route로 변환한다. */
export function resolveOutboxQueueRoute(
  eventType: string,
  payload: unknown,
): OutboxQueueRoute {
  const record = asPayloadRecord(payload);
  switch (eventType) {
    case OUTBOX_EVENT_TYPES.SOURCE_SLACK_RECEIVED:
      return {
        queueName: QUEUE_NAMES.SLACK_IMPORT,
        jobName: 'import',
        jobData: {
          sourceItemId: requiredIdentifier(record, 'sourceItemId'),
          slackWorkspaceId: requiredIdentifier(record, 'slackWorkspaceId'),
          syncMode: optionalLiteral(
            record,
            'syncMode',
            ['merge', 'snapshot'] as const,
            'merge',
          ),
        },
      };
    case OUTBOX_EVENT_TYPES.SOURCE_CARD_SMS_RECEIVED:
      return {
        queueName: QUEUE_NAMES.CARD_SMS_PARSE,
        jobName: 'parse',
        jobData: {
          cardSmsEventId: requiredIdentifier(record, 'cardSmsEventId'),
        },
      };
    case OUTBOX_EVENT_TYPES.SLACK_NORMALIZED:
      return {
        queueName: QUEUE_NAMES.RAG_INDEX,
        jobName: 'index',
        jobData: {
          workspaceId: requiredIdentifier(record, 'workspaceId'),
        },
      };
    case OUTBOX_EVENT_TYPES.SLACK_MESSAGE_CHANGED:
      return {
        queueName: QUEUE_NAMES.RAG_INDEX,
        jobName: 'index',
        jobData: {
          workspaceId: requiredIdentifier(record, 'workspaceId'),
          sourceType: requiredLiteral(record, 'sourceType', [
            'slack_thread',
            'slack_message',
          ] as const),
          sourceRefId: requiredIdentifier(record, 'sourceRefId'),
          changeType: requiredLiteral(record, 'changeType', [
            'created',
            'edited',
            'deleted',
          ] as const),
          changeEventId: requiredIdentifier(record, 'changeEventId'),
        },
      };
    case OUTBOX_EVENT_TYPES.SOURCE_TOMBSTONED:
      return {
        queueName: QUEUE_NAMES.SOURCE_TOMBSTONE,
        jobName: 'propagate',
        jobData: {
          sourceItemId: requiredIdentifier(record, 'sourceItemId'),
        },
      };
    case OUTBOX_EVENT_TYPES.RAG_CHUNK_MEMORY_READY:
      return {
        queueName: QUEUE_NAMES.MEMORY_EXTRACT,
        jobName: 'extract',
        jobData: {
          workspaceId: requiredIdentifier(record, 'workspaceId'),
          chunkId: requiredIdentifier(record, 'chunkId'),
          chunkRevisionId: requiredIdentifier(record, 'chunkRevisionId'),
        },
      };
    case OUTBOX_EVENT_TYPES.RAG_CHUNK_GRAPH_READY:
      return {
        queueName: QUEUE_NAMES.GRAPH_EXTRACT,
        jobName: 'extract',
        jobData: {
          workspaceId: requiredIdentifier(record, 'workspaceId'),
          chunkId: requiredIdentifier(record, 'chunkId'),
          chunkRevisionId: requiredIdentifier(record, 'chunkRevisionId'),
        },
      };
    default:
      throw new OutboxPayloadError(`unsupported outbox event type: ${eventType}`);
  }
}

/** BullMQ custom job id에 안전한 outbox event 기반 멱등 키를 만든다. */
export function createOutboxJobId(eventId: string): string {
  if (
    eventId.trim().length === 0 ||
    eventId.includes(':') ||
    !/^[A-Za-z0-9_-]+$/.test(eventId)
  ) {
    throw new OutboxPayloadError('outbox event id is not BullMQ job-id safe');
  }
  return `outbox_${eventId}`;
}

/** publish 시도 횟수에 따른 capped exponential backoff를 계산한다. */
export function calculateOutboxRetryDelayMs(
  nextAttempt: number,
  baseDelayMs = 1_000,
  maxDelayMs = 300_000,
): number {
  if (!Number.isInteger(nextAttempt) || nextAttempt < 1) {
    throw new Error('outbox next attempt must be a positive integer');
  }
  if (
    !Number.isInteger(baseDelayMs) ||
    baseDelayMs < 1 ||
    !Number.isInteger(maxDelayMs) ||
    maxDelayMs < baseDelayMs
  ) {
    throw new Error('outbox retry delay bounds are invalid');
  }
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (nextAttempt - 1));
}
