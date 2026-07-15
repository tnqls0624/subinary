# ADR-0012: Hybrid RAG — 스레드 청킹 · FTS(trgm)+Vector 하이브리드 · RRF 병합 · rerank · 근거판정 앱로직 · 모델 비종속

## 제목

Slack 업무 기록에 대한 검색·질의응답을 **스레드 단위 청킹**으로 준비하고, **키워드(pg_trgm
FTS) + 의미(pgvector 코사인) 하이브리드 검색**을 **RRF(Reciprocal Rank Fusion)** 로 병합한 뒤
**Reranker** 로 상위 K개를 고르고, **근거 충분성 판정과 순위 병합을 애플리케이션 로직**으로
수행하며(LLM 은 컨텍스트 설명만), 임베딩/LLM/Reranker 를 **모델 비종속 provider 경계 뒤에서
Mock(결정적 256차원)** 으로 파이프라인을 완성하는 설계 채택(PRD §37/§3.3/§3.4/§26, Phase 7).

## 상태

승인됨 (Accepted) — 2026-07-16

## 배경

Phase 7 은 개인화 AI 의 검색/RAG 계층으로, Phase 6 이 수집한 Slack 스레드·메시지를 대상으로
**과거 기술 질문 검색**, **정답 원문 Top-K 포함**, **출처 포함 답변**, **근거 없는 질문 거부**,
**소유자 전용 접근**을 제공한다(PRD §31 Phase 7). 장기기억(memory)·GraphRAG·MCP 는 Phase 8~10
으로 미룬다.

요구 불변식:

- **관련 스레드 검색**: 과거 기술 질문에 관련 청크가 결과 상위에 온다.
- **정답 원문 Top-K 포함**: 키워드 질문 기준 정답 스레드가 Top-5 안에 든다.
- **출처 제공률 100%**: 모든 답변에 citations(채널/스레드/작성자/시각/발췌)가 붙는다.
- **근거 없는 질문 거부**: 근거가 없으면 환각 대신 `refused`.
- **접근제어(PRD §26)**: `workspaces.ownerUserId == 요청자`인 소유자 본인만. 다른 workspace
  데이터 유출 0.
- **모델 비종속(PRD §3.4)**: 실제 OpenAI/Anthropic 는 provider 경계 뒤에서 교체 가능하고, 검증은
  결정적 Mock 으로 완성한다.
- **계산은 앱 로직(PRD §3.3)**: 근거 충분성·순위 병합은 애플리케이션이 판단하고 LLM 은 컨텍스트를
  설명만 한다.
- **로그 비노출(PRD §11)**: 청크 원문/PII/secret/임베딩 값을 운영 로그에 남기지 않는다.

설계 포인트는 여섯 가지다. (1) 무엇을 검색 단위(청크)로 삼을 것인가, (2) 키워드 검색과 의미 검색을
어떻게 함께 쓸 것인가, (3) 서로 다른 신호의 순위를 어떻게 병합할 것인가, (4) 근거 충분성(거부
여부)을 무엇이 판단할 것인가, (5) 임베딩 차원과 provider 를 어떻게 고정/교체할 것인가, (6) 재인덱싱을
어떻게 멱등화할 것인가.

## 결정

### 1. 청킹 = Slack 스레드 단위(맥락 보존)

- 검색 단위(청크)는 **Slack 스레드**다. 스레드(같은 `threadTs` 그룹)의 메시지를 `ts` 오름차순으로
  모아 각 메시지를 `"작성자명: 내용"` 으로 개행 결합한 하나의 `text` 로 만든다(빈 텍스트 skip).
  스레드에 속하지 않는 **단독 메시지도 하나의 청크**다. `occurredAt` 은 스레드 root 의 `occurredAt`.
- 근거: 메시지 하나는 문맥이 부족해 의미 검색·인용 품질이 낮다. 스레드는 "문제 제기 → 논의 →
  결론"이 한 덩어리라 맥락이 보존되고, 인용 시 사람이 이해할 수 있는 최소 단위다.
- 물화: `chunks(workspaceId, sourceType∈{slack_thread,slack_message}, sourceRefId, channelName,
  text, occurredAt, metadata)`. `sourceRefId` 는 스레드면 `threadTs`, 단독 메시지면 message id/ts 다.
- 청킹 함수는 순수 패키지 `@family/rag`(`chunkSlackThreads`/`buildThreadChunkText`)에 두어 결정적·
  테스트 가능하게 한다.

### 2. 하이브리드 검색 = FTS(pg_trgm) + Vector(pgvector 코사인)

- **키워드 신호(FTS)**: `pg_trgm similarity(chunk.text, query) > 0.1` 상위를 rank 로 삼는다. trigram 은
  한국어에도 형태소 분석기 없이 동작하고 오탈자·부분일치에 강하다(GIN `gin_trgm_ops` 인덱스).
- **의미 신호(Vector)**: 질문 임베딩과 청크 임베딩의 **코사인 거리(`<=>`)** 오름차순을 rank 로 삼는다.
  `embeddings.embedding vector(256)` + **HNSW `vector_cosine_ops`** 인덱스(pgvector 0.8).
