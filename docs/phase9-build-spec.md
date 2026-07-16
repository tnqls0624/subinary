# Phase 9 Build Spec — Temporal GraphRAG (Entity/Relationship)

> Phase 0~8 규약 준수(패키지 `type:module` 금지, 공용 dev 이미지, 소스 바인드마운트, Asia/Seoul, 로그 Secret/PII 금지, 새 env는 `.env`도, 새 npm 의존성 시 lockfile 재생성, 교차모듈 `@UseGuards`는 가드 의존성까지 export, drizzle `GROUP BY` ordinal, **BullMQ 커스텀 jobId 에 ':' 금지 → '_'**, SWC watch 재시작 포트 경합 시 clean restart).

---

## 0. 목표 & 완료 조건 (PRD §31 Phase 9)

범위: Entity / Relationship / valid_from / valid_until / supersedes / Timeline Search / Local Graph Search.

완료 조건(실측, `scripts/verify-phase9.mjs`):
1. 프로젝트 결정 변화 설명(supersede된 관계 체인 조회).
2. 장애와 해결책 관계 검색(resolves 관계).
3. 현재 구조와 과거 구조 구분(current / asOf 필터).
4. 권한: workspace 소유자만.

### 경계 & 전제 (PRD §22)
- **PostgreSQL Entity/Relationship 테이블로 시작**(Neo4j/GraphRAG 프레임워크 미도입). Graph traversal은 이웃 조회(1-hop) + 앱 확장.
- 추출은 **결정적 규칙**(기술 사전 + 공출현 + slack_users→person). 실제로는 LLM 추출로 교체 가능(순수 함수 경계 유지).
- 대상 = Phase 6/7 Slack chunks + Phase 6 slack_users. `entity_aliases`/`claims`(PRD §24)는 확장 지점(생략). supersede는 **명시적 API**(자동 결정변경 추론 안 함).

---

## 1. 핵심 설계

### 1.1 Entity
- **person**: 각 slack_user → entity(canonicalName = slackUserId, name = realName ?? name).
- **technology**: 기술 사전(TECH_TERMS 상수)에서 chunk 텍스트에 등장하는 용어 → entity(canonicalName = 정규화 소문자 term, name = 표시형).
- `validFrom` = 최초 등장 chunk occurredAt, `validUntil` = null(현재 유효). 멱등: UNIQUE(workspaceId, type, canonicalName).

### 1.2 Relationship (chunk 단위, valid_from = chunk.occurredAt)
- 같은 chunk 내 technology 쌍 (A,B) → `relates_to`. chunk에 해결 키워드(해결/복구/조치/재발급/resolved/fixed)가 있으면 `resolves`.
- 같은 chunk 내 person + technology → `works_on`.
- 멱등: UNIQUE(workspaceId, sourceEntityId, type, targetEntityId, sourceRefId)(sourceRefId = chunk sourceRefId). `confidence`.

### 1.3 Temporal / supersede (PRD §20/§22)
- relationship에 `validFrom`/`validUntil`/`supersedesRelationshipId`(self-FK).
- **명시적 supersede**: 새 관계가 기존을 대체 → 기존 validUntil=now + supersedesRelationshipId 연결, 새 관계 validFrom=now. (결정 변화 = supersede 체인.)
- 조회: `current=true` → validUntil null OR > now. `asOf=DATE` → validFrom<=asOf AND (validUntil null OR >asOf).

### 1.4 Local Graph / Timeline
- Local graph: entity의 이웃 relationships(source 또는 target로 참여, current/asOf 필터) + 상대 entity 요약.
- Timeline: entity 관련 relationships를 validFrom 오름차순(관계 형성/변경 이력).

### 1.5 권한: workspace 소유자만(ownerUserId==userId). 비소유자 403.

---

## 2. 데이터 모델 — `packages/database` (schema.ts 확장)

### pgEnum
- `entityType` = `['person','technology','project','decision','incident','topic']`
- `relationshipType` = `['relates_to','resolves','works_on','uses','decides','supersedes']`

