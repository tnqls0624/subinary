import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDisposableVerificationDatabaseName,
  assertVerificationDatabaseSafety,
  buildDisposableVerificationDatabaseInitializationSql,
  parseVerificationDatabaseName,
} from './verification-database-guard.mjs';

test('독립 검증 DB 이름을 허용한다', () => {
  for (const databaseName of [
    'family_memory_test',
    'family-memory-verify-42',
    'verification_family_memory',
  ]) {
    assert.deepEqual(
      assertVerificationDatabaseSafety({
        databaseUrl: `postgresql://user:password@postgres:5432/${databaseName}`,
        allowWrite: '1',
        nodeEnv: 'test',
      }),
      { databaseName },
    );
  }
});

test('URL 인코딩된 검증 DB 이름을 해석한다', () => {
  assert.equal(
    parseVerificationDatabaseName(
      'postgresql://localhost:5432/family_memory_%76erify',
    ),
    'family_memory_verify',
  );
});

test('명시적인 쓰기 허용이 없으면 차단한다', () => {
  assert.throws(
    () =>
      assertVerificationDatabaseSafety({
        databaseUrl: 'postgresql://localhost/family_memory_test',
        allowWrite: undefined,
        nodeEnv: 'test',
      }),
    /MODEL_GATE_VERIFY_ALLOW_WRITE=1/,
  );
});

test('production 런타임에서는 검증 DB 이름이어도 차단한다', () => {
  assert.throws(
    () =>
      assertVerificationDatabaseSafety({
        databaseUrl: 'postgresql://localhost/family_memory_verify',
        allowWrite: '1',
        nodeEnv: 'production',
      }),
    /NODE_ENV=production/,
  );
});

test('일반 운영 DB와 부분 문자열 오탐을 차단한다', () => {
  for (const databaseName of ['family_memory', 'family_production', 'latest']) {
    assert.throws(
      () =>
        assertVerificationDatabaseSafety({
          databaseUrl: `postgresql://localhost/${databaseName}`,
          allowWrite: '1',
          nodeEnv: 'development',
        }),
      /검증 DB 이름/,
    );
  }
});

test('잘못된 연결 문자열과 비 PostgreSQL 프로토콜을 차단한다', () => {
  assert.throws(
    () => parseVerificationDatabaseName('not-a-url'),
    /올바른 URL 형식/,
  );
  assert.throws(
    () => parseVerificationDatabaseName('mysql://localhost/family_memory_test'),
    /PostgreSQL/,
  );
  assert.throws(
    () => parseVerificationDatabaseName('postgresql://localhost/'),
    /단일 데이터베이스 이름/,
  );
});

test('이번 실행에서 만든 고유 검증 DB만 자동 폐기 대상으로 허용한다', () => {
  assert.equal(
    assertDisposableVerificationDatabaseName(
      'family_memory_verify_20260718235959_a1b2c3d4',
    ),
    'family_memory_verify_20260718235959_a1b2c3d4',
  );

  for (const databaseName of [
    'family_memory',
    'family_memory_verify',
    'family_memory_verify_20260718235959_',
    'other_verify_20260718235959_a1b2c3d4',
  ]) {
    assert.throws(
      () => assertDisposableVerificationDatabaseName(databaseName),
      /자동 폐기/,
    );
  }
});

test('일회성 DB 생성 직후 운영 확장 초기화 SQL을 같은 DB에 적용한다', () => {
  const databaseName = 'family_memory_verify_20260718235959_a1b2c3d4';
  const initializationSql = [
    'CREATE EXTENSION IF NOT EXISTS vector;',
    'CREATE EXTENSION IF NOT EXISTS pg_trgm;',
    'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
  ].join('\n');

  assert.equal(
    buildDisposableVerificationDatabaseInitializationSql(
      databaseName,
      initializationSql,
    ),
    [
      `CREATE DATABASE "${databaseName}";`,
      `\\connect ${databaseName}`,
      initializationSql,
      '',
    ].join('\n'),
  );
  assert.throws(
    () =>
      buildDisposableVerificationDatabaseInitializationSql(databaseName, '  '),
    /초기화 SQL/,
  );
});
