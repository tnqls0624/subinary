/**
 * purge가 "지웠다"고 말하기 전에 지켜야 할 계약을 고정한다.
 * 합성 본문만 쓴다. 실제 수빈·운영 원문은 넣지 않는다.
 */
import { describe, expect, it } from 'vitest';

import {
  canClaimRawPurged,
  confirmObjectKeysGone,
  eventRawMatchesRetention,
  resolvePurgeLogDecision,
  selectPreviewLinkedSuppressionIds,
  suppressionRawMatchesRetention,
} from '@family/database';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const RAW = 'SYNTHETIC KB 카드 승인 12,000원 테스트가맹점';

describe('purge 후보 계약', () => {
  it('미리보기와 삭제가 같은 네 정책 판정을 쓴다 — none은 항상 0건', () => {
    const events = [
      {
        rawContent: RAW,
        parseStatus: 'parsed' as const,
        receivedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        rawContent: RAW,
        parseStatus: 'parse_failed' as const,
        receivedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        rawContent: '',
        parseStatus: 'parsed' as const,
        receivedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];

    const count = (
      policy: 'none' | 'days_30' | 'after_parse' | 'failures_only',
    ) =>
      events.filter((event) =>
        eventRawMatchesRetention({
          policy,
          rawContent: event.rawContent,
          parseStatus: event.parseStatus,
          receivedAt: event.receivedAt,
          now: NOW,
        }),
      ).length;

    expect(count('none')).toBe(0);
    expect(count('days_30')).toBe(2);
    expect(count('after_parse')).toBe(1);
    expect(count('failures_only')).toBe(1);
  });

  it('거래 행을 지우는 조건은 정책에 없다 — 원문 사본 여부만 본다', () => {
    expect(
      eventRawMatchesRetention({
        policy: 'failures_only',
        rawContent: RAW,
        parseStatus: 'parse_failed',
        receivedAt: NOW,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('억제 원문도 같은 정책 시계·짝 이벤트 판정을 쓴다', () => {
    expect(
      suppressionRawMatchesRetention({
        policy: 'days_30',
        rawContent: RAW,
        firstSeenAt: new Date('2026-11-01T00:00:00.000Z'),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      suppressionRawMatchesRetention({
        policy: 'days_30',
        rawContent: RAW,
        firstSeenAt: new Date('2026-09-01T00:00:00.000Z'),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      suppressionRawMatchesRetention({
        policy: 'failures_only',
        rawContent: RAW,
        firstSeenAt: NOW,
        now: NOW,
        matchedEvent: {
          rawContent: RAW,
          parseStatus: 'ignored',
          receivedAt: NOW,
        },
      }),
    ).toBe(true);
  });
});

describe('selectPreviewLinkedSuppressionIds — 미리보기 밖의 억제는 지우지 않는다', () => {
  it('days_30: 오래된 이벤트에 최근 억제가 있어도 미리보기 후보만 고른다', () => {
    const oldSuppressionId = 'suppression-old-30d';
    const recentSuppressionId = 'suppression-recent';
    const preview = new Set([oldSuppressionId]);
    const linked = [oldSuppressionId, recentSuppressionId];

    expect(selectPreviewLinkedSuppressionIds(linked, preview)).toEqual([
      oldSuppressionId,
    ]);
    expect(
      selectPreviewLinkedSuppressionIds(linked, preview),
    ).not.toContain(recentSuppressionId);
  });

  it('미리보기 후보 밖의 원문 id는 선택되지 않는다', () => {
    expect(
      selectPreviewLinkedSuppressionIds(
        ['outside-preview', 'also-outside'],
        new Set(['inside-preview']),
      ),
    ).toEqual([]);
  });
});

describe('confirmObjectKeysGone — 객체 저장소 사본이 남아 있으면 지웠다고 세지 않는다', () => {
  it('모든 키가 없으면 true', async () => {
    await expect(
      confirmObjectKeysGone(['card-sms/h/e.txt'], async () => false),
    ).resolves.toBe(true);
  });

  it('하나라도 남아 있으면 false — 삭제 호출이 예외 없이 끝나도 재확인한다', async () => {
    const remaining = new Set(['card-sms/h/still-there.txt']);
    await expect(
      confirmObjectKeysGone(
        ['card-sms/h/gone.txt', 'card-sms/h/still-there.txt'],
        async (key) => remaining.has(key),
      ),
    ).resolves.toBe(false);
  });

  it('키가 없으면 확인 호출 없이 true', async () => {
    let calls = 0;
    await expect(
      confirmObjectKeysGone([], async () => {
        calls += 1;
        return true;
      }),
    ).resolves.toBe(true);
    expect(calls).toBe(0);
  });
});

describe('canClaimRawPurged — 세 사본이 없어지기 전에는 지웠다고 쓰지 않는다', () => {
  it('DB·객체 저장소·억제 원문이 모두 없어야 한다', () => {
    expect(
      canClaimRawPurged({
        dbRawGone: true,
        objectStorageGone: true,
        suppressionRawsGone: true,
      }),
    ).toBe(true);
  });

  it('DB 원문이 남으면 지웠다고 쓰지 않는다', () => {
    expect(
      canClaimRawPurged({
        dbRawGone: false,
        objectStorageGone: true,
        suppressionRawsGone: true,
      }),
    ).toBe(false);
  });

  it('객체 저장소 사본이 남으면 지웠다고 쓰지 않는다', () => {
    expect(
      canClaimRawPurged({
        dbRawGone: true,
        objectStorageGone: false,
        suppressionRawsGone: true,
      }),
    ).toBe(false);
  });

  it('억제 행 원문이 남으면 지웠다고 쓰지 않는다', () => {
    expect(
      canClaimRawPurged({
        dbRawGone: true,
        objectStorageGone: true,
        suppressionRawsGone: false,
      }),
    ).toBe(false);
  });
});

describe('resolvePurgeLogDecision — 부분 성공을 completed로 남기지 않는다', () => {
  it('전부 성공하면 completed이고 실패 건수는 0이다', () => {
    expect(
      resolvePurgeLogDecision({
        purgedEventCount: 2,
        purgedSuppressionCount: 1,
        failedEventCount: 0,
        failedSuppressionCount: 0,
      }),
    ).toEqual({
      status: 'completed',
      errorCode: null,
      purgedEventCount: 2,
      purgedSuppressionCount: 1,
      failedEventCount: 0,
      failedSuppressionCount: 0,
    });
  });

  it('일부만 실패해도 completed가 아니고 실패 건수를 남긴다', () => {
    expect(
      resolvePurgeLogDecision({
        purgedEventCount: 3,
        purgedSuppressionCount: 0,
        failedEventCount: 1,
        failedSuppressionCount: 2,
      }),
    ).toEqual({
      status: 'failed',
      errorCode: 'partial_purge_failed',
      purgedEventCount: 3,
      purgedSuppressionCount: 0,
      failedEventCount: 1,
      failedSuppressionCount: 2,
    });
  });

  it('전부 실패하면 failed이고 purged는 0이다', () => {
    expect(
      resolvePurgeLogDecision({
        purgedEventCount: 0,
        purgedSuppressionCount: 0,
        failedEventCount: 2,
        failedSuppressionCount: 0,
      }),
    ).toEqual({
      status: 'failed',
      errorCode: 'purge_failed',
      purgedEventCount: 0,
      purgedSuppressionCount: 0,
      failedEventCount: 2,
      failedSuppressionCount: 0,
    });
  });

  it('아무 일도 없으면 이력을 남기지 않는다', () => {
    expect(
      resolvePurgeLogDecision({
        purgedEventCount: 0,
        purgedSuppressionCount: 0,
        failedEventCount: 0,
        failedSuppressionCount: 0,
      }),
    ).toBeNull();
  });

  it('이력 결정 값에 원문 텍스트 자리가 없다', () => {
    const decision = resolvePurgeLogDecision({
      purgedEventCount: 1,
      purgedSuppressionCount: 0,
      failedEventCount: 0,
      failedSuppressionCount: 0,
    });
    expect(decision).not.toBeNull();
    expect(JSON.stringify(decision)).not.toContain(RAW);
    expect(Object.keys(decision!)).not.toContain('rawContent');
    expect(Object.keys(decision!)).not.toContain('raw_content');
  });
});
