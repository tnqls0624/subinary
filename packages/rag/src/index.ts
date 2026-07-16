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
