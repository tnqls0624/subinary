import { describe, expect, it } from 'vitest';

import {
  reconcileSlackMessages,
  type CurrentSlackMessageProjection,
  type IncomingSlackMessageProjection,
} from './reconciliation.js';

function incoming(
  overrides: Partial<IncomingSlackMessageProjection> = {},
): IncomingSlackMessageProjection {
  return {
    slackChannelId: 'channel-1',
    slackUserId: 'user-1',
    ts: '1.000001',
    threadTs: null,
    text: '기존 메시지',
    editedTs: null,
    occurredAt: new Date('2026-07-18T00:00:00.000Z'),
    ...overrides,
  };
}

function current(
  overrides: Partial<CurrentSlackMessageProjection> = {},
): CurrentSlackMessageProjection {
  return {
    id: 'message-1',
    deletedAt: null,
    ...incoming(),
    ...overrides,
  };
}

describe('reconcileSlackMessages', () => {
  it('merge는 생성·편집만 반환하고 누락 행을 삭제하지 않는다', () => {
    const result = reconcileSlackMessages({
      syncMode: 'merge',
      incoming: [
        incoming({ text: '편집된 메시지' }),
        incoming({ ts: '2.000001', text: '새 메시지' }),
      ],
      current: [current(), current({ id: 'missing', ts: '3.000001' })],
      snapshotChannelIds: new Set(['channel-1']),
    });

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].incoming.text).toBe('편집된 메시지');
    expect(result.created.map((message) => message.ts)).toEqual(['2.000001']);
    expect(result.deleted).toEqual([]);
  });

  it('snapshot은 명시된 채널 안에서만 누락된 활성 행을 삭제한다', () => {
    const result = reconcileSlackMessages({
      syncMode: 'snapshot',
      incoming: [incoming()],
      current: [
        current(),
        current({ id: 'delete-me', ts: '2.000001' }),
        current({
          id: 'outside-scope',
          slackChannelId: 'channel-2',
          ts: '3.000001',
        }),
      ],
      snapshotChannelIds: new Set(['channel-1']),
    });

    expect(result.deleted.map((message) => message.id)).toEqual(['delete-me']);
  });

  it('기존 tombstone은 수신 bundle에 있어도 복구하지 않는다', () => {
    const result = reconcileSlackMessages({
      syncMode: 'snapshot',
      incoming: [incoming({ text: '복구 시도' })],
      current: [current({ deletedAt: new Date('2026-07-18T01:00:00.000Z') })],
      snapshotChannelIds: new Set(['channel-1']),
    });

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.ignoredTombstoneCount).toBe(1);
  });

  it('bundle 중복 키는 마지막 행 하나만 사용한다', () => {
    const result = reconcileSlackMessages({
      syncMode: 'merge',
      incoming: [incoming({ text: '첫 값' }), incoming({ text: '마지막 값' })],
      current: [],
      snapshotChannelIds: new Set(['channel-1']),
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0].text).toBe('마지막 값');
    expect(result.duplicateIncomingCount).toBe(1);
  });

  it('현재 editedTs보다 오래되거나 version이 없는 편집은 무시한다', () => {
    const older = reconcileSlackMessages({
      syncMode: 'merge',
      incoming: [incoming({ text: '오래된 값', editedTs: '9.000001' })],
      current: [current({ text: '최신 값', editedTs: '10.000001' })],
      snapshotChannelIds: new Set(['channel-1']),
    });
    const unversioned = reconcileSlackMessages({
      syncMode: 'merge',
      incoming: [incoming({ text: '버전 없는 값', editedTs: null })],
      current: [current({ text: '최신 값', editedTs: '10.000001' })],
      snapshotChannelIds: new Set(['channel-1']),
    });

    expect(older.updated).toEqual([]);
    expect(older.ignoredStaleUpdateCount).toBe(1);
    expect(unversioned.updated).toEqual([]);
    expect(unversioned.ignoredStaleUpdateCount).toBe(1);
  });
});
