# ADR-0014: Temporal GraphRAG — PostgreSQL Entity/Relationship 로 시작 · 결정적 규칙 추출 · validFrom/validUntil + 명시적 supersede · 소유자 전용

## 제목

Slack 업무 기록(Phase 6/7 의 `chunks`)에서 **결정적 규칙 함수**로 Entity(person/technology)와
Relationship(relates_to/resolves)를 추출하고, **전용 그래프DB(Neo4j) 없이 PostgreSQL 두 테이블
(`entities`/`relationships`)** 로 지식 그래프를 표현하며, 시간성을 **`validFrom`/`validUntil` +
명시적 supersede** 로 다루고, 이웃 조회(1-hop) + 앱 확장으로 **Local Graph / Timeline** 을 제공하며,
접근은 **workspace 소유자 본인만** 허용하는 Temporal GraphRAG 설계 채택(PRD §37/§22/§20/§26, Phase 9).

## 상태

승인됨 (Accepted) — 2026-07-16

## 배경

Phase 9 는 개인화 AI 의 **관계·시간 계층**이다(PRD §31 Phase 9). Phase 8 의 장기 기억(개별 사실)만으로는
"프로젝트 결정이 어떻게 바뀌었나", "이 장애는 무엇으로 해결됐나", "지금 구조 vs 과거 구조"에 답하기
어렵다. Phase 6/7 이 적재한 Slack `chunks`(+ `slack_users`)를 대상으로 다음 완료 조건을 만족해야 한다
(PRD §31 Phase 9).

- **결정 변화 설명**: supersede 된 관계 체인으로 "무엇이 무엇을 대체했는가"를 조회.
- **장애–해결책 관계 검색**: `resolves` 관계로 장애 기술 ↔ 해결 기술을 잇는다.
- **현재 vs 과거 구조 구분**: `current` / `asOf` 필터로 지금 유효한 관계와 과거 스냅샷을 구분.
- **접근제어(PRD §26)**: 그래프는 개인 데이터다. `workspaces.ownerUserId == 요청자`인 소유자 본인만
  읽고 쓸 수 있으며 비소유자 유출 0.

설계 포인트는 다섯 가지다. (1) 그래프를 **어디에 저장**하는가(전용 그래프DB vs 관계형), (2) 추출을
**무엇이 수행**하는가(LLM vs 규칙), (3) **시간성**을 어떻게 표현하는가, (4) **traversal**(이웃/타임라인)을
어떻게 구현하는가, (5) 접근을 어디서 강제하는가.

## 결정

### 1. 저장 = PostgreSQL `entities`/`relationships` 2테이블(전용 그래프DB 미도입)

- 지식 그래프를 별도 그래프DB(Neo4j 등)나 GraphRAG 프레임워크 없이 **PostgreSQL 두 테이블**로 시작한다
  (PRD §22).
  - `entities(id, workspaceId, type, name, canonicalName, validFrom, validUntil, metadata, …)` —
    `UNIQUE(workspaceId, type, canonicalName)`, `INDEX(workspaceId)` / `INDEX(workspaceId, type)`.
  - `relationships(id, workspaceId, sourceEntityId, targetEntityId, type, validFrom, validUntil,`
    `supersedesRelationshipId(self-FK), sourceRefId, confidence, …)` —
    `UNIQUE(workspaceId, sourceEntityId, type, targetEntityId, sourceRefId)`,
    `INDEX(workspaceId)` / `INDEX(sourceEntityId)` / `INDEX(targetEntityId)` / `INDEX(workspaceId, type)`.
  - `enum entityType` = `person·technology·project·decision·incident·topic`,
    `enum relationshipType` = `relates_to·resolves·works_on·uses·decides·supersedes`.
- 근거(PRD §22/ADR-0002 계승): 데이터 규모가 개인/가족 워크스페이스 수준이고 질의 패턴이 대부분
  **1-hop 이웃 + 시간 필터**다. 이미 운영 중인 PostgreSQL(pgvector 포함) 위에 두 테이블을 얹으면 별도
  인프라·운영·백업·트랜잭션 경계를 추가하지 않고도 요구를 만족한다. 전용 그래프DB 의 다중 hop
  path/graph algorithm 은 현재 완료 조건에 필요 없다(도입 시 비용·복잡도만 증가).