- 둘을 모두 쓰는 이유: 키워드는 정확 일치/희귀어에 강하고 의미 검색은 동의어/의역에 강하다. 서로의
  약점을 보완한다. Mock 환경에선 벡터 유사도가 의미를 갖지 않으므로 **FTS 가 근거를 지배**하고, 실제
  provider 로 교체하면 벡터 신호가 실질적으로 기여한다.
- **접근제어는 SQL WHERE 로 1차 강제**한다: 모든 검색은 `workspaceId` 로 제한하고, 그 workspace 를
  소유(`ownerUserId == 요청자`)하지 않으면 `Forbidden(403)`.

### 3. 병합 = RRF(Reciprocal Rank Fusion, k=60)

- FTS 순위와 Vector 순위는 **스케일이 전혀 다르다**(similarity 0~1 vs 코사인 거리). 점수를 직접 더하면
  한 신호가 지배한다. 그래서 **순위(rank)만** 쓰는 RRF 로 병합한다:
  `score(id) = Σ_i 1/(k + rank_i(id))`, `k=60`. 두 리스트 모두에 오른 청크가 가장 높은 점수를 받는다.
- RRF 는 순수 함수 `reciprocalRankFusion(rankings, k=60)`(`@family/rag/fusion`)로 구현해 결정적이고
  단위 테스트가 쉽다. 결과는 **score 내림차순**으로 정렬한다.
- **Rerank**: 병합 상위 후보를 `RerankerProvider.rerank` 로 재순위화해 최종 **top-K(기본 5)** 를 고른다.
  Mock reranker 는 입력 순서를 유지(`score = (n-idx)/n`)해 결정적이다. 실제 cross-encoder reranker 로
  교체할 자리를 남긴다.

### 4. 근거 충분성(refused) = 애플리케이션 로직

- **LLM 이 아니라 앱이** 근거 충분성을 판단한다(PRD §3.3). 검색 결과가 비었거나, 상위 결과 중
  **FTS 매칭(`similarity > 0.1`)이 하나도 없으면** `hasEvidence=false` → `refused=true` 로 **LLM 을 호출하지
  않는다**. 이렇게 하면 근거 없는 질문에 대한 환각을 원천 차단한다.
- Mock 환경에선 벡터 유사도가 의미가 없으므로 **키워드(FTS) 매칭이 근거 판정을 지배**해 결정적이다.
  실제 provider 에선 벡터 유사도 임계도 함께 쓰도록 threshold 를 config 로 노출한다(모델 교체 시 재조정).
- LLM 의 역할은 **컨텍스트 설명**뿐이다. Mock LLM 은 전달된 passages 가 있으면 "기록에 따르면 …" +
  각 passage 발췌를 인용하고, 없으면 "근거 없음"을 결정적으로 반환한다(랜덤/시간 사용 없음).

### 5. 출처(citation) = 원본으로 역추적, 답변 100% 포함

- 각 결과 청크는 원본 스레드/메시지로 역추적해 citation 을 만든다:
  `{ chunkId, sourceType, channelName, sourceRefId(threadTs|ts), occurredAt, snippet, score }`.
- 답변(`work-query`)에는 **citations 배열을 100% 포함**한다. `refused` 인 경우 citations 는 빈 배열이다.
  본문의 각 주장은 Mock LLM 이 컨텍스트 발췌를 인용하는 형태로 근거와 연결된다.
- **LLM 전달 직전 소유권 재검증**(PRD §26): SQL WHERE 로 1차 필터한 뒤, 컨텍스트를 LLM 에 넘기기
  직전에도 workspace 소유를 재확인해 방어적 이중 강제를 둔다.

### 6. 모델 비종속 provider + 결정적 Mock(256차원) + 멱등 인덱싱

- 임베딩/LLM/Reranker 는 `@family/ai-providers` 의 provider 경계 뒤에 둔다(ADR-0004 계승).
  `createProviders({provider})` 가 `mock` 기본 → 결정적 Mock, `openai`/`anthropic` → 스켈레톤(키 없으면
  Mock 폴백 + warning)을 반환한다. Phase 7 검증은 **Mock** 으로 수행한다.
- **Mock embedding 은 결정적 256차원**이다: 텍스트를 토큰(공백/문장부호)으로 분할 → 각 토큰 해시를 256
  버킷에 누적 → L2 정규화. 같은 텍스트 → 항상 같은 벡터(랜덤/시간 없음). 차원 상수 `EMBEDDING_DIM=256`
  으로 고정한다. **실제 provider 차원이 256과 다르면 재임베딩이 필요**하다(운영 문서화).
- **멱등 인덱싱**: `chunks` UNIQUE(`workspaceId, sourceType, sourceRefId`) + `onConflictDoUpdate`,
  `embeddings` UNIQUE(`chunkId`) + `onConflictDoUpdate`. 재import·재인덱싱해도 청크/임베딩이 중복 없이
  덮어써져, 검색 결과 수가 안정이다. Slack import 성공 후 `rag-index` 큐(고정 `jobId=rag-index:<workspaceId>`)
  로 인덱싱을 위임한다.

