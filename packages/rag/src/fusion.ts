/**
 * Rank fusion for hybrid retrieval (Phase 7 spec §1.2 / §3).
 *
 * Reciprocal Rank Fusion (RRF) combines several independently-ranked result lists
 * (e.g. FTS and vector search) into one ranking without requiring their scores to
 * be on the same scale: `score(id) = Σ 1 / (k + rank_i)` over every list the id
 * appears in. Higher score = better match. Pure and deterministic.
 */

/** One `(id, rank)` entry within a single ranked list. `rank` is caller-assigned. */
export interface RankedItem {
  id: string;
  /** Position of this id in its source list (RRF accepts 0- or 1-based ranks). */
  rank: number;
}

/** A fused result: the id and its summed reciprocal-rank score. */
export interface FusedItem {
  id: string;
  score: number;
}

/** Default RRF constant (Cormack et al. 2009); dampens the weight of top ranks. */
export const RRF_K = 60;

/**
 * Merge several ranked lists via Reciprocal Rank Fusion (Phase 7 spec §1.2).
 *
 * @param rankings one entry per source list; each is a list of `{ id, rank }`.
 * @param k RRF constant (default {@link RRF_K}); must be `> 0`.
 * @returns fused `{ id, score }` sorted by score descending, ties broken by `id`
 *          ascending for deterministic output. Each id appears exactly once.
 * @throws {RangeError} if `k <= 0`.
 */
export function reciprocalRankFusion(
  rankings: RankedItem[][],
  k: number = RRF_K,
): FusedItem[] {
  if (!(k > 0)) {
    throw new RangeError(`reciprocalRankFusion: k must be > 0, received ${k}`);
  }
  const scores = new Map<string, number>();
  for (const list of rankings) {
    for (const { id, rank } of list) {
      const contribution = 1 / (k + rank);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    }
  }
  return [...scores.entries()]
    .map(([id, score]): FusedItem => ({ id, score }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
}

/**
 * Convert a pgvector cosine distance (`<=>`, range `[0, 2]`) to a similarity-style
 * score where higher = more similar (Phase 7 spec §3, optional helper):
 * `1 - distance` (i.e. the cosine similarity). Not used by {@link reciprocalRankFusion}
 * (which needs only ranks) but handy when a raw similarity is wanted for
 * display / thresholds.
 */
export function cosineDistanceToScore(dist: number): number {
  return 1 - dist;
}
