/**
 * Deterministic temporal-graph extraction (Phase 9 spec §3).
 *
 * Phase 9's Temporal GraphRAG turns retrieval chunks + Slack users into
 * entity/relationship drafts. The PRD (§22) allows LLM extraction, but to keep
 * the pipeline verifiable in a mock environment we extract with deterministic
 * rules: a technology dictionary ({@link TECH_TERMS}), co-occurrence within a
 * chunk, and `slack_users → person`. {@link extractGraph} is a pure function with
 * no randomness, no clock and no I/O, so it can be swapped for an LLM extractor
 * later without changing this signature (spec §22, "순수 함수 경계 유지").
 *
 * This package is intentionally dependency-free (spec §3): it owns its own shapes
 * and never imports `@family/database`, `@family/contracts` or drizzle. Callers
 * map {@link EntityDraft} onto `entities`
 * (`UNIQUE(workspaceId, type, canonicalName)`, upsert with `least(validFrom)`)
 * and {@link RelationshipDraft} onto `relationships`
 * (`UNIQUE(workspaceId, sourceEntityId, type, targetEntityId, sourceRefId)`,
 * insert-or-ignore), resolving `canonicalName → id` upstream.
 *
 * Logging discipline (spec §0): this module never logs; callers must log only
 * counts / identifiers, never chunk `text` or extracted names (potential PII).
 */

/** Entity kind emitted by the rule extractor. The `entities` table supports more
 * kinds (project/decision/incident/topic, PRD §22), but deterministic extraction
 * only produces `person` (from `slack_users`) and `technology` (from the
 * dictionary). */
export type GraphEntityType = 'person' | 'technology';

/** Relationship kind emitted by the rule extractor. The `relationships` table
 * supports more kinds (uses/decides/supersedes, PRD §22); `supersedes` is created
 * only via the explicit supersede API, never by extraction (spec §1.3). */
export type GraphRelationshipType = 'relates_to' | 'resolves' | 'works_on';

/** A dictionary technology term: its canonical key, human-facing display name and
 * the (case-insensitive) surface patterns that signal its presence. */
export interface TechTerm {
  /** Normalised lowercase key; becomes `entities.canonicalName`. */
  canonical: string;
  /** Display form; becomes `entities.name`. */
  display: string;
  /** Surface strings to match against chunk text (matched case-insensitively). */
  patterns: string[];
}

/** A single dictionary match returned by {@link extractTechTerms}. */
export interface TechTermMatch {
  canonical: string;
  display: string;
}

/** A person to register as an entity — one per `slack_user` (spec §1.1). */
export interface GraphPersonInput {
  /** `entities.canonicalName` for the person (the Slack user id). */
  canonicalName: string;
  /** `entities.name` (realName ?? name). */
  name: string;
}

/** One retrieval chunk fed to the graph extractor. */
export interface GraphChunkInput {
  /** Combined chunk text (`"작성자: 내용"` join). */
  text: string;
  /** Absolute instant the chunk's source occurred (thread root `occurredAt`). */
  occurredAt: Date;
  /** Chunk `sourceRefId` — links every relationship back to its source (spec §1.2). */
  sourceRefId: string;
  /**
   * Canonical name of the chunk's representative author, when known. Drives
   * `person → technology` `works_on` edges. The Phase 9 worker passes `null`
   * (chunk schema carries no author yet, spec §5), so `works_on` is exercised
   * only through this pure function / its tests until author linking lands.
   */
  authorCanonicalName?: string | null;
}

/** An entity ready to be upserted into `entities` (spec §3). */
export interface EntityDraft {
  type: GraphEntityType;
  /** `person` = Slack user id, `technology` = normalised lowercase term. */
  canonicalName: string;
  name: string;
  /** Earliest occurrence: min chunk `occurredAt` (spec §1.1). */
  validFrom: Date;
}

/** A relationship ready to be upserted into `relationships` (spec §3). Canonical
 * names are resolved to entity ids by the caller. */
export interface RelationshipDraft {
  sourceCanonical: string;
  sourceType: GraphEntityType;
  targetCanonical: string;
  targetType: GraphEntityType;
  type: GraphRelationshipType;
  /** `validFrom` = the originating chunk's `occurredAt` (spec §1.2). */
  validFrom: Date;
  /** Originating chunk `sourceRefId` (part of the relationship uniqueness key). */
  sourceRefId: string;
  confidence: number;
}

/**
 * Technology dictionary (spec §3). Ordered by definition; {@link extractTechTerms}
 * preserves this order. Patterns include Latin surface forms common in
 * Korean-language Slack (e.g. `Route53`, `PostgreSQL`) plus a few Korean
 * transliterations, and are matched case-insensitively with alphanumeric word
 * boundaries so short keys (`s3`, `acm`, `rest`) do not match inside larger words.
 */
