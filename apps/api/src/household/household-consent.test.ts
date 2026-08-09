/**
 * 동의 상태 판정(순수 로직) 회귀 테스트.
 *
 * 여기서 회귀하면 사용자 사고가 두 방향으로 난다: "철회했는데 계속 수집됨"(P0-2와 같은
 * 성격)과 "동의했는데 기기 등록이 막힘". 어느 쪽도 화면을 보고는 원인을 알 수 없다.
 * DB가 필요한 경로(loadConsentHistory)는 격리 스택 실측이 담당하고, 여기서는 이력
 * 배열 → 상태 판정만 본다.
 */
import { describe, expect, it } from 'vitest';

import { CURRENT_HOUSEHOLD_CONSENT_VERSION } from '@family/contracts';
import type { schema } from '@family/database';

import {
  currentConsent,
  hasActiveConsent,
  needsRenewal,
  toConsentRecord,
} from './household-consent';

type Row = schema.HouseholdConsent;

/** 최신순 이력의 한 행. `loadConsentHistory`가 돌려주는 정렬을 흉내낸다. */
function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'consent-1',
    householdId: 'household-1',
    userId: 'user-1',
    consentType: 'household_join',
    consentVersion: CURRENT_HOUSEHOLD_CONSENT_VERSION,
    status: 'granted',
    consentedAt: new Date('2026-08-01T00:00:00Z'),
    revokedAt: null,
    revokedReason: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  } as Row;
}

describe('currentConsent', () => {
  it('가장 최근 행이 현재 상태다', () => {
    const newest = row({ id: 'newest' });
    const older = row({ id: 'older', status: 'revoked' });
    expect(currentConsent([newest, older])?.id).toBe('newest');
  });

  it('이력이 없으면 null', () => {
    expect(currentConsent([])).toBeNull();
  });
});

describe('hasActiveConsent', () => {
  it('최신 행이 granted면 유효하다', () => {
    expect(hasActiveConsent([row()])).toBe(true);
  });

  it('최신 행이 revoked면 유효하지 않다 — 이 판정이 수집 차단의 근거다', () => {
    expect(
      hasActiveConsent([
        row({ status: 'revoked', revokedAt: new Date(), revokedReason: 'user_request' }),
      ]),
    ).toBe(false);
  });

  it('철회 뒤 재동의하면 다시 유효하다 (되돌릴 수 있어야 한다)', () => {
    const regranted = row({ id: 'regranted' });
    const revoked = row({
      id: 'revoked',
      status: 'revoked',
      revokedAt: new Date(),
      revokedReason: 'user_request',
    });
    expect(hasActiveConsent([regranted, revoked])).toBe(true);
  });

  it('기록이 아예 없으면 "철회"가 아니다 — 없음을 차단으로 해석하지 않는다', () => {
    expect(hasActiveConsent([])).toBe(true);
  });
});

describe('needsRenewal', () => {
  it('현재 버전에 동의했으면 재동의를 요구하지 않는다', () => {
    expect(needsRenewal([row()])).toBe(false);
  });

  it('옛 버전에 동의했으면 재동의를 요청한다', () => {
    expect(needsRenewal([row({ consentVersion: 'v0-ancient' })])).toBe(true);
  });

  it('철회 상태는 "개정"이 아니라 "미동의"다', () => {
    expect(
      needsRenewal([
        row({
          consentVersion: 'v0-ancient',
          status: 'revoked',
          revokedAt: new Date(),
        }),
      ]),
    ).toBe(false);
  });
});

describe('toConsentRecord', () => {
  it('철회 시각과 사유를 잃지 않는다', () => {
    const revokedAt = new Date('2026-08-09T03:00:00Z');
    const record = toConsentRecord(
      row({ status: 'revoked', revokedAt, revokedReason: 'user_request' }),
    );
    expect(record.status).toBe('revoked');
    expect(record.revokedAt).toBe(revokedAt.toISOString());
    expect(record.revokedReason).toBe('user_request');
    // 동의 시각은 철회 뒤에도 남아야 한다 — "언제 동의했다가 언제 철회했는가".
    expect(record.consentedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('코드에 원문이 없는 버전은 그 사실을 화면까지 전달한다', () => {
    expect(toConsentRecord(row()).documentAvailable).toBe(true);
    expect(
      toConsentRecord(row({ consentVersion: 'v-unknown' })).documentAvailable,
    ).toBe(false);
  });
});
