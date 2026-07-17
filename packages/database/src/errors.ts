/**
 * Postgres 에러 코드 판별 헬퍼.
 *
 * drizzle-orm 0.4x부터 쿼리 실패를 `DrizzleQueryError`로 감싸고, 원본
 * postgres.js 에러(실제 SQLSTATE `code` 포함)를 `.cause`에 담는다. 따라서
 * 최상위 `error.code`만 보면 unique 위반 등을 놓친다(→ 500). 아래 헬퍼는
 * `cause` 체인을 훑어 SQLSTATE를 추출하므로 drizzle 래핑 여부와 무관하게 동작한다.
 */

/** Postgres unique-violation SQLSTATE. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * 에러(및 `cause` 체인)에서 Postgres SQLSTATE(`code`)를 추출한다. 없으면 undefined.
 * 순환 cause 방어를 위해 방문 집합을 사용한다.
 */
export function getPgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Postgres unique-constraint(23505) 위반인지. drizzle 래핑(cause) 포함 판별. */
export function isUniqueViolation(error: unknown): boolean {
  return getPgErrorCode(error) === PG_UNIQUE_VIOLATION;
}