- `supersedesRelationshipId` 는 `relationships` 를 가리키는 **self-FK** 이며, drizzle 의 lazy 콜백
  (`AnyPgColumn`)으로 자기 참조를 표현한다.

### 2. 추출 = 결정적 규칙 함수(`@family/rag` `graph.ts`), LLM 교체 자리 유지

- 추출기는 순수 함수 `extractGraph(chunks, persons): { entities, relationships }` 다
  (`packages/rag/src/graph.ts`). 랜덤/시간/I·O·LLM 을 쓰지 않아 같은 입력이면 항상 같은 그래프를 낸다.
- **entity**:
  - `person` — `slack_users` 전원(canonicalName = slackUserId, name = realName ?? name).
  - `technology` — 기술 사전 `TECH_TERMS`(route53, acm, postgresql, redis, s3, docker, kubernetes,
    nginx, graphql, bullmq, pgvector … 대소문자 무시, 한국어 표기 포함)가 chunk 텍스트에 등장하면 등록
    (canonicalName = 정규화 소문자 term).
  - `validFrom` = 최초 등장 chunk `occurredAt`, `validUntil` = null(현재 유효).
- **relationship(chunk 단위, `validFrom` = chunk.occurredAt)**: 같은 chunk 안 technology 쌍 (A,B) 를
  canonical 오름차순으로 정렬해 `relates_to`(confidence 70)로 잇고, chunk 에 해결 마커
  `RESOLUTION_MARKERS`(해결/복구/조치/재발급/해소/resolved/fixed)가 있으면 `resolves`(confidence 90)로
  올린다. `sourceRefId` = chunk 의 원본 Slack `threadTs`/`ts`(원문 역추적).
- **works_on(person↔technology)의 축소(스펙 §5)**: works_on 은 chunk 의 대표 작성자(author)를 tech 와
  잇는 관계인데, 현재 chunk 스키마에 author 가 없어 (author, tech) 조인이 어렵다. 따라서 Phase 9 는
  **person entity 는 등록만 하고 tech–tech(relates_to/resolves) 관계만 자동 추출**한다. works_on 로직은
  순수 함수(`extractGraph`)에 테스트와 함께 남겨두되 worker 는 `authorCanonicalName=null` 로 호출해
  생성하지 않는다(chunk 에 author 가 붙는 확장 지점).
- 근거: PRD 상 실제 추출은 LLM 이지만, Mock 환경에서 **모델 비종속·결정적 검증**(`verify-phase9.mjs`)을
  가능케 하려면 순수 함수 경계가 필요하다. 실제 `LlmProvider` 추출로 교체해도 이 시그니처/그래프 스키마와
  이후 저장·조회 파이프라인은 그대로다(ADR-0004/ADR-0013 계승).
- 추출 실행은 **비동기 큐** `graph-extract`(worker)에 위임한다. api 는 소유 검증 후 enqueue 만 하고
  `202 Accepted` 로 응답한다. 커스텀 jobId 는 `graph-extract_<workspaceId>`(BullMQ 제약상 `:` 대신 `_`).

### 3. 시간성 = `validFrom`/`validUntil` + 명시적 supersede(자동 추론 없음)

- 관계는 `validFrom`(유효 시작 = chunk.occurredAt), `validUntil`(null = 현재 유효),
  `supersedesRelationshipId`(대체 체인)를 갖는다.
- **명시적 supersede**: 새 관계 B 가 기존 A 를 대체하면 한 트랜잭션에서 A 를 닫고(`validUntil=now`),
  B 를 만들어 `supersedesRelationshipId=A.id`, `validFrom=now`, `validUntil=null` 로 둔다. 이 대체는
  **사용자/호출자의 명시적 API 호출**(`POST /relationships/:id/supersede`)로만 일어난다 — 추출기는
  "결정이 바뀌었다"를 **자동 추론하지 않는다**(오탐이 그래프를 오염시키지 않게).
