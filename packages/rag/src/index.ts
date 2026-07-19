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

export type {
  DatasetSplitName,
  DatasetGroupHashSplitPolicy,
  DatasetGroupTimeSplitPolicy,
  DatasetSplitPolicy,
  ResolvedDatasetGroupTimeSplitPolicy,
  ResolvedDatasetSplitPolicy,
  DatasetSplitAssignmentInput,
  DatasetSplitAssignment,
  DatasetLeakageAudit,
  DatasetSplitPlan,
} from './dataset-split.js';
export {
  DEFAULT_DATASET_SPLIT_POLICY,
  DEFAULT_DATASET_TIME_SPLIT_POLICY,
  assignDatasetSplit,
  buildDatasetSplitPlan,
  validateDatasetLeakage,
  parseResolvedDatasetSplitPolicy,
} from './dataset-split.js';

export type {
  CanonicalJsonValue,
  ChunkRevisionIdentity,
  MemoryCandidateDatasetInput,
  MemoryCandidateDatasetRow,
  MemoryCandidateDatasetArtifact,
  MerchantCategoryDatasetInput,
  MerchantCategoryDatasetRow,
  MerchantCategoryDatasetArtifact,
  RagRetrievalDatasetInput,
  RagRetrievalDatasetRow,
  RagRetrievalDatasetArtifact,
} from './revisions.js';
export {
  RAG_CHUNKER_VERSION,
  RAG_REDACTION_VERSION,
  RAG_EMBEDDING_PREPROCESSING_VERSION,
  sha256Hex,
  canonicalJson,
  createChunkRevisionIdentity,
  createEmbeddingHash,
  buildMemoryCandidateDatasetArtifact,
  buildMerchantCategoryDatasetArtifact,
  buildRagRetrievalDatasetArtifact,
} from './revisions.js';

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
