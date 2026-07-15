/**
 * 프로그램적 마이그레이터 (Phase 1 Build Spec §2).
 *
 * `drizzle-orm/postgres-js/migrator`의 migrate()를 실행해
 * `packages/database/drizzle`(dist 기준 `../drizzle`)의 SQL 마이그레이션을 적용한다.
 *
 * 실행: `node dist/migrate.js` (package.json "migrate" 스크립트, compose `migrate` 서비스).
 * - CJS 빌드(dist/migrate.js)로 실행되므로 `__dirname`을 그대로 사용한다.
 * - `DATABASE_URL` 환경변수를 사용한다(자격증명 포함 — 값 자체를 로그에 출력하지 않는다).
 * - 마이그레이션 폴더/journal이 없으면 안전하게 no-op으로 정상 종료한다(초기 부팅 방어).
 * - 마이그레이션 오류 시 `process.exit(1)`.
 * - 어떤 경로로든 종료 전 `client.end()`로 커넥션을 정리한다.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { createDbClient } from './client.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    // 주의: 값 자체(자격증명 포함)를 에러 메시지에 담지 않는다.
    throw new Error('DATABASE_URL is not set');
  }

  // dist 기준 `../drizzle` → packages/database/drizzle (compose에서 바인드마운트).
  const migrationsFolder = resolve(__dirname, '../drizzle');
  const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');

  // max:1 — 마이그레이션은 단일 커넥션에서 순차 적용한다.
  const { db, client } = createDbClient(databaseUrl, { max: 1 });

  try {
    if (!existsSync(migrationsFolder) || !existsSync(journalPath)) {
      // 폴더/journal 부재 → 적용할 마이그레이션 없음. 안전하게 no-op으로 종료한다.
      console.log(
        '[@family/database] migrate: no migrations to apply (folder/journal not found)',
      );
      return;
    }

    await migrate(db, { migrationsFolder });
    console.log('[@family/database] migrate: migrations applied successfully');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  // 에러 메시지에 자격증명/토큰이 섞이지 않도록 메시지 텍스트만 출력한다.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[@family/database] migrate: failed — ${message}`);
  process.exit(1);
});
