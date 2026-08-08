/**
 * Drizzle + postgres.js 클라이언트 팩토리 (Phase 0 Build Spec §6.5).
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as schema from './schema.js';

/** 앱 전역에서 사용하는 Drizzle 데이터베이스 타입. */
export type Db = PostgresJsDatabase<typeof schema>;

/**
 * `Db` 또는 그 트랜잭션 핸들 — 같은 쿼리 헬퍼를 트랜잭션 안팎에서 재사용할 때 쓴다.
 *
 * 잠금(`FOR UPDATE`)이 걸린 경로에서는 헬퍼가 실수로 `this.db`(= 트랜잭션 밖 커넥션)를
 * 쓰면 잠금이 무의미해지므로, 실행기를 인자로 **명시적으로** 넘기게 하려는 타입이다.
 */
export type DbExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** {@link createDbClient} 옵션. */
export interface CreateDbClientOptions {
  /** 커넥션 풀 최대 크기 (기본 10). */
  max?: number;
}

/**
 * Drizzle DB 인스턴스와 원본 postgres.js 클라이언트를 생성한다.
 *
 * - `prepare: false` — 트랜잭션 풀러(PgBouncer transaction mode 등) 호환.
 * - 반환된 `client`는 앱 종료 시 `client.end()`로 정리해야 한다
 *   (예: NestJS `onModuleDestroy`).
 *
 * @param databaseUrl `postgresql://user:pass@host:port/db` 형식 연결 문자열.
 *                    자격증명이 포함되므로 값 자체를 로그에 출력하지 않는다.
 */
export function createDbClient(
  databaseUrl: string,
  opts?: CreateDbClientOptions,
): { db: Db; client: Sql } {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    // 주의: databaseUrl 값을 에러 메시지에 포함하지 않는다 (Secret 노출 금지).
    throw new Error('[@family/database] createDbClient: databaseUrl must be a non-empty string');
  }

  const client = postgres(databaseUrl, {
    max: opts?.max ?? 10,
    prepare: false,
  });
  const db = drizzle(client, { schema });

  return { db, client };
}
