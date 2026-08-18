import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MONEY_CONTRACT_MODE,
  MONEY_CONTRACT_MODES,
  MONEY_FENCE_DEFAULT_TTL_SEC,
  MONEY_FENCE_MAX_TTL_SEC,
  MONEY_FENCE_MESSAGE_KO,
  MONEY_MODE_HEARTBEAT_MS,
  MONEY_MODE_TTL_SEC,
  moneyModeBootWarning,
  moneyPromotionPauseKey,
  moneyServiceModeKey,
  moneyWriteFenceKey,
  parseMoneyContractMode,
  verifyMoneyModeAgreement,
} from './money-runtime.js';

describe('기본값 — 스위치를 만들어도 동작은 그대로다', () => {
  it('기본 모드는 현재 운영 동작인 shadow다', () => {
    // 이 값이 바뀌면 그건 "스위치를 만든 것"이 아니라 "전환한 것"이다.
    expect(DEFAULT_MONEY_CONTRACT_MODE).toBe('shadow');
  });

  it('모드 어휘는 세 개로 닫혀 있다', () => {
    expect([...MONEY_CONTRACT_MODES]).toEqual(['legacy', 'shadow', 'v2']);
  });
});

describe('parseMoneyContractMode — 잘못된 설정을 조용히 기본값으로 접지 않는다', () => {
  it.each(['legacy', 'shadow', 'v2'])('%s 를 그대로 받는다', (value) => {
    expect(parseMoneyContractMode(value)).toBe(value);
  });

  it('대소문자·공백은 정규화한다', () => {
    expect(parseMoneyContractMode('  V2 ')).toBe('v2');
    expect(parseMoneyContractMode('SHADOW')).toBe('shadow');
  });

  it('알 수 없는 값은 null — 호출부가 오설정을 구분할 수 있어야 한다', () => {
    for (const value of ['enforce', 'on', 'true', '', undefined, null]) {
      expect(parseMoneyContractMode(value as string | undefined)).toBeNull();
    }
  });
});

describe('moneyModeBootWarning — v2가 아직 배선되지 않았음을 숨기지 않는다', () => {
  it('v2로 부팅하면 경고가 있다', () => {
    const warning = moneyModeBootWarning('v2');
    expect(warning).not.toBeNull();
    // "켰다고 믿는" 상태가 가장 위험하다 — 문구가 그 사실을 말해야 한다.
    expect(warning).toContain('enforce');
    expect(warning).toContain('배선');
  });

  it('legacy·shadow는 경고가 없다', () => {
    expect(moneyModeBootWarning('legacy')).toBeNull();
    expect(moneyModeBootWarning('shadow')).toBeNull();
  });
});

describe('Redis 키 — 스택끼리 섞이지 않는다', () => {
  it('큐 접두를 그대로 물려받는다', () => {
    expect(moneyWriteFenceKey('fma')).toBe('fma:money:write-fence');
    expect(moneyPromotionPauseKey('fma')).toBe('fma:money:promotion-pause');
    expect(moneyServiceModeKey('fma', 'api')).toBe('fma:money:mode:api');
    expect(moneyServiceModeKey('fma', 'worker')).toBe('fma:money:mode:worker');
  });

  it('접두가 다르면 키가 겹치지 않는다', () => {
    expect(moneyWriteFenceKey('a')).not.toBe(moneyWriteFenceKey('b'));
  });

  it('네 종류가 서로 다른 키다', () => {
    const keys = [
      moneyWriteFenceKey('p'),
      moneyPromotionPauseKey('p'),
      moneyServiceModeKey('p', 'api'),
      moneyServiceModeKey('p', 'worker'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('verifyMoneyModeAgreement — "모르는 것"을 "일치"로 접지 않는다', () => {
  it('둘 다 같은 모드일 때만 합의로 본다', () => {
    const verdict = verifyMoneyModeAgreement({ api: 'shadow', worker: 'shadow' });
    expect(verdict.agreed).toBe(true);
    expect(verdict.mode).toBe('shadow');
  });

  it('모드가 갈리면 합의가 아니다 — ADR이 금지한 바로 그 상태', () => {
    const verdict = verifyMoneyModeAgreement({ api: 'v2', worker: 'shadow' });
    expect(verdict.agreed).toBe(false);
    expect(verdict.mode).toBeNull();
    expect(verdict.reason).toContain('v2');
    expect(verdict.reason).toContain('shadow');
  });

  it.each([
    ['api만 미게시', { api: null, worker: 'shadow' as const }],
    ['worker만 미게시', { api: 'shadow' as const, worker: null }],
    ['둘 다 미게시', { api: null, worker: null }],
  ])('%s 이면 합의가 아니다', (_label, snapshot) => {
    // 한쪽이 응답하지 않으면 그 서비스가 어떤 계약으로 쓰는지 **모르는** 것이다.
    // 모르는 상태에서 쓰기를 재개하면 ADR 위반을 배제할 수 없다.
    expect(verifyMoneyModeAgreement(snapshot).agreed).toBe(false);
  });

  it('v2끼리도 합의로 본다(전환 완료 판정에 쓴다)', () => {
    expect(verifyMoneyModeAgreement({ api: 'v2', worker: 'v2' })).toMatchObject({
      agreed: true,
      mode: 'v2',
    });
  });
});

describe('펜스 수명 — 켜고 못 끄는 것이 스스로 만든 장애다', () => {
  it('기본 TTL이 있고 최대 TTL을 넘지 않는다', () => {
    expect(MONEY_FENCE_DEFAULT_TTL_SEC).toBeGreaterThan(0);
    expect(MONEY_FENCE_DEFAULT_TTL_SEC).toBeLessThanOrEqual(MONEY_FENCE_MAX_TTL_SEC);
  });

  it('최대 TTL은 1시간 — 그 이상은 "전환 중"이 아니라 "잊었다"이다', () => {
    expect(MONEY_FENCE_MAX_TTL_SEC).toBe(3_600);
  });
});

describe('모드 게시 하트비트 — 죽은 서비스의 옛 모드가 남지 않는다', () => {
  it('TTL이 하트비트 주기보다 충분히 길다 (한 번 놓쳐도 사라지지 않는다)', () => {
    expect(MONEY_MODE_TTL_SEC * 1_000).toBeGreaterThanOrEqual(
      MONEY_MODE_HEARTBEAT_MS * 2,
    );
  });
});

describe('사용자 문구 — 영문 예외를 그대로 노출하지 않는다', () => {
  it('한국어이고 다시 시도하면 된다는 뜻이 담겨 있다', () => {
    expect(MONEY_FENCE_MESSAGE_KO).toMatch(/[가-힣]/);
    expect(MONEY_FENCE_MESSAGE_KO).toContain('다시 시도');
  });
});