### 테이블
```
entities
  id uuid pk
  workspaceId uuid not null -> workspaces.id
  type entityType not null
  name text not null
  canonicalName text not null            -- 정규화 키(person=slackUserId, tech=소문자term)
  validFrom timestamptz null
  validUntil timestamptz null
  metadata jsonb not null default '{}'
  createdAt / updatedAt
  UNIQUE(workspaceId, type, canonicalName)
  INDEX(workspaceId), INDEX(workspaceId, type)

relationships
  id uuid pk
  workspaceId uuid not null -> workspaces.id
  sourceEntityId uuid not null -> entities.id
  targetEntityId uuid not null -> entities.id
  type relationshipType not null
  validFrom timestamptz null
  validUntil timestamptz null
  supersedesRelationshipId uuid null -> relationships.id   (self-FK, AnyPgColumn)
  sourceRefId text null                  -- chunk sourceRefId(원문 연결)
  confidence integer not null default 60
  createdAt / updatedAt
  UNIQUE(workspaceId, sourceEntityId, type, targetEntityId, sourceRefId)
  INDEX(workspaceId), INDEX(sourceEntityId), INDEX(targetEntityId), INDEX(workspaceId, type)
```

추론 타입 export(Entity/NewEntity, Relationship/NewRelationship). 마이그레이션 0009. self-FK lazy 콜백. UNIQUE에 nullable sourceRefId 포함 시 Postgres는 null을 distinct 취급(같은 관계 sourceRefId null 여러 개 허용) — 추출은 항상 sourceRefId 채움, 명시적 supersede는 새 row(제약 무관).

---

## 3. `@family/rag` — 그래프 추출 (`src/graph.ts`)
- `const TECH_TERMS: { canonical:string; display:string; patterns:string[] }[]` — 예: route53(Route53, 'route53','route 53'), acm(ACM), postgresql(PostgreSQL,'postgres','postgresql'), redis, s3, minio, docker, kubernetes(k8s), nginx, graphql, rest, bullmq, pgvector … (한국어 텍스트에 흔한 표기 포함, 대소문자 무시).
- `const RESOLUTION_MARKERS = ['해결','복구','조치','재발급','해소','resolved','fixed']`
- `interface GraphPersonInput { canonicalName:string; name:string }`
- `interface GraphChunkInput { text:string; occurredAt:Date; sourceRefId:string; authorCanonicalName?:string|null }`
- `interface EntityDraft { type:'person'|'technology'; canonicalName:string; name:string; validFrom:Date }`
- `interface RelationshipDraft { sourceCanonical:string; sourceType; targetCanonical:string; targetType; type:'relates_to'|'resolves'|'works_on'; validFrom:Date; sourceRefId:string; confidence:number }`
- `function extractTechTerms(text): {canonical,display}[]` — 사전 매칭(중복 제거).
- `function extractGraph(chunks: GraphChunkInput[], persons: GraphPersonInput[]): { entities: EntityDraft[]; relationships: RelationshipDraft[] }`:
  - person entities: persons 전체(validFrom = 최초 등장 chunk occurredAt 또는 min).
  - tech entities: 각 chunk의 tech terms(validFrom = 최초 등장 occurredAt).
  - relationships per chunk: tech pair(A<B canonical 순 정렬로 중복 방지) → relates_to(해결 마커 있으면 resolves, confidence 90 else 70). author(person)+tech → works_on(confidence 80).
  - dedupe(같은 sourceCanonical/type/targetCanonical/sourceRefId 1개).
- `index.ts` 배럴 추가. vitest ≥8(사전 매칭, pair 관계, resolves 마커, works_on, dedupe, validFrom min, 빈 입력).

---

