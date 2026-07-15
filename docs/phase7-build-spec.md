# Phase 7 Build Spec — Hybrid RAG (검색 + 출처 답변)

> Phase 0~6 규약 준수(패키지 `type:module` 금지, 공용 dev 이미지, 소스 바인드마운트, Asia/Seoul, 로그 Secret/PII 금지, 새 env는 `.env`도, 새 npm 의존성 시 lockfile 재생성, 교차모듈 `@UseGuards`는 가드 의존성까지 export, drizzle `GROUP BY` ordinal, SWC watch 재시작 후 포트 경합 시 컨테이너 clean restart).

---

## 0. 목표 & 완료 조건 (PRD §31 Phase 7)

범위: Slack 스레드 청킹 / Embedding / FTS / Vector Search / 검색 결과 병합 / Reranking / 출처 포함 답변.

완료 조건(실측, `scripts/verify-phase7.mjs`):
1. 과거 기술 질문에 관련 스레드 검색(관련 청크가 결과 Top에).
2. 정답 원문 Top 5 포함(키워드 질문 기준).
3. 주요 답변 출처 제공률 100%(답변마다 citations).
4. 근거 없는 질문은 답변 거부(refused).
5. 권한: 다른 workspace 데이터 유출 0(소유자만).

### 경계 & 전제
- **Mock provider로 파이프라인 완성**(PRD §3.4). Mock embedding은 **결정적** 256차원. 실제 OpenAI/Anthropic는 `EmbeddingProvider`/`LlmProvider` 뒤에서 교체(스켈레톤만, 검증은 mock). 실제 provider 차원이 256과 다르면 재임베딩 필요(문서화).
- 계산/판단(근거 충분성, 병합 순위)은 **앱 로직**(PRD §3.3). LLM은 컨텍스트 설명만.
- 장기 기억(memory)·GraphRAG·MCP는 Phase 8~10.

---

## 1. 핵심 설계 결정

### 1.1 청킹 = Slack 스레드 단위
스레드(threadTs 그룹)를 하나의 청크로 결합(맥락 보존): `text = 각 메시지 "작성자명: 내용" 을 ts순 개행 결합`. 비-스레드 단독 메시지도 청크. `occurredAt = 스레드 root occurredAt`. 멱등: `chunks` UNIQUE(workspaceId, sourceType, sourceRefId)(sourceRefId = threadTs 또는 messageId), 재인덱싱 onConflictDoUpdate(text/occurredAt 갱신).

### 1.2 하이브리드 검색 = FTS(trgm) + Vector, RRF 병합
- **FTS**: `pg_trgm similarity(chunk.text, query)` 상위(threshold 0.1) → rank.
- **Vector**: chunk embedding vs 질문 embedding 코사인 거리(`<=>`) 오름차순 → rank.
- **병합 = RRF**(Reciprocal Rank Fusion, k=60): `score = Σ 1/(k + rank_i)`. 스케일 무관하게 두 신호 결합(순수 함수 `@family/rag`).
- **Rerank**: `RerankerProvider.rerank`(Mock=순서 유지). 최종 top-K(기본 5).
- **권한**: 소유 workspace 청크만 검색(SQL WHERE), LLM 전달 직전 재검증(PRD §26).

### 1.3 근거 충분성 = 앱 로직(refused)
검색 결과가 비었거나, 상위 결과 중 **FTS 매칭(similarity>0.1)이 하나도 없으면** `refused=true`(LLM 호출 안 함). Mock 환경에선 벡터 유사도가 의미 없으므로 키워드(FTS) 매칭이 근거 판정을 지배 — 결정적 검증. (실제 provider에선 벡터 유사도 임계도 함께 사용하도록 threshold를 config로 노출.)

### 1.4 출처(citation)
각 결과 청크 → 원본 메시지/스레드로 역추적: `{ chunkId, sourceType, channelName, threadTs|ts, authorName?, occurredAt, snippet, score }`. 답변에 citations 배열 100% 포함. 답변 본문의 각 주장은 Mock LLM이 컨텍스트 발췌를 인용하는 형태.

---

## 2. 데이터 모델 — `packages/database` (schema.ts 확장)

