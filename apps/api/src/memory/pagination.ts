/**
 * 커서(keyset) 페이지네이션 유틸 — Memory·Graph 목록 API 공용.
 *
 * 왜 offset이 아니라 커서인가:
 *  - offset은 깊은 페이지에서 앞의 N행을 매번 버리므로 데이터가 쌓이면 느려진다.
 *  - 이 목록들은 전부 시간순이라 페이지를 넘기는 중에 행이 삽입되면 offset은
 *    같은 행을 두 번 주거나(중복) 건너뛴다(누락). keyset은 "마지막으로 본 정렬 키
 *    이후"를 조건으로 걸므로 삽입과 무관하다.
 *
 * 왜 tie-breaker(id)가 필수인가:
 *  - `extractedAt`/`createdAt`/`validFrom`은 유일하지 않다. 같은 timestamp 행이
 *    여러 개면 `ts < cursor.ts` 조건이 그 묶음을 통째로 건너뛰고, `ts <= cursor.ts`는
 *    통째로 다시 준다. 정렬 키 끝에 유일한 `id`를 붙여 전순서를 만든 뒤
 *    사전식(lexicographic) 비교를 걸어야 건너뜀·중복이 둘 다 사라진다.
 *
 * NULL 정렬 키(예: `relationships.validFrom`)는 Postgres 기본 규약을 그대로 따른다:
 * ASC는 NULLS LAST, DESC는 NULLS FIRST. {@link keysetAfter}가 이 규약에 맞춰
 * "커서보다 뒤"를 만든다(아래 표 참조).
 *
 * | 방향 | 커서 값 | "이 자리에서 커서보다 뒤"          |
 * |------|---------|-----------------------------------|
 * | asc  | 값 있음 | `col > v` (+ nullable이면 `OR col IS NULL`) |
 * | asc  | null    | 없음(NULL이 마지막 묶음)           |
 * | desc | 값 있음 | `col < v`                          |
 * | desc | null    | `col IS NOT NULL` (NULL이 첫 묶음) |
 *
 * 커서 본문은 base64url(JSON)이며 **불투명(opaque)** 하다. 클라이언트는 해석하지
 * 말고 그대로 돌려주면 된다. 위조·손상된 커서는 조용히 첫 페이지로 되돌리지 않고
 * 400을 던진다 — 조용한 리셋은 클라이언트를 무한 루프에 빠뜨린다.
 */
import { BadRequestException } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  or,
  type Column,
  type SQL,
} from 'drizzle-orm';

/* -------------------------------------------------------------------------- */
/* 상한                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `limit` 미지정 시 기본 페이지 크기. **미지정 = 무제한이면 상한이 없는 것과 같다.**
 * 목록 화면 한 뷰포트를 채우고도 남는 크기이면서, 원문/출처 조인이 붙어도
 * 응답이 커지지 않는 값으로 잡았다.
 */
export const DEFAULT_PAGE_SIZE = 50;

/** 클라이언트가 요청할 수 있는 최대 페이지 크기(초과 요청은 400). */
export const MAX_PAGE_SIZE = 200;

/* -------------------------------------------------------------------------- */
/* 정렬 키 선언                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 하나의 정렬 키. 목록의 `ORDER BY`와 커서 조건은 **이 선언 하나**에서 파생되므로
 * 둘이 어긋날 수 없다(어긋나면 곧 항목 건너뜀·중복이다).
 */
export interface KeysetKey {
  /** 커서 페이로드의 필드명. 조회한 행의 프로퍼티명과 같아야 한다. */
  name: string;
  column: Column;
  direction: 'asc' | 'desc';
  /** NULL을 가질 수 있는 정렬 키인지. 마지막 tie-breaker 키는 항상 non-null이어야 한다. */
  nullable?: boolean;
  /** 커서 문자열 → SQL 바인딩 값(기본: 문자열 그대로 — uuid/text/enum). */
  parse?: (raw: string) => unknown;
}

/** timestamp 정렬 키용 파서(커서에는 ISO 문자열로 담긴다). */
export function parseCursorTimestamp(raw: string): Date {
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new BadRequestException('cursor is invalid');
  }
  return value;
}

/** 커서 페이로드 — 정렬 키 이름 → 값(ISO 문자열/텍스트) 또는 null. */
export type CursorPayload = Record<string, string | null>;

/* -------------------------------------------------------------------------- */
/* 인코딩/디코딩                                                               */
/* -------------------------------------------------------------------------- */

