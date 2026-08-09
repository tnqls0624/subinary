/**
 * 커서 페이지네이션 검증.
 *
 * 세 층으로 나눈다.
 *  1. **코덱** — 커서를 왕복해도 값이 보존되는지, 위조·타 목록 커서를 400으로
 *     막는지(조용히 첫 페이지로 되돌리면 클라이언트가 무한 루프에 빠진다).
 *  2. **생성 SQL** — `keysetAfter`가 실제로 만드는 WHERE 절을 문자열로 굳혀 둔다.
 *     방향(asc/desc)·NULL 규약·tie-breaker가 조용히 뒤집히는 것을 여기서 잡는다.
 *  3. **페이지 순회 시뮬레이션** — 동일 timestamp가 여러 건인 데이터셋을 끝까지
 *     넘기며 **누락 0 · 중복 0**을 확인한다. 2가 굳힌 규칙을 그대로 메모리에서
 *     실행해, 규칙 자체가 옳은지(= tie-breaker가 정말 필요한지)를 보인다.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { schema } from '@family/database';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetAfter,
  keysetOrderBy,
  parseCursorTimestamp,
  takePage,
  type KeysetKey,
} from './pagination';

const dialect = new PgDialect();

/** 생성된 SQL 조각을 파라미터와 함께 읽을 수 있는 형태로 뽑는다. */
function render(fragment: ReturnType<typeof keysetAfter>): {
  sql: string;
  params: unknown[];
} {
  if (!fragment) throw new Error('expected a SQL fragment');
  const query = dialect.sqlToQuery(fragment);
  return { sql: query.sql, params: query.params };
}

/* -------------------------------------------------------------------------- */
/* 정렬 키 픽스처(운영 코드와 같은 모양)                                        */
/* -------------------------------------------------------------------------- */

/** `createdAt desc` + tie-breaker `id desc` — memories 목록과 동일. */
const DESC_KEYS: readonly KeysetKey[] = [
  {
    name: 'createdAt',
    column: schema.memories.createdAt,
    direction: 'desc',
    parse: parseCursorTimestamp,
  },
  { name: 'id', column: schema.memories.id, direction: 'desc' },
];

/** `validFrom asc`(nullable) + tie-breaker `id asc` — relationships 목록과 동일. */
const ASC_NULLABLE_KEYS: readonly KeysetKey[] = [
  {
    name: 'validFrom',
    column: schema.relationships.validFrom,
    direction: 'asc',
    nullable: true,
    parse: parseCursorTimestamp,
  },
  { name: 'id', column: schema.relationships.id, direction: 'asc' },
];

/** `type asc, name asc` + tie-breaker `id asc` — entities 목록과 동일(3단 키). */
const ENTITY_KEYS: readonly KeysetKey[] = [
  { name: 'type', column: schema.entities.type, direction: 'asc' },
  { name: 'name', column: schema.entities.name, direction: 'asc' },
  { name: 'id', column: schema.entities.id, direction: 'asc' },
];

/* -------------------------------------------------------------------------- */
/* 1. 코덱                                                                      */
/* -------------------------------------------------------------------------- */