- 조회는 **애플리케이션 로직**이다(SQL WHERE, PRD §3.3):
  - `current=true` → `validUntil IS NULL OR validUntil > now`.
  - `asOf=DATE` → `validFrom <= asOf AND (validUntil IS NULL OR validUntil > asOf)` — 과거 시점의
    스냅샷(당시 유효했던 관계, 이미 대체된 것 포함).
- `isCurrent`(validUntil null|미래)는 응답에 파생 포함한다.
- 근거: 프로젝트 결정·구조는 시간에 따라 바뀐다. 과거를 지우지 않고 닫아두면 "언제 무엇이 사실이었나"를
  재현할 수 있고(결정 변화 = supersede 체인), 현재 조회는 최신만 본다.

### 4. Traversal = 이웃 조회(1-hop) + 앱 확장 (Local Graph / Timeline)

- **Local Graph**(`GET /entities/:id`): entity 가 source 또는 target 으로 참여하는 relationships 를
  모아 상대 entity 를 조인한 `neighbors[{ relationship, entity }]` 로 돌려준다(current/asOf 옵션). 다중
  hop 확장이 필요하면 앱에서 반복 호출로 넓힌다.
- **Timeline**(`GET /timeline`): entity 관련 relationships 를 `validFrom` 오름차순으로 돌려준다(관계
  형성/변경 이력 = supersede 전후가 시간순으로 나열).
- 근거: 완료 조건이 요구하는 것은 이웃·시간 이력이지 그래프 알고리즘(shortest path, community 등)이
  아니다. SQL 인덱스(`sourceEntityId`/`targetEntityId`/`workspaceId,type`)로 1-hop 은 충분히 빠르다.

### 5. 접근제어 = workspace 소유자 본인만(엔티티 해석 후 소유 재검증)

- 모든 graph 연산은 대상 workspace 소유(`ownerUserId == 요청자`)를 확인한다 — 없는 workspace 는 `404`,
  소유자가 아니면 `403`. entity/relationship 을 **먼저 해석한 뒤** 그 workspace 소유를 재검증하므로
  비소유자는 남의 그래프를 읽거나 supersede 할 수 없다(PRD §26, ADR-0013 계승).
- 로그는 식별자/개수만 남기고 원문/`name`/PII/secret 은 남기지 않는다(PRD §11).

### 6. 멱등 = 두 UNIQUE + 서로 다른 onConflict 전략

- **entities**: `UNIQUE(workspaceId, type, canonicalName)` + `onConflictDoUpdate`(validFrom 은
  `least(기존, 신규)`). 재추출해도 같은 person/tech 는 한 행이며 최초 등장 시각이 유지된다.
- **relationships**: `UNIQUE(workspaceId, sourceEntityId, type, targetEntityId, sourceRefId)` +
  `onConflictDoNothing`. 재추출해도 같은 (chunk 출처) 관계가 중복 생성되지 않고, 이미 `validUntil` 로
  닫힌 관계를 되살리지 않는다. 추출은 항상 `sourceRefId` 를 채우고, 명시적 supersede 로 만든 새 관계는
  `sourceRefId=null`(Postgres 는 UNIQUE 의 null 을 distinct 취급 → 제약 무관, 추출이 건드리지 않음).

## 검토한 대안

1. **전용 그래프DB(Neo4j)/GraphRAG 프레임워크 도입**: 다중 hop path·graph algorithm 에는 강하지만,
   개인/가족 규모·1-hop 중심 질의에는 과투자다. 별도 인프라/운영/백업/트랜잭션 경계가 늘고 pgvector·
   RAG 스택과 이원화된다. **PostgreSQL 2테이블 + 앱 traversal** 로 시작하고 도입은 변경조건으로 미뤘다
   (PRD §22).
2. **LLM 추출을 Phase 9 에서 바로 사용**: 비결정적이라 e2e 검증이 어렵고 비용/모델 종속이 생긴다.
   **결정적 규칙(기술 사전 + 공출현 + 해결 마커)** 으로 파이프라인을 완성하고 순수 함수 경계로 LLM 교체
   자리를 남겼다(PRD §3.4).
3. **결정 변화(supersede)를 자동 추론**: "이 관계가 저 관계를 대체한다"를 규칙/LLM 이 추측하면 오탐이
   그래프를 왜곡한다. **명시적 supersede API** 로만 체인을 만든다(사람/상위 로직의 통제).
