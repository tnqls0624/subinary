import { describe, expect, it } from 'vitest';

import {
  extractGraph,
  extractTechTerms,
  type EntityDraft,
  type GraphChunkInput,
  type GraphPersonInput,
  type RelationshipDraft,
} from './graph.js';

/** Fixed instants (Asia/Seoul-agnostic — the extractor only compares/copies). */
const T1 = new Date('2026-01-10T09:00:00.000Z');
const T2 = new Date('2026-02-20T09:00:00.000Z');
const T0 = new Date('2025-06-01T09:00:00.000Z');

/** Build a chunk with sensible defaults for terse test bodies. */
function chunk(over: Partial<GraphChunkInput> & { text: string }): GraphChunkInput {
  return {
    occurredAt: T1,
    sourceRefId: 'ref-1',
    authorCanonicalName: null,
    ...over,
  };
}

/** Find the single relationship of a given type, asserting there is exactly one. */
function relOfType(
  rels: RelationshipDraft[],
  type: RelationshipDraft['type'],
): RelationshipDraft {
  const matches = rels.filter((r) => r.type === type);
  expect(matches).toHaveLength(1);
  return matches[0];
}

/** Find an entity by canonicalName, asserting it exists. */
function entity(entities: EntityDraft[], canonicalName: string): EntityDraft {
  const found = entities.find((e) => e.canonicalName === canonicalName);
  expect(found, `entity ${canonicalName}`).toBeDefined();
  return found as EntityDraft;
}

describe('extractTechTerms — dictionary matching', () => {
  it('matches dictionary terms and preserves definition order', () => {
    const terms = extractTechTerms('Route53 인증서를 ACM으로 재발급했다');
    expect(terms).toEqual([
      { canonical: 'route53', display: 'Route53' },
      { canonical: 'acm', display: 'ACM' },
    ]);
  });

  it('de-duplicates a canonical matched via multiple patterns', () => {
    // 'postgresql' and 'postgres' both map to canonical 'postgresql'.
    const terms = extractTechTerms('PostgreSQL 과 postgres 는 같은 DB');
    expect(terms).toEqual([{ canonical: 'postgresql', display: 'PostgreSQL' }]);
  });

  it('respects word boundaries so short keys do not match inside words', () => {
    // 'rest' must not match 'restore'; 'acm' must not match 'acme'.
    expect(extractTechTerms('restore the acme site')).toEqual([]);
    // Explicit surface forms still match.
    expect(extractTechTerms('a REST endpoint').map((t) => t.canonical)).toEqual([
      'rest',
    ]);
  });

  it('matches case-insensitively', () => {
    const terms = extractTechTerms('ROUTE53 와 redis 와 DOCKER').map((t) => t.canonical);
    expect(terms).toEqual(['route53', 'redis', 'docker']);
  });

  it('returns an empty array for empty input', () => {
    expect(extractTechTerms('')).toEqual([]);
    expect(extractTechTerms('사람들끼리 나눈 잡담')).toEqual([]);
  });
});

describe('extractGraph — technology relationships', () => {
  it('emits one relates_to per technology pair, ordered by canonical', () => {
    const { relationships } = extractGraph(
      [chunk({ text: 'PostgreSQL 파티셔닝을 Redis 캐시와 함께 도입 결정', sourceRefId: 'r1' })],
      [],
    );
    const rel = relOfType(relationships, 'relates_to');
    // 'postgresql' < 'redis' → source is the smaller canonical.
    expect(rel.sourceCanonical).toBe('postgresql');
    expect(rel.targetCanonical).toBe('redis');
    expect(rel.sourceType).toBe('technology');
    expect(rel.targetType).toBe('technology');
    expect(rel.confidence).toBe(70);
    expect(rel.sourceRefId).toBe('r1');
    expect(rel.validFrom).toBe(T1);
  });

  it('emits resolves (conf 90) when a resolution marker is present', () => {
    const { relationships } = extractGraph(
      [
        chunk({
          text: 'Route53 인증서 만료 장애를 ACM 재발급으로 해결',
          sourceRefId: 'r2',
        }),
      ],
      [],
    );
    const rel = relOfType(relationships, 'resolves');
    expect(rel.sourceCanonical).toBe('acm'); // 'acm' < 'route53'
    expect(rel.targetCanonical).toBe('route53');
    expect(rel.confidence).toBe(90);
  });

  it('emits no pair relationship for a single technology', () => {
    const { relationships } = extractGraph([chunk({ text: 'Docker 배포만 언급' })], []);
    expect(relationships).toEqual([]);
  });
});