describe('커서 코덱', () => {
  it('Date 정렬 키를 ISO로 담고 그대로 되읽는다', () => {
    const cursor = encodeKeysetCursor(DESC_KEYS, {
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      id: 'a1',
    });
    expect(decodeKeysetCursor(DESC_KEYS, cursor)).toEqual({
      createdAt: '2026-08-01T10:00:00.000Z',
      id: 'a1',
    });
  });

  it('NULL 정렬 키(= NULL 묶음 안)를 null 그대로 왕복한다', () => {
    const cursor = encodeKeysetCursor(ASC_NULLABLE_KEYS, {
      validFrom: null,
      id: 'r9',
    });
    expect(decodeKeysetCursor(ASC_NULLABLE_KEYS, cursor)).toEqual({
      validFrom: null,
      id: 'r9',
    });
  });

  it('커서에 없는 필드는 버리고 선언된 키만 남긴다', () => {
    const raw = Buffer.from(
      JSON.stringify({ createdAt: '2026-08-01T00:00:00.000Z', id: 'x', evil: 1 }),
      'utf8',
    ).toString('base64url');
    expect(decodeKeysetCursor(DESC_KEYS, raw)).toEqual({
      createdAt: '2026-08-01T00:00:00.000Z',
      id: 'x',
    });
  });

  it('망가진 커서·타 목록 커서·null tie-breaker는 400으로 막는다', () => {
    // base64가 아님.
    expect(() => decodeKeysetCursor(DESC_KEYS, '!!!not-base64!!!')).toThrow();
    // JSON이지만 객체가 아님.
    const notObject = Buffer.from('[1,2]', 'utf8').toString('base64url');
    expect(() => decodeKeysetCursor(DESC_KEYS, notObject)).toThrow();
    // 다른 목록(relationships)의 커서를 memories 목록에 붙여 넣음 → 키 누락.
    const foreign = encodeKeysetCursor(ASC_NULLABLE_KEYS, {
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      id: 'r1',
    });
    expect(() => decodeKeysetCursor(DESC_KEYS, foreign)).toThrow();
    // tie-breaker는 NULL일 수 없다(조작된 커서).
    const nullId = Buffer.from(
      JSON.stringify({ createdAt: '2026-08-01T00:00:00.000Z', id: null }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeKeysetCursor(DESC_KEYS, nullId)).toThrow();
  });

  it('잘못된 timestamp 커서 값은 SQL로 흘러가기 전에 막힌다', () => {
    expect(() => parseCursorTimestamp('not-a-date')).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 생성 SQL                                                                  */
/* -------------------------------------------------------------------------- */

describe('keysetAfter 가 만드는 WHERE 절', () => {
  it('DESC 2단 키는 (ts <) OR (ts = AND id <) 로 전개된다', () => {
    const { sql, params } = render(
      keysetAfter(DESC_KEYS, {
        createdAt: '2026-08-01T10:00:00.000Z',
        id: 'a1',
      }),
    );
    expect(sql).toBe(
      '("memories"."created_at" < $1 or ("memories"."created_at" = $2 and "memories"."id" < $3))',
    );
    // 커서의 ISO 문자열은 컬럼 매퍼를 거쳐 timestamp로 바인딩된다(원 시각 보존).
    expect(new Date(params[0] as string).toISOString()).toBe(
      '2026-08-01T10:00:00.000Z',
    );
    expect(params[2]).toBe('a1');
  });

  it('ASC nullable 키는 NULLS LAST 규약대로 NULL 묶음을 뒤에 포함한다', () => {
    const { sql } = render(
      keysetAfter(ASC_NULLABLE_KEYS, {
        validFrom: '2026-01-01T00:00:00.000Z',
        id: 'r1',
      }),
    );
    // `validFrom > $1` 만 쓰면 NULL 행이 영영 안 나온다 → OR IS NULL 이 필수.
    expect(sql).toBe(
      '(("relationships"."valid_from" > $1 or "relationships"."valid_from" is null) or ' +
        '("relationships"."valid_from" = $2 and "relationships"."id" > $3))',
    );
  });

  it('ASC nullable 키의 커서가 NULL 묶음 안이면 그 묶음 내부만 진행한다', () => {
    const { sql, params } = render(
      keysetAfter(ASC_NULLABLE_KEYS, { validFrom: null, id: 'r5' }),
    );
    // NULL이 마지막 묶음이므로 이 자리에서 '더 뒤'는 없다 — id로만 전진한다.
    expect(sql).toBe(
      '("relationships"."valid_from" is null and "relationships"."id" > $1)',
    );
    expect(params).toEqual(['r5']);
  });

  it('3단 키는 사전식으로 전개되고 마지막에 tie-breaker가 붙는다', () => {
    const { sql } = render(
      keysetAfter(ENTITY_KEYS, { type: 'person', name: '민수', id: 'e1' }),
    );
    expect(sql).toBe(
      '("entities"."type" > $1 or ' +
        '("entities"."type" = $2 and "entities"."name" > $3) or ' +
        '("entities"."type" = $4 and "entities"."name" = $5 and "entities"."id" > $6))',
    );
  });

  it('ORDER BY 는 커서 조건과 같은 선언에서 나온다', () => {
    const order = keysetOrderBy(DESC_KEYS).map(
      (fragment) => dialect.sqlToQuery(fragment).sql,
    );
    expect(order).toEqual([
      '"memories"."created_at" desc',
      '"memories"."id" desc',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 페이지 절단                                                               */
/* -------------------------------------------------------------------------- */

describe('takePage', () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({
    id: `id-${i}`,
    createdAt: new Date(2026, 0, 10 - i),
  }));

  it('limit+1 행이 오면 여분을 잘라 내고 다음 커서를 준다', () => {
    const page = takePage(rows, 3, DESC_KEYS);
    expect(page.rows.map((r) => r.id)).toEqual(['id-0', 'id-1', 'id-2']);
    expect(page.nextCursor).not.toBeNull();
    // 커서는 잘라 낸 여분이 아니라 **페이지 마지막 행**을 가리켜야 한다.
    expect(decodeKeysetCursor(DESC_KEYS, page.nextCursor as string).id).toBe(
      'id-2',
    );
  });

  it('마지막 페이지(정확히 limit 이하)는 커서를 남기지 않는다', () => {
    expect(takePage(rows, 4, DESC_KEYS).nextCursor).toBeNull();
    expect(takePage(rows.slice(0, 2), 4, DESC_KEYS).nextCursor).toBeNull();
  });

  it('빈 결과는 항목도 커서도 없다', () => {
    const page = takePage([], DEFAULT_PAGE_SIZE, DESC_KEYS);
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('기본 상한과 최대 상한이 살아 있다', () => {
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThan(0);
    expect(MAX_PAGE_SIZE).toBeGreaterThanOrEqual(DEFAULT_PAGE_SIZE);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 순회 시뮬레이션 — 누락 0 · 중복 0                                          */
/* -------------------------------------------------------------------------- */

/**
 * `keysetAfter`가 굳힌 규칙을 메모리에서 그대로 실행하는 참조 구현.
 * (2번 테스트가 생성 SQL을 이 규칙에 고정해 두므로, 여기서 규칙의 옳고 그름을 본다.)
 */
function isAfter(
  keys: readonly KeysetKey[],
  cursor: Record<string, string | null>,
  row: Record<string, string | null>,
): boolean {
  for (const key of keys) {
    const cursorValue = cursor[key.name];
    const rowValue = row[key.name];
    if (rowValue === cursorValue) continue; // 같으면 다음 키로.
    if (key.direction === 'asc') {
      // NULLS LAST: NULL이 가장 큼.
      if (rowValue === null) return true;
      if (cursorValue === null) return false;
      return rowValue > cursorValue;
    }
    // NULLS FIRST: NULL이 가장 앞.
    if (cursorValue === null) return true;
    if (rowValue === null) return false;
    return rowValue < cursorValue;
  }
  return false; // 완전히 같은 행 = '뒤'가 아니다(중복 방지).
}

/** ORDER BY를 메모리에서 재현한다(전순서는 tie-breaker가 보장). */
function sortRows(
  keys: readonly KeysetKey[],
  rows: Record<string, string | null>[],
): Record<string, string | null>[] {
  // isAfter(a, b) = "b가 a보다 뒤" → a가 앞이므로 -1.
  return [...rows].sort((a, b) => (isAfter(keys, a, b) ? -1 : 1));
}

/** 커서로 끝까지 순회한다. */
function pageThrough(
  keys: readonly KeysetKey[],
  rows: Record<string, string | null>[],
  pageSize: number,
): { ids: string[]; pages: number } {
  const ordered = sortRows(keys, rows);
  const ids: string[] = [];
  let cursor: Record<string, string | null> | null = null;
  let pages = 0;

  for (;;) {
    const at = cursor;
    // 명시 주석: cursor 재대입과 얽혀 추론이 순환하지 않도록 타입을 고정한다.
    const scoped: Record<string, string | null>[] = at
      ? ordered.filter((row) => isAfter(keys, at, row))
      : ordered;
    const window: Record<string, string | null>[] = scoped.slice(
      0,
      pageSize + 1,
    );
    const hasMore = window.length > pageSize;
    const page: Record<string, string | null>[] = hasMore
      ? window.slice(0, pageSize)
      : window;
    pages += 1;
    for (const row of page) ids.push(row.id as string);
    if (!hasMore) return { ids, pages };
    cursor = page[page.length - 1];
    if (pages > 100) throw new Error('페이지 순회가 끝나지 않는다');
  }
}

describe('커서 순회 — 동일 timestamp 다건에서도 누락·중복 없음', () => {
  // 12건 중 8건이 같은 timestamp(한 워커 잡이 같은 시각으로 기록한 묶음).
  const SHARED = '2026-08-01T00:00:00.000Z';
  const desc = [
    { id: 'z-newest', createdAt: '2026-08-02T00:00:00.000Z' },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `tie-${String(i).padStart(2, '0')}`,
      createdAt: SHARED,
    })),
    { id: 'a-older-1', createdAt: '2026-07-31T00:00:00.000Z' },
    { id: 'a-older-2', createdAt: '2026-07-30T00:00:00.000Z' },
    { id: 'a-older-3', createdAt: '2026-07-29T00:00:00.000Z' },
  ];

  it('페이지 크기가 동일 timestamp 묶음을 가로질러도 전건을 정확히 한 번씩 준다', () => {
    for (const pageSize of [1, 2, 3, 5, 7, 12, 13]) {
      const { ids } = pageThrough(DESC_KEYS, desc, pageSize);
      expect(new Set(ids).size, `pageSize=${pageSize} 중복`).toBe(desc.length);
      expect(ids.length, `pageSize=${pageSize} 누락/중복`).toBe(desc.length);
    }
  });

  it('tie-breaker가 없으면 같은 묶음이 무너진다 — 이게 id를 넣는 이유다', () => {
    const noTieBreaker: readonly KeysetKey[] = [DESC_KEYS[0]];
    const { ids } = pageThrough(noTieBreaker, desc, 3);
    // 동일 timestamp 8건이 통째로 건너뛰어져 전건에 못 미친다.
    expect(ids.length).toBeLessThan(desc.length);
  });

  it('NULL validFrom 이 섞여도(ASC NULLS LAST) 전건을 한 번씩 준다', () => {
    const rows = [
      { id: 'r1', validFrom: '2026-01-01T00:00:00.000Z' },
      { id: 'r2', validFrom: '2026-01-01T00:00:00.000Z' },
      { id: 'r3', validFrom: '2026-02-01T00:00:00.000Z' },
      { id: 'r4', validFrom: null },
      { id: 'r5', validFrom: null },
      { id: 'r6', validFrom: null },
    ];
    for (const pageSize of [1, 2, 3, 4, 6]) {
      const { ids } = pageThrough(ASC_NULLABLE_KEYS, rows, pageSize);
      expect(ids.length, `pageSize=${pageSize}`).toBe(rows.length);
      expect(new Set(ids).size).toBe(rows.length);
      // NULL 묶음은 항상 마지막에 온다(NULLS LAST).
      expect(ids.slice(-3).sort()).toEqual(['r4', 'r5', 'r6']);
    }
  });

  it('3단 키(entities)도 같은 (type,name) 묶음을 정확히 넘긴다', () => {
    const rows = [
      { id: 'e1', type: 'person', name: '김민수' },
      { id: 'e2', type: 'person', name: '김민수' },
      { id: 'e3', type: 'person', name: '박지훈' },
      { id: 'e4', type: 'technology', name: 'redis' },
      { id: 'e5', type: 'technology', name: 'redis' },
    ];
    for (const pageSize of [1, 2, 3, 5]) {
      const { ids } = pageThrough(ENTITY_KEYS, rows, pageSize);
      expect(ids.length, `pageSize=${pageSize}`).toBe(rows.length);
      expect(new Set(ids).size).toBe(rows.length);
    }
  });

  it('빈 목록은 한 페이지에서 끝난다', () => {
    expect(pageThrough(DESC_KEYS, [], 5)).toEqual({ ids: [], pages: 1 });
  });
});