## 4. API 계약 — `packages/contracts` (`src/graph.ts` + 배럴)
- `entityTypeSchema`, `relationshipTypeSchema`.
- `graphExtractRequestSchema` = `{ workspaceId: uuid }`, `graphExtractResponseSchema` = `{ jobId, status: enum(['queued']) }`
- `entitySummarySchema` = `{ id, type, name, canonicalName, validFrom: nullable, validUntil: nullable, isCurrent: boolean, createdAt }`
- `relationshipSummarySchema` = `{ id, type, sourceEntityId, targetEntityId, sourceName, targetName, validFrom: nullable, validUntil: nullable, supersedesRelationshipId: nullable, isCurrent: boolean, sourceRefId: nullable, confidence: int }`
- `entityDetailSchema` = `{ entity: entitySummary, neighbors: { relationship: relationshipSummary, entity: entitySummary }[] }` (local graph)
- `relationshipSupersedeRequestSchema` = `{ sourceEntityId: uuid, targetEntityId: uuid, type: relationshipType, sourceRefId?: string }` (기존 대체 새 관계)
- `entityListResponseSchema`, `relationshipListResponseSchema`, `timelineResponseSchema` = `{ entityId, items: relationshipSummary[] }`
- 추론 타입.

---

## 5. apps/worker — 그래프 추출
- 큐 `QUEUE_NAMES.GRAPH_EXTRACT='graph-extract'`(shared는 P5 api 추가, worker import).
- `graph-extract.processor.ts`(`@Processor(GRAPH_EXTRACT)`): process({workspaceId}) → 소유 workspace의 chunks(text/occurredAt/sourceRefId) + slack_users(person, workspace의 slack_workspaces 통해) 로드 → chunk authorCanonicalName은 chunk 원본 메시지 작성자(간단화: chunk sourceRefId로 slack thread root author 또는 생략) → `extractGraph` → entities upsert(onConflictDoUpdate, validFrom = least(기존, 신규)) → relationships upsert(entity canonical→id 매핑, onConflictDoNothing). 배치. 로그 count만.
  - author 매핑 간단화: person→tech works_on은 chunk의 대표 작성자가 필요. chunk에 author 정보 없으면(현재 chunk 스키마엔 없음) works_on은 생략하고 tech-tech relates_to/resolves 중심으로. **결정: works_on은 slack_messages에서 (author, chunk의 tech) 조인이 필요하므로 Phase 9에선 relates_to/resolves(tech-tech) + person entity(관계 없이 등록)로 축소.** person-tech 관계는 확장 지점.
  - 즉 relationships = tech-tech(relates_to/resolves)만 자동 추출. person entity는 등록만.
- `processors.module`: GraphExtractProcessor + registerQueue(GRAPH_EXTRACT).

> extractGraph의 works_on 로직은 순수 함수에 두되(테스트), worker는 author 정보를 chunk에서 얻기 어려우므로 persons를 넘기되 authorCanonicalName은 null로 호출 → works_on 미생성. person entity는 persons 인자로 등록. (실제 author 연결은 chunk 스키마 확장 시.)

## 6. apps/api — graph 모듈 (`apps/api/src/graph/`)
### 6.1 배선
- `packages/shared/src/constants.ts`: `QUEUE_NAMES.GRAPH_EXTRACT='graph-extract'`.
- `app.module.ts`: GraphModule import.
### 6.2 graph.service (Db + @InjectQueue(GRAPH_EXTRACT), 소유 검증 헬퍼)
- `extract(userId,{workspaceId})`: 소유검증 → enqueue(jobId `graph-extract_${workspaceId}`). {jobId,status:'queued'}.
- `listEntities(userId,{workspaceId,type?,q?})`: 소유검증 → entities(q=name ILIKE) + isCurrent.
- `getEntity(userId,entityId)`: 소유검증(entity의 workspace) → entity + neighbors(relationships where source|target=entityId, current/asOf 옵션, 상대 entity 조인).
- `listRelationships(userId,{workspaceId,entityId?,type?,current?,asOf?})`: 소유검증 → relationships(source/target name 조인) + isCurrent.
- `supersedeRelationship(userId, relationshipId, input)`: 소유검증 → 트랜잭션: 기존 validUntil=now, 새 relationship(supersedesRelationshipId=old, validFrom=now, sourceEntityId/targetEntityId/type from input). 반환 새 관계.
- `timeline(userId,{workspaceId,entityId})`: 소유검증 → entity 관련 relationships validFrom asc.
- isCurrent = validUntil null OR > now.
### 6.3 컨트롤러 (`@Controller('graph')`, 일반 인증)
- POST `/extract`(202), GET `/entities`, GET `/entities/:id`, GET `/relationships`, POST `/relationships/:id/supersede`(201), GET `/timeline`. CurrentUser. DTO createZodDto. 비소유자 403.
### 6.4 graph.module: `imports: [BullModule.registerQueue({name:GRAPH_EXTRACT})]`.

