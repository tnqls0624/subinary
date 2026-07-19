/**
 * Hybrid RAG retrieval (Phase 7 Build Spec §1.2/§6.2).
 *
 * Runs two independent searches over a workspace's chunks and fuses them:
 *   - FTS: `pg_trgm similarity(text, query)` above a fixed threshold, ranked
 *     by similarity descending.
 *   - Vector: chunk embedding vs the question embedding by cosine distance
 *     (`<=>`), ranked ascending.
 * The two rankings are merged with Reciprocal Rank Fusion (`@family/rag`,
 * k=60), the merged candidates are reranked (`RerankerProvider`, mock keeps
 * order), and the top-K survivors become citations.
 *
 * Ownership (PRD §26): every search asserts the caller owns the workspace
 * (`workspaces.ownerUserId === userId`, else 403) *and* scopes every SQL read
 * to that `workspaceId` in the WHERE clause, so a non-owner can never surface
 * another workspace's chunks. {@link RetrievalService.assertOwnedWorkspace} is
 * also re-invoked just before the LLM sees any context (see `AiQueryService`).
 *
 * Evidence sufficiency is app logic, not the LLM (spec §1.3): a result carries
 * `hasFtsMatch` only when its chunk cleared the FTS threshold. In the mock
 * pipeline vector similarity is not meaningful, so keyword (FTS) matching is
 * the deterministic evidence signal — `hasEvidence` is true iff a returned item
 * has a FTS match.
 *
 * Logging never emits chunk text, PII, secrets, or embedding values — only
 * counts and identifiers (spec §0).
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { ProviderSet, RerankDocument } from '@family/ai-providers';
import type { Citation, ChunkSourceType } from '@family/contracts';
import { modelAliasTraceMetadata, schema, type Db } from '@family/database';
import { reciprocalRankFusion, toVectorLiteral } from '@family/rag';
import { MODEL_SERVING_TASKS } from '@family/shared';

import { AI_PROVIDERS } from '../ai/ai.constants';
import { DB } from '../database/database.constants';
import { ModelServingService } from '../model-serving/model-serving.service';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * FTS evidence threshold (spec §1.2/§1.3). A chunk is a keyword match only when
 * `similarity(text, query)` strictly exceeds this. Fixed for the mock pipeline;
 * a real provider would additionally weigh vector similarity via config.
 */
const FTS_SIMILARITY_THRESHOLD = 0.1;

/** Per-source candidate pool size fed into the RRF fusion before reranking. */
const CANDIDATE_LIMIT = 50;

/** Default / maximum number of returned results (mirrors the contract). */
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

/** Citation snippet length cap (single collapsed line). */
const SNIPPET_MAX_LEN = 200;

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Options for {@link RetrievalService.search}. */
export interface RetrievalSearchOptions {
  workspaceId: string;
  query: string;
  topK?: number;
}

/**
 * A single ranked retrieval hit. Carries the full chunk `text` (used to build
 * the LLM context in `AiQueryService`) alongside the API-facing projection; the
 * controller drops `text` when mapping to the `retrievalResponseSchema`.
 */
export interface RetrievedItem {
  chunkId: string;
  text: string;
  snippet: string;
  score: number;
  hasFtsMatch: boolean;
  citation: Citation;
}

/** Result of {@link RetrievalService.search}. */
export interface RetrievalResult {
  items: RetrievedItem[];
  hasEvidence: boolean;
}

