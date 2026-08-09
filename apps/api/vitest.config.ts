import { defineConfig } from 'vitest/config';

/**
 * apps/api 단위 테스트 설정.
 *
 * apps/web과 같은 이유로 만든다: `src/**\/*.test.ts`가 있어도 `test` 스크립트가
 * 없으면 `turbo run test`가 잡지 않아 "파일만 있고 아무도 돌리지 않는" 상태가 된다.
 * 커서 페이지네이션과 질의 거부 경계는 회귀하면 곧바로 사용자 사고(항목 누락 ·
 * 자신 있는 오답)라 실행 경로에 올린다.
 *
 * DB/Redis가 필요한 통합 테스트는 여기 대상이 아니다 — 순수 로직(정렬 키 · 커서
 * 코덱 · 의도 판정)만 담는다.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
