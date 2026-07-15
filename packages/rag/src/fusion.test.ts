import { describe, expect, it } from 'vitest';

import {
  cosineDistanceToScore,
  reciprocalRankFusion,
  RRF_K,
  type RankedItem,
} from './fusion.js';

describe('reciprocalRankFusion', () => {
  it('merges two ranked lists and orders by summed RRF score descending', () => {
    const fts: RankedItem[] = [
      { id: 'a', rank: 0 },
      { id: 'b', rank: 1 },
      { id: 'c', rank: 2 },
    ];
    const vec: RankedItem[] = [
      { id: 'b', rank: 0 },
      { id: 'c', rank: 1 },
      { id: 'd', rank: 2 },
    ];

    const fused = reciprocalRankFusion([fts, vec]);

    // b: 1/61 + 1/60, c: 1/62 + 1/61, a: 1/60, d: 1/62  -> b > c > a > d
    expect(fused.map((x) => x.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 60, 12);
    expect(fused[2].score).toBeCloseTo(1 / 60, 12);

    // Scores are strictly non-increasing.
    for (let i = 1; i < fused.length; i += 1) {
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
    }
  });

  it('handles a single ranked list', () => {
    const fused = reciprocalRankFusion([
      [
        { id: 'x', rank: 0 },
        { id: 'y', rank: 1 },
      ],
    ]);

    expect(fused.map((x) => x.id)).toEqual(['x', 'y']);
    expect(fused[0].score).toBeCloseTo(1 / 60, 12);
    expect(fused[1].score).toBeCloseTo(1 / 61, 12);
  });

  it('returns an empty array for empty input (no lists / all empty lists)', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it('sums the contributions of an id appearing in multiple lists', () => {
    const fused = reciprocalRankFusion([
      [{ id: 'z', rank: 0 }],
      [{ id: 'z', rank: 0 }],
      [{ id: 'z', rank: 0 }],
      [{ id: 'w', rank: 0 }],
    ]);

    expect(fused).toHaveLength(2);
    expect(fused[0].id).toBe('z');
    expect(fused[0].score).toBeCloseTo(3 / 60, 12);
    expect(fused[1].id).toBe('w');
    expect(fused[1].score).toBeCloseTo(1 / 60, 12);
  });

  it('breaks score ties deterministically by id ascending', () => {
    const fused = reciprocalRankFusion([
      [{ id: 'b', rank: 0 }],
      [{ id: 'a', rank: 0 }],
    ]);

    expect(fused.map((x) => x.id)).toEqual(['a', 'b']);
    expect(fused[0].score).toBeCloseTo(fused[1].score, 12);
  });

  it('honours a custom k', () => {
    const fused = reciprocalRankFusion([[{ id: 'a', rank: 0 }]], 1);
    expect(fused[0].score).toBeCloseTo(1 / 1, 12);
    expect(RRF_K).toBe(60);
  });

  it('throws when k is not positive', () => {
    expect(() => reciprocalRankFusion([], 0)).toThrow(RangeError);
    expect(() => reciprocalRankFusion([], -5)).toThrow(RangeError);
  });
});

describe('cosineDistanceToScore', () => {
  it('maps cosine distance to cosine similarity (1 - dist)', () => {
    expect(cosineDistanceToScore(0)).toBe(1);
    expect(cosineDistanceToScore(1)).toBe(0);
    expect(cosineDistanceToScore(2)).toBe(-1);
  });
});
