import { defineConfig } from 'vitest/config';

/**
 * apps/worker 단위 테스트 설정.
 *
 * apps/api와 **같은 방식**이다(`src/**\/*.test.ts` + `vitest run`). 설정을 새로
 * 만들지 않는 이유: `test` 스크립트가 없으면 `turbo run test`가 이 패키지를 아예
 * 건너뛰어 "테스트 파일은 있는데 아무도 돌리지 않는" 상태가 된다. 워커는 지출이
 * 만들어지는 곳(파싱·승격)이라 그 상태가 가장 위험한 패키지다.
 *
 * DB/Redis/BullMQ가 필요한 통합 테스트는 여기 대상이 아니다 — 순수 로직(배치 루프
 * 종료 조건 · 관측 payload 형태)만 담는다. NestJS 프로바이더 전체를 띄우는 테스트는
 * 격리 스택(`-p fma-verify`)의 몫이다.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