/** Candidate chunk row loaded for citation assembly. */
interface ChunkRow {
  id: string;
  sourceType: string;
  sourceRefId: string;
  channelName: string | null;
  text: string;
  occurredAt: Date;
}

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AI_PROVIDERS) private readonly providers: ProviderSet,
    private readonly modelServing: ModelServingService,
  ) {}

  /**
   * Asserts `userId` owns `workspaceId` (PRD §26). Missing workspace → 404;
   * another owner → 403. Called at the start of every search and again by the
   * query service immediately before the LLM receives any context.
   */
  async assertOwnedWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }
    const [row] = await this.db
      .select({ ownerUserId: schema.workspaces.ownerUserId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);

    if (!row) {
      throw new NotFoundException('workspace not found');
    }
    if (row.ownerUserId !== userId) {
      throw new ForbiddenException('not the workspace owner');
    }
  }

  /**
   * Hybrid FTS + vector search over an owned workspace, fused with RRF and
   * reranked to top-K. Returns citations plus the app-logic `hasEvidence` flag.
   */
  async search(
    userId: string,
    options: RetrievalSearchOptions,
  ): Promise<RetrievalResult> {
    const { workspaceId, query } = options;
    await this.assertOwnedWorkspace(userId, workspaceId);
    const [embeddingServing, rerankerServing] = await Promise.all([
      this.modelServing.assertEmbedding(
        { workspaceId },
        MODEL_SERVING_TASKS.RAG_EMBEDDING,
        this.providers.embedding,
      ),
      this.modelServing.assertReranker(
        { workspaceId },
        MODEL_SERVING_TASKS.RAG_RERANKER,
        this.providers.reranker,
      ),
    ]);

    const topK = this.clampTopK(options.topK);

    // 1) Question embedding (mock: deterministic 256-dim).
    const embedded = await this.providers.embedding.embed([query], {
      task: 'rag-query-embedding',
      promptVersion: 'query-embedding-v1',
      ...modelAliasTraceMetadata(embeddingServing),
    });
    const queryVec = embedded[0];
    if (
      !queryVec ||
      queryVec.length !== this.providers.embedding.dimensions ||
      queryVec.length !== schema.EMBEDDING_DIM
    ) {
      throw new BadRequestException('failed to embed the query');
    }

    // 2) FTS ranking — trigram similarity above the evidence threshold.
    const simExpr = sql<number>`similarity(${schema.chunks.text}, ${query})`;
    const ftsRows = await this.db
      .select({ id: schema.chunks.id })
      .from(schema.chunks)
      .where(
        and(
          eq(schema.chunks.workspaceId, workspaceId),
          isNull(schema.chunks.deletedAt),
          sql`${simExpr} > ${FTS_SIMILARITY_THRESHOLD}`,
        ),
      )
      .orderBy(desc(simExpr))
      .limit(CANDIDATE_LIMIT);

    const ftsMatchIds = new Set(ftsRows.map((r) => r.id));
    const ftsRanking = ftsRows.map((r, index) => ({ id: r.id, rank: index + 1 }));

    // 3) Vector ranking — cosine distance ascending over embedded chunks.
    const vecLiteral = toVectorLiteral(queryVec);
    const distExpr = sql<number>`${schema.embeddings.embedding} <=> ${vecLiteral}::vector`;
    const vecRows = await this.db
      .select({ id: schema.chunks.id })
      .from(schema.chunks)
      .innerJoin(
        schema.embeddings,
        eq(schema.embeddings.chunkId, schema.chunks.id),
      )
      .where(
        and(
          eq(schema.chunks.workspaceId, workspaceId),
          isNull(schema.chunks.deletedAt),
          eq(schema.embeddings.model, this.providers.embedding.model),
          eq(schema.embeddings.dim, this.providers.embedding.dimensions),
        ),
      )
      .orderBy(asc(distExpr))
      .limit(CANDIDATE_LIMIT);

    const vecRanking = vecRows.map((r, index) => ({ id: r.id, rank: index + 1 }));

    // 4) RRF fusion (score descending).
    const fused = reciprocalRankFusion([ftsRanking, vecRanking]);
    if (fused.length === 0) {
      this.logger.log(
        `retrieval workspace=${workspaceId} fts=0 vec=0 fused=0 returned=0 hasEvidence=false`,
      );
      return { items: [], hasEvidence: false };
    }

    // 5) Load candidate chunks (re-scoped to the owned workspace as defense in
    // depth) and rerank in fused order.
    const scoreById = new Map(fused.map((f) => [f.id, f.score]));
    const candidateIds = fused.map((f) => f.id);
    const rows = await this.db
      .select({
        id: schema.chunks.id,
        sourceType: schema.chunks.sourceType,
        sourceRefId: schema.chunks.sourceRefId,
        channelName: schema.chunks.channelName,
        text: schema.chunks.text,
        occurredAt: schema.chunks.occurredAt,
      })
      .from(schema.chunks)
      .where(
        and(
          eq(schema.chunks.workspaceId, workspaceId),
          isNull(schema.chunks.deletedAt),
          inArray(schema.chunks.id, candidateIds),
        ),
      );
    const byId = new Map<string, ChunkRow>(rows.map((row) => [row.id, row]));

    const documents: RerankDocument[] = [];
    for (const f of fused) {
      const row = byId.get(f.id);
      if (row) {
        documents.push({ id: row.id, text: row.text });
      }
    }

    const reranked = await this.providers.reranker.rerank({
      query,
      documents,
      topK,
      metadata: {
        task: 'rag-rerank',
        promptVersion: 'rrf-rerank-v1',
        ...modelAliasTraceMetadata(rerankerServing),
      },
    });

    // 6) Assemble citations. `score` is the RRF fusion score (unitless); the
    // reranker only selects/orders. Mock reranker preserves fused order, so the
    // items stay RRF-descending.
    const items: RetrievedItem[] = [];
    for (const result of reranked.results) {
      const row = byId.get(result.document.id);
      if (!row) {
        continue;
      }
      const score = scoreById.get(row.id) ?? 0;
      const hasFtsMatch = ftsMatchIds.has(row.id);
      const snippet = buildSnippet(row.text);
      const citation: Citation = {
        chunkId: row.id,
        sourceType: normalizeSourceType(row.sourceType),
        channelName: row.channelName,
        sourceRefId: row.sourceRefId,
        occurredAt: row.occurredAt.toISOString(),
        snippet,
        score,
      };
      items.push({
        chunkId: row.id,
        text: row.text,
        snippet,
        score,
        hasFtsMatch,
        citation,
      });
    }

    const hasEvidence = items.some((it) => it.hasFtsMatch);
    this.logger.log(
      `retrieval workspace=${workspaceId} fts=${ftsRows.length} ` +
        `vec=${vecRows.length} fused=${fused.length} returned=${items.length} ` +
        `hasEvidence=${hasEvidence}`,
    );

    return { items, hasEvidence };
  }

  /** Clamps the requested top-K to `[1, MAX_TOP_K]` (default {@link DEFAULT_TOP_K}). */
  private clampTopK(topK: number | undefined): number {
    if (topK === undefined || !Number.isInteger(topK) || topK < 1) {
      return DEFAULT_TOP_K;
    }
    return Math.min(topK, MAX_TOP_K);
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Narrows the stored `sourceType` string to the contract enum. */
function normalizeSourceType(value: string): ChunkSourceType {
  return value === 'slack_message' ? 'slack_message' : 'slack_thread';
}

/** Builds a single-line, length-capped snippet (whitespace collapsed). */
function buildSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SNIPPET_MAX_LEN) {
    return collapsed;
  }
  return `${collapsed.slice(0, SNIPPET_MAX_LEN)}…`;
}