describe('extractGraph — works_on', () => {
  it('emits person → technology works_on when the author is known', () => {
    const persons: GraphPersonInput[] = [{ canonicalName: 'U123', name: '수빈' }];
    const { relationships } = extractGraph(
      [chunk({ text: 'Docker 이미지를 빌드했다', authorCanonicalName: 'U123' })],
      persons,
    );
    const rel = relOfType(relationships, 'works_on');
    expect(rel.sourceCanonical).toBe('U123');
    expect(rel.sourceType).toBe('person');
    expect(rel.targetCanonical).toBe('docker');
    expect(rel.targetType).toBe('technology');
    expect(rel.confidence).toBe(80);
  });

  it('omits works_on when the author is null', () => {
    const { relationships } = extractGraph(
      [chunk({ text: 'Docker 이미지를 빌드했다', authorCanonicalName: null })],
      [{ canonicalName: 'U123', name: '수빈' }],
    );
    expect(relationships.filter((r) => r.type === 'works_on')).toEqual([]);
  });
});

describe('extractGraph — entities & temporal anchoring', () => {
  it('registers every person entity with validFrom = min occurredAt', () => {
    const persons: GraphPersonInput[] = [
      { canonicalName: 'U1', name: 'A' },
      { canonicalName: 'U2', name: 'B' },
    ];
    const { entities } = extractGraph(
      [
        chunk({ text: 'Redis 도입', occurredAt: T1, sourceRefId: 'r1' }),
        chunk({ text: 'Redis 튜닝', occurredAt: T0, sourceRefId: 'r2' }),
      ],
      persons,
    );
    const persons2 = entities.filter((e) => e.type === 'person');
    expect(persons2.map((e) => e.canonicalName)).toEqual(['U1', 'U2']);
    for (const p of persons2) {
      expect(p.validFrom).toBe(T0); // earliest of T1 / T0
    }
  });

  it('sets a technology validFrom to its earliest occurrence across chunks', () => {
    const { entities } = extractGraph(
      [
        chunk({ text: 'Redis 도입', occurredAt: T2, sourceRefId: 'r1' }),
        chunk({ text: 'Redis 튜닝', occurredAt: T0, sourceRefId: 'r2' }),
      ],
      [],
    );
    const redis = entity(entities, 'redis');
    expect(redis.type).toBe('technology');
    expect(redis.name).toBe('Redis');
    expect(redis.validFrom).toBe(T0);
  });
});

describe('extractGraph — dedupe & empty input', () => {
  it('collapses duplicate (source, type, target, sourceRefId) relationships', () => {
    // Two chunks sharing a sourceRefId produce the same acm↔route53 resolves edge.
    const shared = { sourceRefId: 'dup' as const };
    const { relationships } = extractGraph(
      [
        chunk({ text: 'Route53 장애를 ACM 재발급으로 해결', ...shared, occurredAt: T1 }),
        chunk({ text: 'Route53 재시도 후 ACM 으로 복구', ...shared, occurredAt: T2 }),
      ],
      [],
    );
    const resolves = relationships.filter((r) => r.type === 'resolves');
    expect(resolves).toHaveLength(1);
    expect(resolves[0].validFrom).toBe(T1); // first occurrence kept
  });

  it('returns empty entities and relationships for empty input', () => {
    expect(extractGraph([], [])).toEqual({ entities: [], relationships: [] });
    // No chunks → no temporal anchor → persons are not emitted either.
    expect(extractGraph([], [{ canonicalName: 'U1', name: 'A' }])).toEqual({
      entities: [],
      relationships: [],
    });
  });
});
