/** Injection token for `{ llm, embedding, reranker }` created by `createProviders`. */
export const AI_PROVIDERS = 'AI_PROVIDERS' as const;

/** 선택적으로 구성된 traffic/shadow 후보 LLM provider injection token. */
export const AI_CANDIDATE_LLM = 'AI_CANDIDATE_LLM' as const;
