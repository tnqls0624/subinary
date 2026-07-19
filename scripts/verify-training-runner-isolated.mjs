#!/usr/bin/env node

/** 운영 PostgreSQL 안의 일회성 DB에서 실제 Training Runner를 검증하고 폐기한다. */
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
const initializationSql = readFileSync(
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

function createDatabaseName() {
  const timestamp = new Date().toISOString().replace(/\D/gu, '').slice(0, 14);
  return assertDisposableVerificationDatabaseName(
    `family_memory_verify_${timestamp}_${randomBytes(4).toString('hex')}`,
  );
}

function runCompose(arguments_, input) {
  const result = spawnSync('docker', [...composeArguments, ...arguments_], {
    cwd: projectRoot,
    env: process.env,
    input,
    stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Docker Compose command failed: ${result.status}`);
  }
}

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
    sql,
  );
}

const databaseName = createDatabaseName();
const databaseUrlScript = [
  'const url = new URL(process.env.DATABASE_URL);',
  'url.pathname = "/" + process.env.VERIFY_DATABASE_NAME;',
  'process.stdout.write(url.toString());',
].join(' ');
const exportDatabaseUrl =
  `export DATABASE_URL="$(node -e '${databaseUrlScript}')"`;

let verificationError;
let cleanupError;
try {
  console.log(`[trainer] 일회성 검증 DB 생성: ${databaseName}`);
  runPostgresSql(
    buildDisposableVerificationDatabaseInitializationSql(
      databaseName,
      initializationSql,
    ),
  );
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
    `${exportDatabaseUrl}\npnpm --filter @family/database migrate`,
  ]);
  runCompose([
    '--profile',
    'training',
    'run',
    '--rm',
    '--no-deps',
    '-e',
    `VERIFY_DATABASE_NAME=${databaseName}`,
    '-e',
    'MODEL_GATE_VERIFY_ALLOW_WRITE=1',
    '-e',
    'NODE_ENV=test',
    '-v',
    `${scriptDirectory}:/app/scripts:ro`,
    '--entrypoint',
    'sh',
    'trainer',
    '-lc',
    `${exportDatabaseUrl}\nnode scripts/verify-training-runner.mjs`,
  ]);
} catch (error) {
  verificationError = error;
} finally {
  try {
    assertDisposableVerificationDatabaseName(databaseName);
    console.log(`[trainer] 일회성 검증 DB 폐기: ${databaseName}`);
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

if (verificationError && cleanupError) {
  throw new AggregateError(
    [verificationError, cleanupError],
    'Training Runner 검증과 DB 정리가 모두 실패했습니다.',
  );
}
if (verificationError) throw verificationError;
if (cleanupError) throw cleanupError;
console.log('[trainer] 격리 검증 및 일회성 DB 정리 완료');
