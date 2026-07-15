import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 툴링 설정 (Phase 0 Build Spec §6.5).
 *
 * Phase 0에서는 실제 마이그레이션 파일을 만들지 않는다 — 툴링만 배치.
 * - `pnpm db:generate` : 스키마 → SQL 마이그레이션 생성 (Phase 0 스키마는 비어 있어 no-op)
 * - `pnpm db:migrate`  : `DATABASE_URL` 환경변수가 설정되어 있어야 한다.
 *
 * pgvector 확장(`vector`)은 마이그레이션이 아니라
 * infrastructure/postgres/init/01-extensions.sql 이 생성한다.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // migrate 실행 시에만 필요. 값 자체를 로그에 출력하지 않는다(자격증명 포함).
    url: process.env.DATABASE_URL ?? '',
  },
});
