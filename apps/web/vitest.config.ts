import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * apps/web 단위 테스트 설정.
 *
 * 지금까지 `apps/web`에는 `test` 스크립트가 없어 `src/**\/*.test.ts`가 있어도
 * `turbo run test`에 잡히지 않았다(파일만 있고 아무도 돌리지 않는 상태였다).
 * 오픈 리다이렉트 검증처럼 회귀하면 보안 사고가 되는 규칙이 생겼으므로 실행 경로에
 * 올린다. `@/` 별칭은 tsconfig의 paths와 같은 값을 여기서도 풀어 준다.
 */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "./src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
