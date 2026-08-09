/**
 * 커서 페이지네이션 — 실제 Postgres 대조 검증.
 *
 * `pagination.test.ts`(순수 유닛)가 증명하지 못하는 두 가지를 여기서 확인한다.
 *  1. **enum 정렬 키 비교** — `"type" > $1` 이 Postgres에서 실제로 enum 비교로
 *     해석되는가(파라미터가 text로 굳으면 `operator does not exist`로 죽는다).
 *  2. **NULL 정렬 키** — drizzle `asc()`가 만드는 절이 정말 NULLS LAST로 동작하고,
 *     `keysetAfter`의 NULL 규약이 그것과 일치하는가.
 * 덧붙여 동일 timestamp 묶음을 **DB가 실제로 돌려주는 순서**로 끝까지 넘기며
 * 누락·중복이 없는지를 본다.
 *
 * DB가 필요하므로 `PAGINATION_TEST_DATABASE_URL`이 있을 때만 돈다(CI 기본은 skip).
 * 격리 인스턴스 예시:
 *   docker run -d --name fma-verify-pg -e POSTGRES_USER=family \
 *     -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify -p 55432:5432 \
 *     pgvector/pgvector:pg17
 *   PAGINATION_TEST_DATABASE_URL=postgres://family:verify@localhost:55432/verify \
 *     pnpm --filter @family/api test
 *
 * ⚠️ 운영 DB를 절대 가리키지 말 것 — 이 테스트는 자기 스키마를 drop/create 한다.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgEnum, pgSchema, timestamp, uuid, text } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  decodeKeysetCursor,
  keysetAfter,
  keysetOrderBy,
  parseCursorTimestamp,
  takePage,
  type KeysetKey,
} from './pagination';

const DATABASE_URL = process.env.PAGINATION_TEST_DATABASE_URL;

/* -------------------------------------------------------------------------- */
/* 테스트 전용 스키마(운영 테이블과 같은 모양의 최소 사본)                       */
/* -------------------------------------------------------------------------- */

const s = pgSchema('pagination_check');
const entityType = s.enum('entity_type_check', [
  'person',
  'technology',
  'project',
]);

/** entities 의 정렬 키 관련 열만 옮긴 사본. */
const entities = s.table('entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  type: entityType('type').notNull(),
  name: text('name').notNull(),
});

/** relationships 의 정렬 키 관련 열만 옮긴 사본(valid_from 은 nullable). */
const relationships = s.table('relationships', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }),
});

const ENTITY_KEYS: readonly KeysetKey[] = [
  { name: 'type', column: entities.type, direction: 'asc' },
  { name: 'name', column: entities.name, direction: 'asc' },
  { name: 'id', column: entities.id, direction: 'asc' },
];

const RELATIONSHIP_KEYS: readonly KeysetKey[] = [
  {
    name: 'validFrom',
    column: relationships.validFrom,
    direction: 'asc',
    nullable: true,
    parse: parseCursorTimestamp,
  },
  { name: 'id', column: relationships.id, direction: 'asc' },
];

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

