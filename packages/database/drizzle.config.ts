import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 툴링 설정 (Phase 1 Build Spec §2).
 *
 * generate 전용 설정이다 — SQL 마이그레이션 생성에만 사용하므로
 * `dbCredentials`는 두지 않는다(스펙 §2: "dbCredentials 불필요, generate만 사용").
 * - `pnpm db:generate` : 스키마(./src/schema.ts) → SQL 마이그레이션(./drizzle) 생성.
 * - 적용(migrate)은 프로그램적 마이그레이터(src/migrate.ts, `pnpm migrate`)가 수행한다.
 *
 * pgvector 확장(`vector`)은 마이그레이션이 아니라
 * infrastructure/postgres/init/01-extensions.sql 이 생성한다.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
});