## 검토한 대안

1. **메시지 단위 청킹**: 청크가 많아지고 문맥이 끊겨 인용/의미 검색 품질이 낮다. 스레드 단위로 맥락을
   보존했다(단독 메시지만 예외적으로 1청크).
2. **문단/토큰 슬라이딩 윈도 청킹**: Slack 은 이미 스레드라는 자연 경계가 있어 임의 윈도가 불필요하고
   경계가 대화 흐름을 자른다. 초장문 스레드가 흔해지면 스레드 내부 재청킹을 도입할 여지만 남긴다.
3. **FTS 단독(키워드만)**: 동의어/의역 검색이 안 된다. 반대로 **Vector 단독**은 Mock 에선 의미가 없고
   실제로도 정확 일치/희귀어에 약하다. 두 신호를 병행했다.
4. **가중합(weighted score) 병합**: FTS similarity 와 코사인 거리는 스케일이 달라 정규화·가중치 튜닝이
   취약하다. 순위만 쓰는 **RRF** 가 스케일 무관하고 파라미터가 `k` 하나뿐이라 견고하다.
5. **근거 충분성을 LLM 이 판단**: LLM 에게 "근거가 충분한가"를 물으면 비결정적이고 환각 위험이 크며
   비용이 든다. **앱 로직(FTS 매칭 존재 여부)** 으로 판정하고 근거 없으면 LLM 을 아예 호출하지 않는다.
6. **Rerank 생략**: 병합 순위를 그대로 top-K 로 써도 되지만, 실제 cross-encoder reranker 로 교체할 경계를
   지금 확보해 두는 편이 낫다. Mock 은 순서 유지라 결정성을 해치지 않는다.
7. **임베딩 차원을 provider 실차원(예 1536/3072)에 맞춤**: Mock 파이프라인이 provider 차원에 종속되고
   검증이 비싸진다. **256 고정 Mock** 으로 파이프라인을 완성하고, 실 provider 교체 시 재임베딩을 문서화했다.
8. **인덱싱을 import 트랜잭션에 인라인**: import 지연·결합도가 커진다. **rag-index 큐**로 분리하고
   고정 jobId 로 과다 enqueue 를 막았다.

## 장점

- 스레드 청킹으로 맥락이 보존돼 검색·인용 품질과 사람 가독성이 높다.
- FTS+Vector 하이브리드 + RRF 로 키워드/의미 신호를 스케일 무관하게 결합해, Mock 에선 결정적이고 실
  provider 로 교체 시 자연히 강화된다.
- 근거 판정이 앱 로직이라 **근거 없는 질문에 환각 없이 거부**하고, LLM 호출/비용도 아낀다.
- provider 경계 + 256 고정 Mock 으로 파이프라인이 모델 비종속이고 e2e(`verify-phase7.mjs`)가 결정적이다.
- 멱등 인덱싱(UNIQUE + onConflictDoUpdate)으로 재import/재인덱싱이 안전하다.
- 소유권을 SQL WHERE + LLM 전달 직전 이중 강제해 workspace 간 데이터 유출을 막는다(PRD §26).

## 단점

- Mock 임베딩은 의미가 없어 Vector 신호가 실질 기여를 하지 못한다 — Phase 7 검증은 사실상 FTS 가
  근거를 지배한다(설계상 의도이나, 의미 검색 품질은 실 provider 로만 확인 가능).
- 실제 provider 는 차원이 256과 달라 **전면 재임베딩**이 필요하다(운영 마이그레이션 비용).
- 스레드 단위 청킹은 초장문 스레드에서 청크가 비대해져 임베딩/검색 정밀도가 떨어질 수 있다.
- pg_trgm similarity 임계(0.1)는 언어·질의 길이에 민감해, 실 데이터에서 threshold 재튜닝이 필요할 수 있다.
- 인덱싱이 비동기라 import 직후 짧은 시간 동안은 검색 결과가 비어 있을 수 있다(폴링으로 흡수).

## 변경조건

- 실제 OpenAI/Anthropic 임베딩을 켜면 `EMBEDDING_DIM` 을 provider 차원으로 바꾸고 전 청크를
  재임베딩하며, 근거 판정에 벡터 유사도 임계(config)를 함께 사용한다.
- 초장문 스레드가 흔해지면 스레드 내부 재청킹(문단/토큰 윈도)을 도입하되, 청크 멱등키(UNIQUE)는 유지한다.
- 검색 품질 요구가 커지면 실 cross-encoder reranker 로 교체하고, RRF `k`·FTS threshold·topK 를 config 로
  노출해 튜닝한다.
- 장기기억(memory)·GraphRAG·MCP(Phase 8~10)가 붙으면 `chunks`/`embeddings` 를 그 소스(Task/Decision/
  Incident, 이벤트)로 확장하되 provider 경계·소유자 전용 접근은 그대로 둔다.
