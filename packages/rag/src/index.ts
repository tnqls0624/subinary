export type {
  ThreadMessageInput,
  ThreadInput,
  ChunkSourceType,
  ChunkDraft,
} from './chunking.js';
export { buildThreadChunkText, chunkSlackThreads } from './chunking.js';

export type { RankedItem, FusedItem } from './fusion.js';
export { reciprocalRankFusion, cosineDistanceToScore, RRF_K } from './fusion.js';

export { toVectorLiteral } from './vector.js';

export type { MemoryType, MemoryCandidateDraft } from './extract.js';
export { extractMemoryCandidates } from './extract.js';

export type {
  GraphEntityType,
  GraphRelationshipType,
  TechTerm,
  TechTermMatch,
  GraphPersonInput,
  GraphChunkInput,
  EntityDraft,
  RelationshipDraft,
} from './graph.js';
export {
  TECH_TERMS,
  RESOLUTION_MARKERS,
  extractTechTerms,
  extractGraph,
} from './graph.js';
