/**
 * purge가 "지웠다"고 말하기 전에 지켜야 할 계약을 문서·회귀로 고정한다.
 * DB 없이 판정·실패 규칙만 본다. 합성 본문만 사용한다.
 */
import { describe, expect, it } from 'vitest';

import {
  eventRawMatchesRetention,
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
    // 회귀: failures_only가 parse_failed를 고르면 실패 원문까지 날아간다.
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