pgvector `vector` 컬럼 사용(`drizzle-orm/pg-core`의 `vector`). 차원 = **256**(Mock 기준 고정, 상수 `EMBEDDING_DIM=256`).

```
chunks
  id uuid pk
  workspaceId uuid not null -> workspaces.id
  sourceType text not null                 -- 'slack_thread' | 'slack_message'
  sourceRefId text not null                -- threadTs 또는 message ts
  slackChannelId uuid null -> slack_channels.id
  channelName text null
  text text not null
  occurredAt timestamptz not null
  metadata jsonb not null default '{}'
  createdAt / updatedAt
  UNIQUE(workspaceId, sourceType, sourceRefId)
  INDEX(workspaceId), INDEX(occurredAt)
  GIN index on text (gin_trgm_ops)

embeddings
  id uuid pk
  chunkId uuid not null -> chunks.id        -- UNIQUE
  model text not null                       -- 'mock' 등
  dim integer not null
  embedding vector(256) not null
  createdAt
  UNIQUE(chunkId)
  -- HNSW cosine 인덱스: USING hnsw (embedding vector_cosine_ops)
```

추론 타입 export(Chunk/NewChunk, Embedding/NewEmbedding). 마이그레이션 0007. HNSW 인덱스가 generate에 없으면 마이그레이션 SQL에 `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` 수동 보강(pgvector 0.8 지원). GIN trgm 동일 확인.

> drizzle vector 컬럼: `vector('embedding', { dimensions: 256 }).notNull()`. 검색 쿼리는 `sql\`${embeddings.embedding} <=> ${toSql(vec)}\`` 형태(코사인 거리). 벡터 리터럴은 `[0.1,0.2,...]` 문자열.

---

## 3. `@family/rag` 패키지 (신규, 순수)
`packages/rag/`. Phase 0 공통 형태(tsup, type:module 없음, sideEffects:false, vitest). deps 없음.
- `src/chunking.ts`:
  - `interface ThreadInput { threadTs:string; channelName:string; slackChannelId:string; messages:{authorName:string; text:string; ts:string; occurredAt:Date}[] }`
  - `function buildThreadChunkText(msgs): string` — ts순 "작성자: 내용" 개행 결합, 빈 텍스트 skip.
  - `function chunkSlackThreads(threads: ThreadInput[]): ChunkDraft[]` — 스레드→청크(sourceType 'slack_thread', sourceRefId threadTs, occurredAt root).
  - `ChunkDraft { workspaceRef?; sourceType; sourceRefId; slackChannelId; channelName; text; occurredAt }`.
- `src/fusion.ts`:
  - `function reciprocalRankFusion(rankings: {id:string; rank:number}[][], k=60): {id:string; score:number}[]` — 여러 순위 리스트 RRF 병합, score 내림차순.
  - `function cosineDistanceToScore(dist:number): number`(선택).
- `src/vector.ts`:
  - `function toVectorLiteral(vec:number[]): string` — `[v1,v2,...]`(pgvector 리터럴).
- `src/index.ts` 배럴. vitest ≥8케이스(청킹 결합/빈메시지/RRF 병합 순위/단일리스트/빈입력/벡터 리터럴).

---

## 4. `@family/ai-providers` 확장
Phase 0 인터페이스 유지. 확장:
- `EmbeddingProvider`에 `readonly dimensions: number` + `readonly model: string`.
- `MockEmbeddingProvider`: **결정적** 256차원 — 텍스트를 토큰(공백/문장부호 분할)으로 나눠 각 토큰 해시를 256 버킷에 누적 → L2 정규화. 같은 텍스트 → 같은 벡터. `dimensions=256, model='mock'`.
- `MockRerankerProvider`: 입력 순서 유지(score = 1/(1+idx)).
- `MockLlmProvider.generate(req)`: 컨텍스트(passages)가 있으면 "기록에 따르면 …" + 각 passage 첫 문장 발췌를 인용, 없으면 "근거 없음". 결정적(랜덤/시간 없음). `GenerateRequest`에 `{ system?, question?, context?: {id,text}[] }` 확장 가능.
- `createProviders(cfg)`: provider='mock' 기본 → Mock. 'openai'/'anthropic'는 **스켈레톤**(throw 'not configured' 또는 env 키 없으면 Mock 폴백 + warning). Phase 7 검증은 mock.
- (선택) `OpenAiEmbeddingProvider` 스켈레톤(fetch 기반, 키 필요) — 파일만, 검증 미사용.

