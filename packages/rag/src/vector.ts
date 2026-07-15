/**
 * pgvector literal helpers (Phase 7 spec §2 / §3).
 *
 * pgvector accepts vectors as a bracketed, comma-separated decimal string, e.g.
 * `[0.1,0.2,0.3]`. {@link toVectorLiteral} renders a `number[]` into that form for
 * binding into a drizzle `sql` fragment (cosine distance `<=>`).
 */

/**
 * Render a numeric vector as a pgvector literal string `"[v1,v2,...]"`
 * (Phase 7 spec §3). An empty vector yields `"[]"`.
 *
 * @throws {RangeError} if any component is not finite (`NaN` / `±Infinity`) —
 *         pgvector rejects such literals, so we fail fast rather than emit invalid
 *         SQL.
 */
export function toVectorLiteral(vec: number[]): string {
  for (let i = 0; i < vec.length; i += 1) {
    if (!Number.isFinite(vec[i])) {
      throw new RangeError(
        `toVectorLiteral: component at index ${i} is not finite`,
      );
    }
  }
  return `[${vec.join(',')}]`;
}
