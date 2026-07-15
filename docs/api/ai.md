# AI 검색 / 질의응답 API 명세 (Hybrid RAG)

> Phase 7 기준. 계약 스키마의 단일 소스는 `@family/contracts`(zod, `src/ai.ts`)이며, 본 문서는
> 예시다. 모든 엔드포인트는 전역 prefix `v1` 을 사용한다. 시각은 ISO 8601 문자열(`toISOString`),
> 기간 경계·표시는 `Asia/Seoul`, Slack `ts` 는 `"epoch.micro"` 문자열이다.
>
> 관련 설계: [ADR-0012 Hybrid RAG](../adr/0012-hybrid-rag-retrieval.md) ·
> [ADR-0011 Slack Import JSON 번들](../adr/0011-slack-import-json-bundle.md) ·
> [ADR-0004 모델 비종속 AI provider](../adr/0004-model-agnostic-ai-providers.md) ·
> [ADR-0002 PostgreSQL + pgvector](../adr/0002-use-postgresql-pgvector.md) ·
> [Phase 7 빌드 스펙](../phase7-build-spec.md)

## 개요

Phase 7 은 Phase 6 이 수집한 Slack 스레드/메시지를 **스레드 단위로 청킹 → 임베딩(256차원) → FTS(trgm)
+ Vector 하이브리드 검색 → RRF 병합 → rerank** 한 뒤, **출처(citations)를 포함한 답변**을 제공하고,
근거가 없으면 **거부(refused)** 한다.

| 동작 | 방식 | 경로 |
|---|---|---|
| 검색(디버그/검증) | JWT | `POST /v1/ai/retrieval` |
| 출처 포함 질의응답 | JWT | `POST /v1/ai/work-query` |

- **스코프(`workspaceId`)**: RAG/AI 는 개인 데이터 컨테이너 **`workspaces.id`** 를 스코프로 쓴다
  (Slack import 응답의 `slackWorkspaceId`(= `slack_workspaces.id`)가 **아니다**). `workspaceId` 는
  `GET /v1/slack/workspaces/:id` 응답의 `workspaceId` 필드에서 얻는다.
- **접근제어(PRD §26)**: `workspaces.ownerUserId == 요청자`인 **소유자 본인만** 조회할 수 있다. 검색은
  SQL WHERE 로 workspace 를 제한하고, LLM 전달 직전에도 소유를 재검증한다 — 비소유자는 `403 Forbidden`.
- **근거 판정은 앱 로직**(PRD §3.3): 상위 결과 중 FTS 매칭(`similarity > 0.1`)이 하나도 없으면
  `hasEvidence=false` → work-query 는 `refused=true` 로 **LLM 을 호출하지 않는다**(환각 차단). LLM 은
  전달된 컨텍스트를 설명만 한다.
- **비동기 인덱싱**: Slack import 성공 후 `rag-index` 큐가 청킹/임베딩을 수행한다. import 직후 짧은 시간
  동안은 검색 결과가 비어 있을 수 있으므로, 검증은 retrieval 이 결과를 줄 때까지 폴링(권장 상한 15초)한다.
- **모델 비종속(PRD §3.4)**: 임베딩/LLM/Reranker 는 provider 경계 뒤에 있다. Phase 7 검증은 **결정적
  Mock**(256차원 임베딩, 순서 유지 reranker, 컨텍스트 설명 LLM)으로 수행한다. 실제 OpenAI/Anthropic 는
  provider 교체로 켜되, **차원이 256과 다르면 재임베딩이 필요**하다.
- **로그 비노출(PRD §11)**: 청크 원문/snippet/PII/secret/임베딩 값을 운영 로그에 남기지 않는다
  (개수/식별자만).

---

## 1. 검색 — `Controller('ai')` → `POST /v1/ai/retrieval`

하이브리드 검색 결과를 그대로 돌려주는 디버그/검증용 엔드포인트다. 사용자 인증(Bearer) 필요.
`workspaceId` 를 소유하지 않으면 `403`.

### 요청 (`retrievalRequestSchema`)

| 필드 | 필수 | 규칙 |
|---|---|---|
| `workspaceId` | ✅ | 개인 컨테이너 `workspaces.id`(uuid). 요청자가 소유해야 함. |
| `query` | ✅ | 검색 질의 문자열(`min(1)`). |
| `topK` | 선택 | 반환 상위 개수. `int.min(1).max(20)`, 기본 `5`. |

```bash
curl -s -X POST http://localhost:3001/v1/ai/retrieval \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{ "workspaceId": "0a1b2c3d-…", "query": "Route53 인증서 ACM 재발급", "topK": 5 }'
```

### 응답 `200 OK` (`retrievalResponseSchema`)