/** 행 값 → 커서 문자열. Date는 ISO, null은 null(NULL 정렬 키 묶음 표시). */
function toCursorValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** 페이지 마지막 행에서 다음 페이지 커서를 만든다. */
export function encodeKeysetCursor(
  keys: readonly KeysetKey[],
  row: Record<string, unknown>,
): string {
  const payload: CursorPayload = {};
  for (const key of keys) {
    payload[key.name] = toCursorValue(row[key.name]);
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * 커서 문자열 → 페이로드. 정렬 키 선언에 없는 필드는 버리고, 선언된 키가 빠졌거나
 * 타입이 다르면 400. (다른 목록의 커서를 붙여 넣는 실수를 여기서 잡는다.)
 */
export function decodeKeysetCursor(
  keys: readonly KeysetKey[],
  raw: string,
): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('cursor is invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException('cursor is invalid');
  }

  const source = parsed as Record<string, unknown>;
  const payload: CursorPayload = {};
  for (const key of keys) {
    const value = source[key.name];
    if (value === null) {
      // tie-breaker(id)는 NULL일 수 없다 — null이면 조작된 커서다.
      if (!key.nullable) throw new BadRequestException('cursor is invalid');
      payload[key.name] = null;
    } else if (typeof value === 'string') {
      payload[key.name] = value;
    } else {
      throw new BadRequestException('cursor is invalid');
    }
  }
  return payload;
}

/* -------------------------------------------------------------------------- */
/* SQL 조각                                                                    */
/* -------------------------------------------------------------------------- */

/** 선언에서 그대로 파생한 `ORDER BY` 절. */
export function keysetOrderBy(keys: readonly KeysetKey[]): SQL[] {
  return keys.map((key) =>
    key.direction === 'asc' ? asc(key.column) : desc(key.column),
  );
}

/** 이 자리의 값이 커서와 같음. */
function keyEquals(key: KeysetKey, value: string | null): SQL {
  if (value === null) return isNull(key.column);
  return eq(key.column, key.parse ? key.parse(value) : value);
}

/** 이 자리에서 커서보다 뒤(상단 표 참조). 뒤가 존재할 수 없으면 undefined. */
function keyStrictlyAfter(key: KeysetKey, value: string | null): SQL | undefined {
  if (key.direction === 'asc') {
    // ASC = NULLS LAST. 커서가 NULL 묶음 안이면 이 자리에서 더 뒤는 없다.
    if (value === null) return undefined;
    const bound = gt(key.column, key.parse ? key.parse(value) : value);
    return key.nullable ? or(bound, isNull(key.column)) : bound;
  }
  // DESC = NULLS FIRST. 커서가 NULL 묶음 안이면 non-NULL 행이 전부 뒤다.
  if (value === null) return isNotNull(key.column);
  return lt(key.column, key.parse ? key.parse(value) : value);
}

/**
 * "커서 행보다 정렬상 엄격히 뒤"를 뜻하는 WHERE 조각(사전식 비교).
 *
 * `(k1, k2, … kn)` 에 대해
 *   `after(k1) OR (eq(k1) AND after(k2)) OR … OR (eq(k1..kn-1) AND after(kn))`
 * 을 만든다. 마지막 키가 유일(id)이므로 동일 timestamp 묶음 안에서도 정확히
 * 한 번씩만 지나간다.
 */
export function keysetAfter(
  keys: readonly KeysetKey[],
  cursor: CursorPayload,
): SQL | undefined {
  const clauses: SQL[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const strictly = keyStrictlyAfter(keys[i], cursor[keys[i].name]);
    if (!strictly) continue; // 이 자리에는 뒤가 없다 — 더 깊은 키로 내려간다.
    if (i === 0) {
      clauses.push(strictly);
      continue;
    }
    const prefix = keys
      .slice(0, i)
      .map((key) => keyEquals(key, cursor[key.name]));
    const combined = and(...prefix, strictly);
    if (combined) clauses.push(combined);
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

/* -------------------------------------------------------------------------- */
/* 페이지 절단                                                                 */
/* -------------------------------------------------------------------------- */

/** 한 페이지의 행 + 다음 페이지 커서(없으면 null). */
export interface PageSlice<T> {
  rows: T[];
  nextCursor: string | null;
}

/**
 * `limit + 1`행을 조회한 결과에서 한 페이지를 잘라 낸다. 여분 1행의 유무가 곧
 * "다음 페이지 있음"이므로 별도 COUNT 쿼리가 필요 없다.
 *
 * 마지막 페이지와 빈 결과는 `nextCursor: null`이다 — 커서가 남아 있으면
 * 클라이언트가 빈 페이지를 한 번 더 받는다.
 *
 * 절단을 투영(projection)보다 **먼저** 해야 한다. 여분 행까지 원문/출처를 조인하면
 * 페이지마다 쓸데없는 조회가 한 건씩 붙는다.
 */
export function takePage<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  keys: readonly KeysetKey[],
): PageSlice<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    rows: pageRows,
    nextCursor: hasMore && last ? encodeKeysetCursor(keys, last) : null,
  };
}
