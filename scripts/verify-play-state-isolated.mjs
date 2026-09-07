#!/usr/bin/env node
/** 기존 안전 가드로 일회용 DB를 생성하고 PlayService 저장을 검증한 후 폐기한다. */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertDisposableVerificationDatabaseName,
  buildDisposableVerificationDatabaseInitializationSql,
} from './lib/verification-database-guard.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const postgresInitializationSql = readFileSync(
  resolve(projectRoot, 'infrastructure/postgres/init/01-extensions.sql'),
  'utf8',
);
const composeArguments = [
  'compose',
  '--env-file',
  '.env',
  '--env-file',
  '.env.production',
  '-f',
  'docker-compose.prod.yml',
];

/** @returns {string} 이번 실행에서만 사용하는 검증 DB 이름 */
function createDisposableDatabaseName() {
  const timestamp = new Date().toISOString().replace(/\D/gu, '').slice(0, 14);
  const randomSuffix = randomBytes(4).toString('hex');
  return assertDisposableVerificationDatabaseName(
    `family_memory_verify_${timestamp}_${randomSuffix}`,
  );
}

/**
 * Docker Compose 명령을 shell 보간 없이 실행한다.
 *
 * @param {string[]} arguments_ compose 하위 명령 인수
 * @param {{ input?: string }} [options] 표준 입력 옵션
 */
function runCompose(arguments_, options = {}) {
  const result = spawnSync('docker', [...composeArguments, ...arguments_], {
    cwd: projectRoot,
    env: process.env,
    input: options.input,
    stdio: options.input
      ? ['pipe', 'inherit', 'inherit']
      : ['inherit', 'inherit', 'inherit'],
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error(`Docker Compose 실행 실패: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `Docker Compose 명령이 종료 코드 ${result.status ?? 'unknown'}로 실패했습니다.`,
    );
  }
}

/** @param {string} sql postgres 관리 DB에서 실행할 SQL */
function runPostgresSql(sql) {
  runCompose(
    [
      'exec',
      '-T',
      'postgres',
      'sh',
      '-lc',
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ],
    { input: sql },
  );
}

const databaseName = createDisposableDatabaseName();
const containerDatabaseUrl = [
  'const url = new URL(process.env.DATABASE_URL);',
  'url.pathname = "/" + process.env.VERIFY_DATABASE_NAME;',
  'process.stdout.write(url.toString());',
].join(' ');
const exportVerificationDatabaseUrl =
  `export DATABASE_URL="$(node -e '${containerDatabaseUrl}')"`;

let verificationError;
let cleanupError;

try {
  console.log(`[play-state] 일회성 검증 DB 생성·확장 초기화: ${databaseName}`);
  runPostgresSql(
    buildDisposableVerificationDatabaseInitializationSql(
      databaseName,
      postgresInitializationSql,
    ),
  );

  console.log('[play-state] 일회성 검증 DB migration 실행');
  runCompose([
    'run',
    '--rm',
    '--no-deps',
    '-e',
    `VERIFY_DATABASE_NAME=${databaseName}`,
    '--entrypoint',
    'sh',
    'migrate',
    '-lc',
    `${exportVerificationDatabaseUrl}\npnpm --filter @family/database migrate`,
  ]);

  console.log('[play-state] v1·RPG 5키·이전·두 클라이언트 역전 통합 검증 실행');
  runCompose([
    'run',
    '--rm',
    '--no-deps',
    '-e',
    `VERIFY_DATABASE_NAME=${databaseName}`,
    '-e',
    'PLAY_VERIFY_ALLOW_WRITE=1',
    '-e',
    'NODE_ENV=test',
    '-v',
    `${scriptDirectory}:/app/scripts:ro`,
    '-v',
    `${projectRoot}/apps/web/public/miniapps/backyard:/app/apps/web/public/miniapps/backyard:ro`,
    '--entrypoint',
    'sh',
    'api',
    '-lc',
    `${exportVerificationDatabaseUrl}\nnode scripts/verify-play-state.mjs`,
  ]);
} catch (error) {
  verificationError = error;
} finally {
  try {
    assertDisposableVerificationDatabaseName(databaseName);
    console.log(`[play-state] 일회성 검증 DB 폐기: ${databaseName}`);
    runPostgresSql(
      [
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid();`,
        `DROP DATABASE IF EXISTS "${databaseName}";`,
        '',
      ].join('\n'),
    );
  } catch (error) {
    cleanupError = error;
  }
}

if (verificationError) {
  console.error(`[play-state] 검증 실패: ${verificationError.message}`);
  if (cleanupError) {
    console.error(`[play-state] 정리 실패: ${cleanupError.message}`);
  }
  process.exit(1);
}
if (cleanupError) {
  console.error(`[play-state] 정리 실패: ${cleanupError.message}`);
  process.exit(1);
}
console.log('[play-state] 검증 완료 · 일회성 DB 폐기 완료');