4. **과거 관계를 삭제/덮어쓰기**: 시점 재현이 불가능해진다. `validUntil` + supersede 로 **닫되 보존**하고
   `asOf` 조회를 제공했다.
5. **관계형 대신 그래프를 인접 리스트 JSON 으로**: 조인/필터/멱등/무결성(FK)이 약하다. 정규화된 두
   테이블 + FK + UNIQUE 로 표현했다.
6. **relationship 멱등을 `onConflictDoUpdate`**: 재추출이 닫힌(validUntil) 관계를 되살리거나 confidence
   를 되돌린다. **`onConflictDoNothing`** 으로 기존 상태(대체 이력 포함)를 보존했다.
7. **works_on(person↔tech)까지 자동 추출**: 현재 chunk 스키마에 author 가 없어 조인이 부정확하다. 순수
   함수에 로직만 남기고 worker 는 생성하지 않았다(스키마 확장 시 활성화, 스펙 §5).

## 장점

- 전용 그래프DB 없이 **기존 PostgreSQL** 로 지식 그래프를 시작해 인프라/운영 비용이 0 에 수렴한다(PRD §22).
- 규칙 추출이 결정적이라 `verify-phase9.mjs` e2e 가 모델 비종속으로 통과하고, LLM 추출로의 교체 경계가
  분명하다(순수 함수 → provider).
- `validFrom/validUntil` + 명시적 supersede 로 현재/과거를 보존·구분하고 `asOf` 시점 재현·결정 변화
  체인이 가능하다(자동 추론 오탐 없음).
- 1-hop 이웃/타임라인이 인덱스로 빠르고, 다중 hop 은 앱 확장으로 점진 대응한다.
- 두 UNIQUE + 서로 다른 onConflict(entities DoUpdate / relationships DoNothing)로 재추출이 안전하다
  (중복 0, 대체 이력 보존).
- 소유권을 엔티티 해석 후 재검증해 workspace 간 그래프 유출을 막는다(PRD §26).

## 단점

- 규칙 추출은 기술 사전 + 공출현 기반이라 사전에 없는 용어/문맥 관계를 놓쳐 재현율(recall)이 낮고,
  같은 chunk 공출현을 곧 "관계"로 보는 단순화가 오탐을 만들 수 있다 — 품질은 실제 `LlmProvider` 추출로만
  끌어올린다(설계상 의도된 경계).
- PostgreSQL 로는 **다중 hop path/graph algorithm** 이 비싸다(재귀 CTE 필요). 현재 완료 조건엔 불필요하나
  요구가 커지면 병목이 될 수 있다.
- `works_on`·`uses`·`decides` 등 관계 종류와 `project`/`decision`/`incident`/`topic` entity 타입은 enum
  에만 존재하고 Phase 9 자동 추출은 relates_to/resolves(tech–tech)와 person 등록으로 축소된다.
- `entity_aliases`/`claims`(PRD §24)는 미구현이라 동의어·상충 주장 표현이 제한된다(확장 지점).

## 변경조건

- **전용 그래프DB(Neo4j 등) 도입 검토 조건**: (a) 다중 hop path·community·centrality 등 graph algorithm
  이 제품 요구가 되거나, (b) entity/relationship 규모가 PostgreSQL 1-hop 인덱스로 감당 안 되는 지연을
  보이거나, (c) 재귀 CTE 기반 확장이 유지보수/성능 한계에 이를 때. 그때도 추출(순수 함수)·소유권·시간성
  규칙은 유지하고 저장/traversal 계층만 교체한다.
- 실제 LLM 추출을 켜면 `extractGraph` 를 `LlmProvider` 기반으로 교체하되 그래프 스키마·시간성·멱등·소유권
  규칙은 그대로 둔다(ADR-0004 계승).
- chunk 에 author 가 붙으면 `works_on`(person↔technology) 자동 추출을 활성화한다(순수 함수 로직은 이미
  존재, 스펙 §5).
- `entity_aliases`/`claims`(PRD §24), `uses`/`decides` 관계, project/decision/incident/topic entity
  자동 추출을 붙일 때는 멱등 키(두 UNIQUE)와 소유자 전용 접근을 유지한다.
