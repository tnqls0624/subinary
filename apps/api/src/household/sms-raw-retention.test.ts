/**
 * SOO-34 보존 정책 판정 — 미리보기와 purge가 같은 규칙을 쓰는지 고정한다.
 * 합성 문자만 쓴다. 실제 수빈 문자·운영 원문은 넣지 않는다.
 */
import { describe, expect, it } from 'vitest';

import {
  eventRawMatchesRetention,
  hasSmsRawCopy,
  retentionPolicyEffectSummary,
  suppressionRawMatchesRetention,
  type SmsRetentionPolicy,
} from '@family/database';

const NOW = new Date('2026-11-07T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function received(daysAgo: number): Date {
  return new Date(NOW.getTime() - daysAgo * DAY);
}

describe('hasSmsRawCopy', () => {
  it('빈 문자열은 이미 지운 자리로 본다', () => {
    expect(hasSmsRawCopy('')).toBe(false);
    expect(hasSmsRawCopy('SYNTHETIC CARD SMS APPROVED 1000')).toBe(true);
  });
});

describe('eventRawMatchesRetention', () => {
  const base = {
    rawContent: 'SYNTHETIC CARD SMS APPROVED 1000',
    parseStatus: 'parsed' as const,
    receivedAt: received(1),
    now: NOW,
  };

  it('none이면 어떤 원문도 고르지 않는다', () => {
    expect(
      eventRawMatchesRetention({ ...base, policy: 'none', parseStatus: 'parsed' }),
    ).toBe(false);
    expect(
      eventRawMatchesRetention({
        ...base,
        policy: 'none',
        parseStatus: 'parse_failed',
        receivedAt: received(100),
      }),
    ).toBe(false);
  });

  it('days_30은 수신 시각 기준 30일이 지난 원문만 고른다', () => {
    expect(
      eventRawMatchesRetention({
        ...base,
        policy: 'days_30',
        receivedAt: received(29),
      }),
    ).toBe(false);
    expect(
      eventRawMatchesRetention({
        ...base,
        policy: 'days_30',
        receivedAt: received(30),
      }),
    ).toBe(true);
    expect(
      eventRawMatchesRetention({
        ...base,
        policy: 'days_30',
        rawContent: '',
        receivedAt: received(40),
      }),
    ).toBe(false);
  });

  it('after_parse는 parsed만 고른다', () => {
    const policy: SmsRetentionPolicy = 'after_parse';
    expect(
      eventRawMatchesRetention({ ...base, policy, parseStatus: 'parsed' }),
    ).toBe(true);
    expect(
      eventRawMatchesRetention({ ...base, policy, parseStatus: 'parse_failed' }),
    ).toBe(false);
    expect(
      eventRawMatchesRetention({ ...base, policy, parseStatus: 'pending' }),
    ).toBe(false);
    expect(
      eventRawMatchesRetention({ ...base, policy, parseStatus: 'ignored' }),
    ).toBe(false);
  });

  it('failures_only는 성공·비거래만 지우고 실패·처리 중은 남긴다', () => {
    const policy: SmsRetentionPolicy = 'failures_only';
    expect(
      eventRawMatchesRetention({ ...base, policy, parseStatus: 'parsed' }),
    ).toBe(true);
    expect(
      eventRawMatchesRetention({ ...base, policy, parseStatus: 'ignored' }),
    ).toBe(true);
    expect(
      eventRawMatchesRetention({ ...base, policy, parseStatus: 'parse_failed' }),
    ).toBe(false);
    expect(
      eventRawMatchesRetention({ ...base, policy, parseStatus: 'pending' }),
    ).toBe(false);
    expect(
      eventRawMatchesRetention({
        ...base,
        policy,
        parseStatus: 'pending_review',
      }),
    ).toBe(false);
    expect(
      eventRawMatchesRetention({ ...base, policy, parseStatus: 'quarantined' }),
    ).toBe(false);
  });
});

describe('suppressionRawMatchesRetention', () => {
  it('days_30은 firstSeenAt 기준이고, after_parse·failures_only는 짝 이벤트 판정을 따른다', () => {
    const raw = 'SYNTHETIC DUPLICATE SUPPRESSION BODY';
    expect(
      suppressionRawMatchesRetention({
        policy: 'days_30',
        rawContent: raw,
        firstSeenAt: received(10),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      suppressionRawMatchesRetention({
        policy: 'days_30',
        rawContent: raw,
        firstSeenAt: received(31),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      suppressionRawMatchesRetention({
        policy: 'after_parse',
        rawContent: raw,
        firstSeenAt: received(0),
        now: NOW,
        matchedEvent: null,
      }),
    ).toBe(false);
    expect(
      suppressionRawMatchesRetention({
        policy: 'after_parse',
        rawContent: raw,
        firstSeenAt: received(0),
        now: NOW,
        matchedEvent: {
          rawContent: raw,
          parseStatus: 'parsed',
          receivedAt: received(0),
        },
      }),
    ).toBe(true);
    expect(
      suppressionRawMatchesRetention({
        policy: 'after_parse',
        rawContent: raw,
        firstSeenAt: received(0),
        now: NOW,
        matchedEvent: {
          rawContent: raw,
          parseStatus: 'parse_failed',
          receivedAt: received(0),
        },
      }),
    ).toBe(false);
    expect(
      suppressionRawMatchesRetention({
        policy: 'none',
        rawContent: raw,
        firstSeenAt: received(100),
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe('retentionPolicyEffectSummary', () => {
  it('네 정책 모두 서비스가 하는 일만 적는다', () => {
    expect(retentionPolicyEffectSummary('none')).toContain('지우지 않');
    expect(retentionPolicyEffectSummary('days_30')).toContain('30일');
    expect(retentionPolicyEffectSummary('days_30')).toContain('수신 시각');
    expect(retentionPolicyEffectSummary('after_parse')).toContain('파싱에 성공');
    expect(retentionPolicyEffectSummary('failures_only')).toContain('실패');
  });
});
