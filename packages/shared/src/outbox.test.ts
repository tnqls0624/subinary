import { describe, expect, it } from 'vitest';

import { QUEUE_NAMES } from './constants.js';
import {
  calculateOutboxRetryDelayMs,
  createOutboxJobId,
  OUTBOX_EVENT_TYPES,
  OutboxPayloadError,
  resolveOutboxQueueRoute,
} from './outbox.js';

describe('resolveOutboxQueueRoute', () => {
  it('Slack source event를 import queue로 변환한다', () => {
    expect(
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SOURCE_SLACK_RECEIVED, {
        sourceItemId: 'source-1',
        slackWorkspaceId: 'slack-workspace-1',
      }),
    ).toEqual({
      queueName: QUEUE_NAMES.SLACK_IMPORT,
      jobName: 'import',
      jobData: {
        sourceItemId: 'source-1',
        slackWorkspaceId: 'slack-workspace-1',
        syncMode: 'merge',
      },
    });
  });

  it('명시적 snapshot import mode를 보존하고 잘못된 mode를 거부한다', () => {
    expect(
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SOURCE_SLACK_RECEIVED, {
        sourceItemId: 'source-1',
        slackWorkspaceId: 'slack-workspace-1',
        syncMode: 'snapshot',
      }),
    ).toMatchObject({ jobData: { syncMode: 'snapshot' } });
    expect(() =>
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SOURCE_SLACK_RECEIVED, {
        sourceItemId: 'source-1',
        slackWorkspaceId: 'slack-workspace-1',
        syncMode: 'replace-all',
      }),
    ).toThrow('unsupported value');
  });

  it('카드 문자와 Slack normalized event를 각각 올바른 queue로 변환한다', () => {
    expect(
      resolveOutboxQueueRoute(
        OUTBOX_EVENT_TYPES.SOURCE_CARD_SMS_RECEIVED,
        { cardSmsEventId: 'event-1' },
      ).queueName,
    ).toBe(QUEUE_NAMES.CARD_SMS_PARSE);
    expect(
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SLACK_NORMALIZED, {
        workspaceId: 'workspace-1',
      }).queueName,
    ).toBe(QUEUE_NAMES.RAG_INDEX);
  });

  it('source tombstone event를 privacy propagation queue로 변환한다', () => {
    expect(
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SOURCE_TOMBSTONED, {
        sourceItemId: 'source-1',
      }),
    ).toEqual({
      queueName: QUEUE_NAMES.SOURCE_TOMBSTONE,
      jobName: 'propagate',
      jobData: { sourceItemId: 'source-1' },
    });
  });

  it('Slack message change를 target RAG job으로 변환한다', () => {
    expect(
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SLACK_MESSAGE_CHANGED, {
        workspaceId: 'workspace-1',
        sourceType: 'slack_thread',
        sourceRefId: '1710000000.000001',
        changeType: 'deleted',
        changeEventId: 'event-1',
      }),
    ).toEqual({
      queueName: QUEUE_NAMES.RAG_INDEX,
      jobName: 'index',
      jobData: {
        workspaceId: 'workspace-1',
        sourceType: 'slack_thread',
        sourceRefId: '1710000000.000001',
        changeType: 'deleted',
        changeEventId: 'event-1',
      },
    });
  });

  it('Slack import가 만든 created target도 RAG job으로 변환한다', () => {
    expect(
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SLACK_MESSAGE_CHANGED, {
        workspaceId: 'workspace-1',
        sourceType: 'slack_message',
        sourceRefId: '1710000000.000002',
        changeType: 'created',
        changeEventId: 'event-2',
      }),
    ).toMatchObject({ jobData: { changeType: 'created' } });
  });

  it('발행된 chunk revision을 기억·그래프 target job으로 분기한다', () => {
    const payload = {
      workspaceId: 'workspace-1',
      chunkId: 'chunk-1',
      chunkRevisionId: 'revision-1',
    };

    expect(
      resolveOutboxQueueRoute(
        OUTBOX_EVENT_TYPES.RAG_CHUNK_MEMORY_READY,
        payload,
      ),
    ).toEqual({
      queueName: QUEUE_NAMES.MEMORY_EXTRACT,
      jobName: 'extract',
      jobData: payload,
    });
    expect(
      resolveOutboxQueueRoute(
        OUTBOX_EVENT_TYPES.RAG_CHUNK_GRAPH_READY,
        payload,
      ),
    ).toEqual({
      queueName: QUEUE_NAMES.GRAPH_EXTRACT,
      jobName: 'extract',
      jobData: payload,
    });
  });

  it('알 수 없는 event와 누락 payload를 결정적 오류로 거부한다', () => {
    expect(() => resolveOutboxQueueRoute('unknown.v1', {})).toThrow(
      OutboxPayloadError,
    );
    expect(() =>
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SOURCE_SLACK_RECEIVED, {
        sourceItemId: 'source-1',
      }),
    ).toThrow('slackWorkspaceId');
    expect(() =>
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SLACK_NORMALIZED, []),
    ).toThrow('plain object');
    expect(() =>
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SOURCE_TOMBSTONED, {}),
    ).toThrow('sourceItemId');
    expect(() =>
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.SLACK_MESSAGE_CHANGED, {
        workspaceId: 'workspace-1',
        sourceType: 'unknown',
        sourceRefId: '1.0',
        changeType: 'edited',
        changeEventId: 'event-1',
      }),
    ).toThrow('unsupported value');
    expect(() =>
      resolveOutboxQueueRoute(OUTBOX_EVENT_TYPES.RAG_CHUNK_MEMORY_READY, {
        workspaceId: 'workspace-1',
        chunkId: 'chunk-1',
      }),
    ).toThrow('chunkRevisionId');
  });
});

describe('outbox id와 retry', () => {
  it('BullMQ-safe 멱등 job id를 생성한다', () => {
    expect(createOutboxJobId('019f73eb-5e92-79e2')).toBe(
      'outbox_019f73eb-5e92-79e2',
    );
    expect(() => createOutboxJobId('bad:id')).toThrow(OutboxPayloadError);
  });

  it('지수 backoff를 상한까지 적용한다', () => {
    expect(calculateOutboxRetryDelayMs(1)).toBe(1_000);
    expect(calculateOutboxRetryDelayMs(3)).toBe(4_000);
    expect(calculateOutboxRetryDelayMs(20)).toBe(300_000);
  });

  it('잘못된 retry 인수를 거부한다', () => {
    expect(() => calculateOutboxRetryDelayMs(0)).toThrow('positive integer');
    expect(() => calculateOutboxRetryDelayMs(1, 2_000, 1_000)).toThrow(
      'bounds are invalid',
    );
  });
});