---

## 5. apps/worker — RAG 인덱싱
- `apps/worker/package.json`: `@family/rag`, `@family/ai-providers` 의존 추가.
- 큐 `QUEUE_NAMES.RAG_INDEX='rag-index'`(P… shared 수정은 §6 api가 담당하지만 worker도 참조 — shared는 api 파티션이 추가, worker는 import).
- `slack-import.processor` 확장: import 성공 후 `ragIndexQueue.add('index', { workspaceId }, { jobId: 'rag-index:'+workspaceId })`(중복 시 최신 우선; jobId 고정으로 과다 enqueue 방지 — 완료된 잡은 재실행 위해 removeOnComplete 고려).
- `rag-index.processor.ts`(`@Processor(RAG_INDEX)`): workspaceId의 slack_threads + 비-스레드 메시지 로드(작성자명 조인) → `chunkSlackThreads`/메시지 청크 → chunks upsert(onConflictDoUpdate) → 각 청크 `EmbeddingProvider.embed` → embeddings upsert(onConflictDoUpdate, vector 리터럴). 배치. Mock provider는 `createProviders({provider:'mock'})`로 생성(config.ai). 로그 count만.
- `processors.module`: RagIndexProcessor + registerQueue(RAG_INDEX) + AI provider provider(또는 서비스 내 생성).

## 6. apps/api — 검색 + AI 답변
### 6.1 배선
- `packages/shared/src/constants.ts`: `QUEUE_NAMES.RAG_INDEX='rag-index'`.
- `app.module.ts`: `RetrievalModule`, `AiQueryModule`(또는 하나의 `RagModule`) import.
- ai-providers는 기존 `AiModule`(Phase 0)이 `AI_PROVIDERS` 제공 — 재사용/확장.

### 6.2 retrieval.service (Db + AI_PROVIDERS 주입)
- `search(userId, { workspaceId, query, topK=5 }): RetrievalResult` :
  1. 소유 workspace 검증(workspaces.ownerUserId==userId, 아니면 Forbidden).
  2. 질문 embedding(`EmbeddingProvider.embed([query])[0]`).
  3. FTS: `select id, similarity(text,query) as sim from chunks where workspaceId=? and similarity>0.1 order by sim desc limit N` → ftsRanking.
  4. Vector: `select id, embedding<=>queryVec as dist from chunks join embeddings order by dist asc limit N` → vecRanking.
  5. RRF 병합(`reciprocalRankFusion([ftsRanking, vecRanking])`).
  6. 상위 후보 청크 로드 → `RerankerProvider.rerank` → topK.
  7. 각 결과에 citation 메타(channelName/sourceRefId/occurredAt/snippet/score, hasFtsMatch).
  8. 반환 { items:[{chunkId, text, snippet, citation, score, hasFtsMatch}], hasEvidence: (FTS 매칭 있는 항목 존재) }.
### 6.3 ai-query.service
- `workQuery(userId, { workspaceId, question })`:
  1. `retrieval.search`.
  2. `hasEvidence===false` → `{ refused:true, reason:'근거를 찾지 못했습니다', citations:[] }`(LLM 호출 안 함).
  3. context = top 청크들 → `LlmProvider.generate({ question, context })` → answer.
  4. `{ refused:false, answer, citations: items.map(citation), meta:{ retrievedCount, model } }`.
### 6.4 컨트롤러 (`@Controller('ai')`, 일반 인증)
- `POST /v1/ai/work-query` → workQuery. body { workspaceId, question }.
- `POST /v1/ai/retrieval` (또는 GET) → search(디버그/검증용). body { workspaceId, query, topK? }.
- CurrentUser. 비소유자 403.
- DTO createZodDto(@family/contracts).

---