export const TECH_TERMS: TechTerm[] = [
  { canonical: 'route53', display: 'Route53', patterns: ['route53', 'route 53', '라우트53'] },
  { canonical: 'acm', display: 'ACM', patterns: ['acm'] },
  {
    canonical: 'postgresql',
    display: 'PostgreSQL',
    patterns: ['postgresql', 'postgres', '포스트그레스'],
  },
  { canonical: 'redis', display: 'Redis', patterns: ['redis', '레디스'] },
  { canonical: 's3', display: 'S3', patterns: ['s3'] },
  { canonical: 'minio', display: 'MinIO', patterns: ['minio', '미니오'] },
  { canonical: 'docker', display: 'Docker', patterns: ['docker', '도커'] },
  {
    canonical: 'kubernetes',
    display: 'Kubernetes',
    patterns: ['kubernetes', 'k8s', '쿠버네티스'],
  },
  { canonical: 'nginx', display: 'Nginx', patterns: ['nginx', '엔진엑스'] },
  { canonical: 'graphql', display: 'GraphQL', patterns: ['graphql'] },
  { canonical: 'rest', display: 'REST', patterns: ['rest', 'restful'] },
  { canonical: 'bullmq', display: 'BullMQ', patterns: ['bullmq'] },
  { canonical: 'pgvector', display: 'pgvector', patterns: ['pgvector'] },
];

/**
 * Resolution markers (spec §1.2 / §3). When any appears in a chunk, that chunk's
 * technology pairs become `resolves` (incident → fix) rather than `relates_to`.
 * Korean markers are case-neutral; English markers are lowercase and matched
 * against lowercased text.
 */
export const RESOLUTION_MARKERS = [
  '해결',
  '복구',
  '조치',
  '재발급',
  '해소',
  'resolved',
  'fixed',
] as const;

/** Confidence for a `resolves` edge (resolution marker present). */
const CONFIDENCE_RESOLVES = 90;
/** Confidence for a bare `relates_to` co-occurrence edge. */
const CONFIDENCE_RELATES = 70;
/** Confidence for a `works_on` (person → technology) edge. */
const CONFIDENCE_WORKS_ON = 80;

/** True when `ch` is a Latin letter or digit (used for word-boundary checks). */
function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9]/.test(ch);
}

/**
 * True when `pattern` occurs in `lowerText` bounded by non-alphanumeric characters
 * (or string edges) on both sides. This keeps short keys from matching inside
 * larger alphanumeric runs (`rest` must not match `restful`/`interesting`) while
 * still matching before Korean particles (`postgresql을`) and punctuation. Both
 * arguments must already be lowercased.
 */
function patternOccurs(lowerText: string, pattern: string): boolean {
  if (pattern.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = lowerText.indexOf(pattern, from);
    if (idx < 0) return false;
    const before = idx > 0 ? lowerText[idx - 1] : undefined;
    const afterIdx = idx + pattern.length;
    const after = afterIdx < lowerText.length ? lowerText[afterIdx] : undefined;
    if (!isAlnum(before) && !isAlnum(after)) return true;
    from = idx + 1;
  }
}

/**
 * Extract the distinct technology terms present in `text` by dictionary matching
 * (spec §3). Matching is case-insensitive with word boundaries; the result is
 * de-duplicated by `canonical` and ordered by {@link TECH_TERMS} definition order.
 * Returns `[]` for empty / non-string input.
 *
 * Pure and deterministic: the same input always yields the same output.
 */
export function extractTechTerms(text: string): TechTermMatch[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lower = text.toLowerCase();
  const matches: TechTermMatch[] = [];
  const seen = new Set<string>();
  for (const term of TECH_TERMS) {
    if (seen.has(term.canonical)) continue;
    const hit = term.patterns.some((pattern) =>
      patternOccurs(lower, pattern.toLowerCase()),
    );
    if (hit) {
      seen.add(term.canonical);
      matches.push({ canonical: term.canonical, display: term.display });
    }
  }
  return matches;
}