describe.skipIf(!DATABASE_URL)('커서 페이지네이션 — 실제 Postgres', () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 2 });
    db = drizzle(sql);

    await sql.unsafe(`drop schema if exists pagination_check cascade`);
    await sql.unsafe(`create schema pagination_check`);
    await sql.unsafe(
      `create type pagination_check.entity_type_check as enum ('person','technology','project')`,
    );
    await sql.unsafe(`
      create table pagination_check.entities (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null,
        type pagination_check.entity_type_check not null,
        name text not null
      )`);
    await sql.unsafe(`
      create table pagination_check.relationships (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null,
        valid_from timestamptz
      )`);

    // 같은 (type, name) 묶음이 여럿 — tie-breaker 없이는 페이지 경계에서 무너진다.
    await db.insert(entities).values([
      { workspaceId: WORKSPACE, type: 'person', name: '김민수' },
      { workspaceId: WORKSPACE, type: 'person', name: '김민수' },
      { workspaceId: WORKSPACE, type: 'person', name: '김민수' },
      { workspaceId: WORKSPACE, type: 'person', name: '박지훈' },
      { workspaceId: WORKSPACE, type: 'technology', name: 'redis' },
      { workspaceId: WORKSPACE, type: 'technology', name: 'redis' },
      { workspaceId: WORKSPACE, type: 'project', name: '이사' },
    ]);

    const shared = new Date('2026-08-01T00:00:00.000Z');
    await db.insert(relationships).values([
      { workspaceId: WORKSPACE, validFrom: new Date('2026-07-01T00:00:00Z') },
      { workspaceId: WORKSPACE, validFrom: shared },
      { workspaceId: WORKSPACE, validFrom: shared },
      { workspaceId: WORKSPACE, validFrom: shared },
      { workspaceId: WORKSPACE, validFrom: shared },
      // NULL 묶음(명시적 supersede 관계 등) — ASC 에서 맨 뒤로 간다.
      { workspaceId: WORKSPACE, validFrom: null },
      { workspaceId: WORKSPACE, validFrom: null },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`drop schema if exists pagination_check cascade`);
    await sql.end({ timeout: 5 });
  });

  /** 실제 SQL로 끝까지 순회하며 id를 모은다. */
  async function pageThrough(
    keys: readonly KeysetKey[],
    table: typeof entities | typeof relationships,
    pageSize: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      const where = [eq(table.workspaceId, WORKSPACE)];
      if (cursor) {
        const after = keysetAfter(keys, decodeKeysetCursor(keys, cursor));
        if (after) where.push(after);
      }
      const rows = await db
        .select()
        .from(table)
        .where(and(...where))
        .orderBy(...keysetOrderBy(keys))
        .limit(pageSize + 1);

      const page = takePage(rows as Record<string, unknown>[], pageSize, keys);
      for (const row of page.rows) ids.push(row.id as string);
      if (page.nextCursor === null) return ids;
      cursor = page.nextCursor;
    }
    throw new Error('페이지 순회가 끝나지 않는다');
  }

  it('enum 정렬 키(type)가 Postgres에서 enum 비교로 해석된다', async () => {
    // 파라미터가 text로 굳으면 여기서 `operator does not exist` 로 죽는다.
    const after = keysetAfter(ENTITY_KEYS, {
      type: 'person',
      name: '김민수',
      id: '00000000-0000-4000-8000-000000000000',
    });
    const rows = await db
      .select()
      .from(entities)
      .where(and(eq(entities.workspaceId, WORKSPACE), after))
      .orderBy(...keysetOrderBy(ENTITY_KEYS));
    // person/김민수 3건은 id 비교로 걸러지고 나머지는 전부 뒤에 온다.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.type !== 'person' || r.name !== '김민수')).toBe(
      false,
    );
  });

  it('3단 키(entities)를 어떤 페이지 크기로 넘겨도 전건 한 번씩', async () => {
    for (const pageSize of [1, 2, 3, 7, 8]) {
      const ids = await pageThrough(ENTITY_KEYS, entities, pageSize);
      expect(ids.length, `pageSize=${pageSize}`).toBe(7);
      expect(new Set(ids).size, `pageSize=${pageSize} 중복`).toBe(7);
    }
  });

  it('NULL validFrom(ASC NULLS LAST)이 섞여도 전건 한 번씩, NULL은 맨 뒤', async () => {
    for (const pageSize of [1, 2, 3, 4, 7]) {
      const ids = await pageThrough(RELATIONSHIP_KEYS, relationships, pageSize);
      expect(ids.length, `pageSize=${pageSize}`).toBe(7);
      expect(new Set(ids).size, `pageSize=${pageSize} 중복`).toBe(7);
    }
    // NULL 묶음이 정말 마지막 두 건인지 확인.
    const ordered = await db
      .select()
      .from(relationships)
      .where(eq(relationships.workspaceId, WORKSPACE))
      .orderBy(...keysetOrderBy(RELATIONSHIP_KEYS));
    expect(ordered.slice(-2).every((r) => r.validFrom === null)).toBe(true);
    expect(ordered.slice(0, -2).every((r) => r.validFrom !== null)).toBe(true);
  });

  it('빈 결과는 항목도 커서도 없다', async () => {
    const rows = await db
      .select()
      .from(entities)
      .where(eq(entities.workspaceId, '22222222-2222-4222-8222-222222222222'))
      .orderBy(...keysetOrderBy(ENTITY_KEYS))
      .limit(11);
    const page = takePage(rows as Record<string, unknown>[], 10, ENTITY_KEYS);
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