---

## 7. Docker / 마이그레이션
- 새 npm 의존성 없음. schema 변경 → generate 0009. 통합: build → rag vitest → generate 0009 → up --force-recreate → verify-phase9.

## 8. 검증 — `scripts/verify-phase9.mjs`
1. userA + Slack import(스레드: "Route53 인증서 만료 장애를 ACM 재발급으로 해결"(→route53,acm resolves), "PostgreSQL 파티셔닝을 Redis 캐시와 함께 도입 결정"(→postgresql,redis relates_to), 사람 메시지).
2. RAG 인덱싱 완료 폴링(chunks).
3. POST /graph/extract → 추출 폴링(≤15s).
4. GET /entities → technology(route53/acm/postgresql/redis) + person entities 존재, isCurrent=true.
5. GET /entities/:id(route53) → neighbors에 acm(resolves).
6. GET /relationships?type=resolves → route53–acm resolves 관계(장애-해결).
7. supersede: 어떤 관계를 supersede → 기존 isCurrent=false(validUntil), 새 관계 isCurrent=true, supersedesRelationshipId 연결. GET current=true는 새 것만, asOf 과거는 기존.
8. timeline(entityId) → validFrom 오름차순.
9. 권한 userB 403.
10. 멱등: 재추출 후 entities/relationships 수 안정.
통과/실패 카운트, 실패 시 exit 1. (샘플 문장은 packages/rag/src/graph.ts TECH_TERMS/마커에 매칭되도록 — 구현 Read 후 맞춤.)

## 9. 문서 / 커밋
- ADR: `docs/adr/0014-postgres-temporal-graph.md`(PG Entity/Relationship로 시작한 이유(Neo4j 미도입, PRD §22), temporal supersede, 규칙 추출 근거).
- `docs/api/graph.md`: graph API 예시.
- 커밋: `feat(db)` → `feat(rag)` graph → `feat(contracts)` → `feat(worker)` → `feat(graph)` api → `chore(shared)` → `test`/`docs`.

## 10. 파티션 맵
- **P1 database**: entities/relationships 2테이블 + enum + self-FK + 추론타입.
- **P2 contracts**: `src/graph.ts` + index 배럴.
- **P3 rag-graph**: `packages/rag/src/graph.ts`(TECH_TERMS/extractGraph) + index 갱신 + vitest.
- **P4 worker**: `apps/worker/src/processors/graph-extract.processor.ts`, `processors.module.ts`(등록+queue).
- **P5 api-graph**: `apps/api/src/graph/**`, `packages/shared/src/constants.ts`(GRAPH_EXTRACT), `apps/api/src/app.module.ts`(GraphModule).
- **P6 verify+docs**: `scripts/verify-phase9.mjs`, ADR 0014, `docs/api/graph.md`.

주의: shared constants/app.module은 **P5만**. worker 파일은 **P4만**. 각 에이전트는 본 스펙 + phase8/7/6 스펙 + 기존 소스(chunks/slack_users/slack_workspaces 스키마, memory/retrieval 소유검증 패턴, rag 패키지, worker processors, contracts, shared)를 Read.