/** True when `text` contains any resolution marker (case-insensitive). */
function hasResolutionMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return RESOLUTION_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/** Earlier of two dates by wall-clock instant. */
function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * Extract entity and relationship drafts from retrieval chunks and Slack users
 * using deterministic rules (Phase 9 spec §3).
 *
 * Entities:
 * - `person`: every {@link GraphPersonInput}, `validFrom` = the minimum chunk
 *   `occurredAt`. When there are no chunks there is no temporal anchor (and no
 *   clock is available in this pure function), so persons are not emitted.
 * - `technology`: every dictionary term appearing in any chunk, `validFrom` = the
 *   earliest `occurredAt` of the chunks it appears in (spec §1.1).
 *
 * Relationships (per chunk, `validFrom` = chunk `occurredAt`, `sourceRefId` =
 * chunk `sourceRefId`, spec §1.2):
 * - each distinct technology pair (ordered by canonical so `(A,B)` is emitted
 *   once) → `resolves` (confidence {@link CONFIDENCE_RESOLVES}) when the chunk
 *   carries a resolution marker, otherwise `relates_to` (confidence
 *   {@link CONFIDENCE_RELATES}).
 * - when `authorCanonicalName` is set, `person → technology` `works_on`
 *   (confidence {@link CONFIDENCE_WORKS_ON}) for each technology in the chunk.
 *
 * Duplicate relationships sharing `(sourceCanonical, type, targetCanonical,
 * sourceRefId)` are collapsed, mirroring the `relationships` uniqueness key.
 *
 * Pure and deterministic: no randomness, no clock, no I/O.
 */
export function extractGraph(
  chunks: GraphChunkInput[],
  persons: GraphPersonInput[],
): { entities: EntityDraft[]; relationships: RelationshipDraft[] } {
  const entities: EntityDraft[] = [];
  const relationships: RelationshipDraft[] = [];

  if (chunks.length === 0) {
    return { entities, relationships };
  }

  // Minimum occurredAt across all chunks anchors person entities (spec §1.1).
  let minOccurredAt = chunks[0].occurredAt;
  for (const chunk of chunks) {
    minOccurredAt = earlier(minOccurredAt, chunk.occurredAt);
  }

  // Person entities: one per Slack user, de-duplicated by canonicalName.
  const seenPerson = new Set<string>();
  for (const person of persons) {
    if (seenPerson.has(person.canonicalName)) continue;
    seenPerson.add(person.canonicalName);
    entities.push({
      type: 'person',
      canonicalName: person.canonicalName,
      name: person.name,
      validFrom: minOccurredAt,
    });
  }

  // Technology entities: earliest occurrence per canonical, preserving first-seen
  // order for stable output.
  const techOrder: string[] = [];
  const techByCanonical = new Map<string, { display: string; validFrom: Date }>();
  for (const chunk of chunks) {
    for (const term of extractTechTerms(chunk.text)) {
      const existing = techByCanonical.get(term.canonical);
      if (existing === undefined) {
        techOrder.push(term.canonical);
        techByCanonical.set(term.canonical, {
          display: term.display,
          validFrom: chunk.occurredAt,
        });
      } else {
        existing.validFrom = earlier(existing.validFrom, chunk.occurredAt);
      }
    }
  }
  for (const canonical of techOrder) {
    const tech = techByCanonical.get(canonical);
    if (tech === undefined) continue;
    entities.push({
      type: 'technology',
      canonicalName: canonical,
      name: tech.display,
      validFrom: tech.validFrom,
    });
  }

  // Relationships per chunk, de-duplicated by (source, type, target, sourceRefId).
  const seenRel = new Set<string>();
  const pushRel = (rel: RelationshipDraft): void => {
    const key = `${rel.sourceCanonical}|${rel.type}|${rel.targetCanonical}|${rel.sourceRefId}`;
    if (seenRel.has(key)) return;
    seenRel.add(key);
    relationships.push(rel);
  };

  for (const chunk of chunks) {
    const terms = extractTechTerms(chunk.text);
    const canonicals = terms.map((t) => t.canonical).sort();

    // Technology pairs: relates_to, or resolves when a resolution marker is present.
    if (canonicals.length >= 2) {
      const resolved = hasResolutionMarker(chunk.text);
      const type: GraphRelationshipType = resolved ? 'resolves' : 'relates_to';
      const confidence = resolved ? CONFIDENCE_RESOLVES : CONFIDENCE_RELATES;
      for (let i = 0; i < canonicals.length; i += 1) {
        for (let j = i + 1; j < canonicals.length; j += 1) {
          pushRel({
            sourceCanonical: canonicals[i],
            sourceType: 'technology',
            targetCanonical: canonicals[j],
            targetType: 'technology',
            type,
            validFrom: chunk.occurredAt,
            sourceRefId: chunk.sourceRefId,
            confidence,
          });
        }
      }
    }

    // person → technology works_on, when the chunk's author is known.
    const author = chunk.authorCanonicalName;
    if (typeof author === 'string' && author.length > 0) {
      for (const term of terms) {
        pushRel({
          sourceCanonical: author,
          sourceType: 'person',
          targetCanonical: term.canonical,
          targetType: 'technology',
          type: 'works_on',
          validFrom: chunk.occurredAt,
          sourceRefId: chunk.sourceRefId,
          confidence: CONFIDENCE_WORKS_ON,
        });
      }
    }
  }

  return { entities, relationships };
}
