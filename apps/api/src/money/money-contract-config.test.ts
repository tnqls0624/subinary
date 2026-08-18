/**
 * 금액 계약 모드 **설정**의 기본값 테스트.
 *
 * `packages/config`에는 `test` 스크립트가 없어(빌드 전용 패키지) 그 계약을 여기서 지킨다.
 * apps/api는 이미 `@family/config`에 의존하고 vitest가 돌므로 실행 경로에 확실히 올라간다.
 *
 * 이 파일의 목적은 하나다: **스위치를 만든 것이지 전환한 것이 아니라는 사실을 고정한다.**
 */
import { describe, expect, it } from 'vitest';

import { validateEnv } from '@family/config';
import { DEFAULT_MONEY_CONTRACT_MODE } from '@family/shared';

/** validateEnv가 요구하는 최소 환경. 금액과 무관한 값은 형식만 맞춘 더미다. */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    TZ: 'Asia/Seoul',
    API_PORT: '3001',
    WORKER_PORT: '3002',
    WEB_PORT: '3000',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    BULLMQ_PREFIX: 'fma',
    STORAGE_ENDPOINT: 'http://localhost:9000',
    STORAGE_REGION: 'us-east-1',
    STORAGE_ACCESS_KEY: 'key',
    STORAGE_SECRET_KEY: 'secret',
    STORAGE_BUCKET: 'bucket',
    STORAGE_FORCE_PATH_STYLE: 'true',
    AI_PROVIDER: 'mock',
    JWT_ACCESS_SECRET: '0123456789abcdef0123456789abcdef',
    DEVICE_SECRET_ENC_KEY: 'a'.repeat(64),
    ...overrides,
  };
}

describe('MONEY_CONTRACT_MODE — 기본값은 현재 운영 동작이다', () => {
  it('설정하지 않으면 shadow다 (동작 0 변화)', () => {
    // 이 단언이 깨지면 "인프라를 추가한 것"이 아니라 "전환한 것"이다.
    expect(validateEnv(baseEnv()).money.contractMode).toBe('shadow');
    expect(validateEnv(baseEnv()).money.contractMode).toBe(
      DEFAULT_MONEY_CONTRACT_MODE,
    );
  });

  it('빈 문자열도 기본값으로 떨어진다 (env_file의 `KEY=` 대응)', () => {
    expect(
      validateEnv(baseEnv({ MONEY_CONTRACT_MODE: '' })).money.contractMode,
    ).toBe('shadow');
  });

  it.each(['legacy', 'shadow', 'v2'])('%s 를 받아들인다', (mode) => {
    expect(
      validateEnv(baseEnv({ MONEY_CONTRACT_MODE: mode })).money.contractMode,
    ).toBe(mode);
  });

  it('알 수 없는 값이면 부팅을 막는다 — 조용히 기본값으로 접지 않는다', () => {
    // "enforce"라고 써 놓고 shadow로 도는 것이 가장 위험한 실패 모양이다.
    expect(() =>
      validateEnv(baseEnv({ MONEY_CONTRACT_MODE: 'enforce' })),
    ).toThrow();
    expect(() => validateEnv(baseEnv({ MONEY_CONTRACT_MODE: 'on' }))).toThrow();
  });
});

describe('MONEY_FENCE_DEFAULT_TTL_SEC — 펜스는 자동 만료돼야 한다', () => {
  it('기본 15분', () => {
    expect(validateEnv(baseEnv()).money.fenceDefaultTtlSec).toBe(900);
  });

  it('1시간을 넘겨 설정할 수 없다 — 그건 "전환 중"이 아니라 "잊었다"이다', () => {
    expect(() =>
      validateEnv(baseEnv({ MONEY_FENCE_DEFAULT_TTL_SEC: '7200' })),
    ).toThrow();
  });

  it('너무 짧게도 설정할 수 없다 (전환 도중 저절로 풀리면 안 된다)', () => {
    expect(() =>
      validateEnv(baseEnv({ MONEY_FENCE_DEFAULT_TTL_SEC: '5' })),
    ).toThrow();
  });
});
