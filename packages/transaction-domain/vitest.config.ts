import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 금액 계획기는 순수 함수(입력 → 컬럼값)라 DOM이 필요 없다. DB를 실제로 잡는
    // 실행기 경로는 여기서 돌지 않는다 — 그건 격리 스택 런타임 검증의 몫이다.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