```json
{
  "hasEvidence": true,
  "items": [
    {
      "chunkId": "c1a2b3c4-…",
      "snippet": "수빈: Route53 인증서 갱신 실패 문제가 발생했습니다\nAlex Kim: ACM 에서 인증서를 재발급하면 …",
      "score": 0.0325,
      "hasFtsMatch": true,
      "citation": {
        "chunkId": "c1a2b3c4-…",
        "sourceType": "slack_thread",
        "channelName": "eng-infra",
        "sourceRefId": "1721300000.000100",
        "occurredAt": "2024-07-18T10:53:20.000Z",
        "snippet": "수빈: Route53 인증서 갱신 실패 문제가 발생했습니다 …",
        "score": 0.0325
      }
    },
    {
      "chunkId": "d5e6f7a8-…",
      "snippet": "수빈: PostgreSQL 파티셔닝 도입 결정 논의를 시작합니다 …",
      "score": 0.0161,
      "hasFtsMatch": false,
      "citation": { "…": "…" }
    }
  ]
}
```

| 필드 | 의미 |
|---|---|
| `hasEvidence` | 상위 결과 중 **FTS 매칭(`similarity > 0.1`)이 하나라도 있으면** `true`. 근거 판정 기준. |
| `items[]` | RRF 병합 + rerank 상위 `topK`. **`score` 내림차순** 정렬. |
| `items[].chunkId` | 청크 식별자(`chunks.id`). |
| `items[].snippet` | 청크 본문 발췌(원문 로그 금지 대상 — 표시용). |
| `items[].score` | RRF 병합 점수(`Σ 1/(60 + rank)`). 스케일 무관 상대 순위 신호. |
| `items[].hasFtsMatch` | 이 청크가 FTS 매칭(`similarity > 0.1`)이었는지. 근거 판정에 사용. |
| `items[].citation` | 출처 메타(아래 §3 `citationSchema`). |

> 검색은 **키워드(pg_trgm FTS) + 의미(pgvector 코사인 `<=>`)** 를 각각 순위화한 뒤 **RRF(k=60)** 로
> 병합하고 Reranker(Mock=순서 유지)로 top-K 를 고른다. Mock 임베딩은 결정적 256차원이라 결과가 재현
> 가능하다. Vector 는 모든 청크를 순위화하므로 FTS 에 안 걸린 청크도 `hasFtsMatch:false` 로 결과에
> 나타날 수 있으나, 근거 판정(`hasEvidence`)은 FTS 매칭 여부만 본다.

---

## 2. 질의응답 — `POST /v1/ai/work-query`

검색 → 근거 판정 → (근거 있으면) LLM 컨텍스트 설명 → **출처 포함 답변**을 돌려준다. 사용자 인증
(Bearer) 필요. `workspaceId` 소유자만(비소유자 `403`).

### 요청 (`workQueryRequestSchema`)

| 필드 | 필수 | 규칙 |
|---|---|---|
| `workspaceId` | ✅ | 개인 컨테이너 `workspaces.id`(uuid). 요청자가 소유해야 함. |
| `question` | ✅ | 질문 문자열(`min(1).max(1000)`). |

```bash
curl -s -X POST http://localhost:3001/v1/ai/work-query \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{ "workspaceId": "0a1b2c3d-…", "question": "Route53 인증서 문제 어떻게 해결했어?" }'
```

### 응답 `200 OK` — 근거 있음 (`workQueryResponseSchema`)

```json
{
  "refused": false,
  "answer": "기록에 따르면, Route53 인증서 갱신 실패 문제가 발생했고 ACM 에서 인증서를 재발급해 해결했습니다.",
  "reason": null,
  "citations": [
    {
      "chunkId": "c1a2b3c4-…",
      "sourceType": "slack_thread",
      "channelName": "eng-infra",
      "sourceRefId": "1721300000.000100",
      "occurredAt": "2024-07-18T10:53:20.000Z",
      "snippet": "수빈: Route53 인증서 갱신 실패 문제가 발생했습니다\nAlex Kim: ACM 에서 인증서를 재발급하면 …",
      "score": 0.0325
    }
  ],
  "meta": { "retrievedCount": 4, "model": "mock" }
}
```

### 응답 `200 OK` — 근거 없음(거부)

근거 없는 질문은 **LLM 을 호출하지 않고** 거부한다.

```json
{
  "refused": true,
  "answer": null,
  "reason": "근거를 찾지 못했습니다",
  "citations": [],
  "meta": { "retrievedCount": 0, "model": "mock" }
}
```

| 필드 | 의미 |
|---|---|
| `refused` | 근거 충분성 판정 결과. `hasEvidence=false`(FTS 매칭 없음)면 `true`. |
| `answer` | 답변 본문(문자열). `refused=true` 면 `null`(LLM 미호출). |
| `reason` | 거부 사유(문자열). `refused=false` 면 `null`. |
| `citations[]` | 출처 배열. **답변마다 100% 포함**. `refused=true` 면 **빈 배열**. |
| `meta.retrievedCount` | 검색으로 회수된 청크 수(정수). |
| `meta.model` | 답변을 생성한(또는 사용된) 모델 식별자(예: `mock`). |

> **LLM 은 컨텍스트 설명만** 한다(PRD §3.3). 근거 충분성·순위 병합은 애플리케이션 로직이 결정하고,
> 근거가 없으면 환각 대신 `refused`. Mock LLM 은 전달된 발췌를 인용하는 결정적 답변을 만든다
> (랜덤/시간 사용 없음).