## 7. API 계약 — `packages/contracts` (`src/ai.ts` + 배럴)
- `workQueryRequestSchema` = `{ workspaceId: uuid, question: string.min(1).max(1000) }`
- `citationSchema` = `{ chunkId, sourceType, channelName: nullable, sourceRefId, occurredAt: string, snippet: string, score: number }`
- `workQueryResponseSchema` = `{ refused: boolean, answer: string.nullable(), reason: string.nullable(), citations: citation[], meta: { retrievedCount: int, model: string } }`
- `retrievalRequestSchema` = `{ workspaceId: uuid, query: string.min(1), topK: int.min(1).max(20).default(5) }`
- `retrievalResponseSchema` = `{ hasEvidence: boolean, items: { chunkId, snippet, score: number, hasFtsMatch: boolean, citation }[] }`
- 추론 타입.

---

## 8. Docker / 마이그레이션
- 새 의존성: `@family/rag`(신규, vitest), worker에 `@family/rag`+`@family/ai-providers`, api는 ai-providers 기존. ai-providers 변경(차원). lockfile 재생성.
- 새 테이블(chunks/embeddings vector(256)) → generate 0007 + HNSW/GIN 인덱스 확인·보강.
- 통합: lockfile → build → rag/ai-providers vitest → generate 0007(+인덱스) → up --force-recreate → verify-phase7.

## 9. 검증 — `scripts/verify-phase7.mjs`
1. userA 회원가입 + Slack import(기술 스레드: 예 "Route53 인증서 갱신 실패 → ACM 재발급으로 해결", "PostgreSQL 파티셔닝 도입 결정", 일반 잡담 스레드 등 구분되는 키워드).
2. RAG 인덱싱 폴링(≤15s): chunks/embeddings 생성(retrieval이 결과 반환할 때까지).
3. work-query "Route53 인증서 문제 어떻게 해결했어?" → refused=false, citations 비어있지 않음, 정답 스레드가 citations Top5에(sourceRefId/channelName), answer non-empty.
4. retrieval 직접 호출 → hasEvidence=true, top 항목 hasFtsMatch=true, RRF score 내림차순.
5. 출처 100%: 답변 citations 모두 channelName/sourceRefId/occurredAt/snippet 포함.
6. 근거 없는 질문 "다음 분기 환율 전망은?" → refused=true, citations 빈 배열, answer null.
7. 권한: userB(비소유자) work-query/retrieval on userA workspace → 403.
8. 멱등: 재인덱싱(재import) 후 chunks count 안정(중복 없음).
통과/실패 카운트, 실패 시 exit 1.

## 10. 문서 / 커밋
- ADR: `docs/adr/0012-hybrid-rag-retrieval.md`(청킹/FTS+Vector/RRF/rerank/근거판정 앱로직/모델비종속 mock 근거).
- `docs/api/ai.md`: work-query/retrieval API + 응답(citations/refused) 예시.
- 커밋: `feat(db)` → `feat(rag)` → `feat(ai-providers)` → `feat(contracts)` → `feat(worker)` rag-index → `feat(ai)` retrieval+query → `chore(shared/api)` → `test`/`docs`.

## 11. 파티션 맵
- **P1 database**: chunks + embeddings(vector(256)) + 추론타입 + trgm/hnsw 인덱스.
- **P2 contracts**: `src/ai.ts` + index 배럴.
- **P3 rag**: `packages/rag/**`(chunking, fusion, vector, vitest).
- **P4 ai-providers**: `packages/ai-providers/**` Mock 확장(256 결정적 embedding, reranker, llm) + dimensions + createProviders + (선택)openai 스켈레톤 + vitest.
- **P5 worker-rag**: `apps/worker/src/processors/rag-index.processor.ts`, `slack-import.processor.ts`(enqueue 확장), `processors.module.ts`, `apps/worker/package.json`(@family/rag, @family/ai-providers).
- **P6 api-rag**: `apps/api/src/retrieval/**`, `apps/api/src/ai/`(ai-query service/controller — 기존 ai.module 확장 또는 신규), `packages/shared/src/constants.ts`(RAG_INDEX), `apps/api/src/app.module.ts`(모듈 import).
- **P7 verify+docs**: `scripts/verify-phase7.mjs`, ADR 0012, `docs/api/ai.md`.

주의: shared constants/app.module은 **P6만**. worker 파일은 **P5만**. 각 에이전트는 본 스펙 + phase6/0 스펙 + 기존 소스(slack service/processor, ai-providers Phase0, database schema, contracts, shared)를 Read. pgvector drizzle 사용법 주의(vector 컬럼/코사인 연산자/인덱스).