---

## 3. 출처(citation) — `citationSchema`

각 결과 청크를 원본 스레드/메시지로 역추적한 출처 메타다. 답변(`work-query`)과 검색(`retrieval`) 모두
동일 스키마를 쓴다.

```json
{
  "chunkId": "c1a2b3c4-…",
  "sourceType": "slack_thread",
  "channelName": "eng-infra",
  "sourceRefId": "1721300000.000100",
  "occurredAt": "2024-07-18T10:53:20.000Z",
  "snippet": "수빈: Route53 인증서 갱신 실패 문제가 발생했습니다 …",
  "score": 0.0325
}
```

| 필드 | 의미 |
|---|---|
| `chunkId` | 청크 식별자(`chunks.id`). |
| `sourceType` | `slack_thread`(스레드 청크) 또는 `slack_message`(단독 메시지 청크). |
| `channelName` | 출처 채널명(nullable, Slack 청크는 채널명). |
| `sourceRefId` | 역추적 키 — 스레드면 `threadTs`, 단독 메시지면 message `ts`. 스레드 인용은 이 값으로 원본 스레드를 특정한다. |
| `occurredAt` | 스레드 root(또는 메시지)의 시각(ISO). `new Date(Number(ts.split('.')[0]) * 1000)` 파생. |
| `snippet` | 청크 본문 발췌(표시용, 원문 로그 금지). |
| `score` | 병합/재순위 점수. |

---

## 4. 접근제어 · 근거판정 · 멱등 요약

- **소유자 전용(PRD §26)**: `retrieval`/`work-query` 는 `workspaces.ownerUserId == 요청자` 를 서비스
  계층에서 강제한다. 검색 SQL 은 `workspaceId` 로 제한하고, LLM 전달 직전 소유를 재검증한다. 비소유자는
  `403 Forbidden` — 다른 workspace 데이터 유출 0.
- **근거판정(앱 로직)**: 상위 결과 중 FTS 매칭(`similarity > 0.1`)이 없으면 `hasEvidence=false` →
  `work-query` 는 `refused=true` 로 LLM 을 호출하지 않는다.
- **멱등 인덱싱(ADR-0012 §6)**: `chunks` UNIQUE(`workspaceId, sourceType, sourceRefId`) +
  `onConflictDoUpdate`, `embeddings` UNIQUE(`chunkId`) + `onConflictDoUpdate`. 재import/재인덱싱해도
  청크/임베딩이 중복 없이 덮어써져 검색 결과 수가 안정이다.

---

## 5. 오류

| 상황 | 응답 |
|---|---|
| 인증 없음/만료 | `401` |
| `workspaceId` 비소유(다른 사용자의 workspace) | `403` |
| body 스키마 위반(`workspaceId` 누락/비-uuid, `question`/`query` 빈 문자열, `topK` 범위 초과) | `400` |

> 근거 없는 질문은 오류가 아니라 **정상 응답(`200`) + `refused:true`** 다. 클라이언트는 `refused` 를
> 보고 "근거 없음"을 사용자에게 안내한다.

---

## 6. 검증 (완료 조건 e2e)

Phase 7 완료 조건은 `scripts/verify-phase7.mjs` 가 실 스택(`http://localhost:3001`)을 대상으로 자동
검증한다(스펙 §9 시나리오 1~8). Node 내장 `fetch` + `FormData` + `Blob` 만 사용하고, 인증·Slack import 는
`verify-phase6.mjs` 패턴(회원가입 → multipart 업로드)을 재사용한다. RAG 인덱싱이 비동기이므로 retrieval 이
결과를 줄 때까지 최대 15초 폴링한다.

```bash
# 전체 스택 기동(진행자 수행): docker compose up -d --build (+ migrate 0007 chunks/embeddings + HNSW/GIN)
node scripts/verify-phase7.mjs
# 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase7.mjs
```

검증 시나리오: 기술 스레드(Route53 인증서/ACM 재발급, PostgreSQL 파티셔닝) + 잡담 번들 업로드 →
RAG 인덱싱 폴링 → work-query 관련 질문에 `refused=false`·정답 스레드가 citations Top5(sourceRefId/
channelName)·answer non-empty → retrieval 직접 호출에 `hasEvidence=true`·top `hasFtsMatch=true`·RRF
`score` 내림차순 → 출처 100%(channelName/sourceRefId/occurredAt/snippet) → 근거 없는 질문
("다음 분기 환율 전망은?")에 `refused=true`·citations 빈 배열·answer `null` → 비소유자 userB 의
work-query/retrieval `403` → 재import 후 retrieval 결과 수 안정(멱등, 청크 중복 없음). 전부 통과 시 종료
코드 `0`, 하나라도 실패하면 첫 실패 지점에서 명확한 메시지와 함께 `1` 로 종료한다. 로그에는 청크 원문·
snippet·secret·임베딩 값을 출력하지 않는다(개수/식별자만).
