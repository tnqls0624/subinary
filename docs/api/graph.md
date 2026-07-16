# Temporal Graph API 명세 (Entity / Relationship / Timeline)

> Phase 9 기준. 계약 스키마의 단일 소스는 `@family/contracts`(zod, `src/graph.ts`)이며, 본 문서는
> 예시다. 모든 엔드포인트는 전역 prefix `v1` 을 사용하고 일반 사용자 인증(Bearer)이 필요하다. 시각은
> ISO 8601 문자열(`toISOString`), 기간 경계·표시는 `Asia/Seoul`, Slack `ts` 는 `"epoch.micro"` 문자열이다.
>
> 관련 설계: [ADR-0014 PostgreSQL Temporal Graph](../adr/0014-postgres-temporal-graph.md) ·
> [ADR-0013 장기 기억 후보/승인](../adr/0013-memory-candidates-and-approval.md) ·
> [ADR-0012 Hybrid RAG](../adr/0012-hybrid-rag-retrieval.md) ·
> [ADR-0011 Slack Import JSON 번들](../adr/0011-slack-import-json-bundle.md) ·
> [Phase 9 빌드 스펙](../phase9-build-spec.md)

## 개요

Phase 9 는 Phase 6/7 이 인덱싱한 Slack `chunks`(+ `slack_users`)를 **결정적 규칙**으로 Entity
(person/technology)와 Relationship(relates_to/resolves)로 추출하고, 관계의 시간성을
**`validFrom`/`validUntil` + 명시적 supersede** 로 다루며, **Local Graph**(이웃 조회)와
**Timeline**(관계 형성/변경 이력)을 제공한다. 전용 그래프DB(Neo4j) 없이 **PostgreSQL 두 테이블**
(`entities`/`relationships`)로 표현하고 traversal 은 1-hop 이웃 + 앱 확장이다(PRD §22).

| 동작 | 방식 | 경로 |
|---|---|---|
| 추출 트리거(비동기) | JWT | `POST /v1/graph/extract` |
| entity 목록 | JWT | `GET /v1/graph/entities` |
| entity 상세(Local Graph) | JWT | `GET /v1/graph/entities/:id` |
| relationship 목록(현재/과거) | JWT | `GET /v1/graph/relationships` |
| relationship 대체(supersede) | JWT | `POST /v1/graph/relationships/:id/supersede` |
| Timeline | JWT | `GET /v1/graph/timeline` |

- **스코프(`workspaceId`)**: graph 는 개인 데이터 컨테이너 **`workspaces.id`** 를 스코프로 쓴다
  (Slack import 응답의 `slackWorkspaceId`(= `slack_workspaces.id`)가 **아니다**). `workspaceId` 는
  `GET /v1/slack/workspaces/:id` 응답의 `workspaceId` 필드에서 얻는다(RAG/AI/memory 와 동일).
- **접근제어(PRD §26)**: `workspaces.ownerUserId == 요청자`인 **소유자 본인만** 읽고 쓸 수 있다. entity/
  relationship 을 해석한 뒤 그 workspace 소유를 재검증한다 — 없는 workspace/엔티티는 `404`, 비소유자는
  `403`.
- **추출은 결정적 규칙 함수**(PRD §3.4, `@family/rag` `graph.ts`): 랜덤/시간/LLM 을 쓰지 않는다.
  - `technology` entity — 기술 사전 `TECH_TERMS`(route53, acm, postgresql, redis, s3, docker,
    kubernetes, nginx, graphql, bullmq, pgvector … 대소문자 무시, 한국어 표기 포함)가 chunk 텍스트에
    등장하면 등록(canonicalName = 정규화 소문자 term).
  - `person` entity — 워크스페이스의 `slack_users` 전원 등록(canonicalName = slackUserId).
  - relationship(chunk 단위) — 같은 chunk 안 technology 쌍을 canonical 오름차순으로 `relates_to`
    (confidence 70)로 잇고, chunk 에 해결 마커 `RESOLUTION_MARKERS`(해결/복구/조치/재발급/해소/resolved/
    fixed)가 있으면 `resolves`(confidence 90)로 올린다. `sourceRefId` = chunk 의 원본 Slack `threadTs`/
    `ts`(원문 연결).
  - **Phase 9 축소(스펙 §5)**: `works_on`(person↔technology)은 chunk 에 author 정보가 없어 자동 생성하지
    않는다. person entity 는 등록만 한다(chunk 에 author 가 붙는 확장 지점). 실제 LLM 추출로 교체 가능
    하도록 순수 함수 경계를 유지한다.
- **비동기 추출**: `POST /extract` 는 소유 검증 후 `graph-extract` 큐에 넣고 `202 Accepted` 로 응답한다.
  워커가 entity/relationship 을 적재하므로 직후 짧은 시간 동안 비어 있을 수 있다 — 검증은
  `GET /entities` 를 폴링(권장 상한 15초)한다. 커스텀 jobId 는 `graph-extract_<workspaceId>`(BullMQ
  제약상 `:` 대신 `_`).
- **Temporal(현재/과거, PRD §20/§3.3)**: relationship 은 `validFrom`(= chunk.occurredAt)/`validUntil`
  (null=현재)/`supersedesRelationshipId`(대체 체인)를 갖는다. 조회 필터는 애플리케이션 로직(SQL WHERE):
  - `current=true` → `validUntil IS NULL OR validUntil > now`.
  - `asOf=DATE` → `validFrom <= asOf AND (validUntil IS NULL OR validUntil > asOf)` — 과거 스냅샷
    (당시 유효했던 관계, 이미 대체된 것 포함).
  - `isCurrent`(validUntil null|미래)는 응답에 파생 포함한다.
- **멱등(스펙 §1.1/§1.2)**: entity `UNIQUE(workspaceId, type, canonicalName)` + `onConflictDoUpdate`
  (validFrom = least), relationship `UNIQUE(workspaceId, sourceEntityId, type, targetEntityId,`
  `sourceRefId)` + `onConflictDoNothing` → `extract` 재실행해도 entity/relationship 이 중복 생성되지
  않고 닫힌 관계도 되살아나지 않는다.
- **로그 비노출(PRD §11)**: entity `name`/원문/PII/secret 을 운영 로그에 남기지 않는다(개수/식별자만).

### 열거형(enum)

| 스키마 | 값 |
|---|---|
| `entityType` | `person` · `technology` · `project` · `decision` · `incident` · `topic` |
| `relationshipType` | `relates_to` · `resolves` · `works_on` · `uses` · `decides` · `supersedes` |

> Phase 9 자동 추출은 `technology`/`person` entity 와 `relates_to`/`resolves`(tech–tech) 관계만 만든다.
> 나머지 enum 값은 확장 지점(스펙 §0/§5)이다.

---

## 1. 추출 트리거 — `POST /v1/graph/extract`

소유한 workspace 의 `chunks` + `slack_users` 를 규칙 추출해 `entities`/`relationships` 를 upsert 하는
잡을 큐에 넣는다.

### 요청 (`graphExtractRequestSchema`)

| 필드 | 필수 | 규칙 |
|---|---|---|
| `workspaceId` | ✅ | 개인 컨테이너 `workspaces.id`(uuid). 요청자가 소유해야 함. |

```bash
curl -s -X POST http://localhost:3001/v1/graph/extract \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{ "workspaceId": "0a1b2c3d-…" }'
```

### 응답 `202 Accepted` (`graphExtractResponseSchema`)

```json
{ "jobId": "graph-extract_0a1b2c3d-…", "status": "queued" }
```

- 비소유자 → `403`, 없는 workspace → `404`.

---

## 2. entity 목록 — `GET /v1/graph/entities`

추출된 entity 를 조회한다.

### 쿼리

| 필드 | 필수 | 규칙 |
|---|---|---|
| `workspaceId` | ✅ | `workspaces.id`(uuid). 요청자 소유. |
| `type` | 선택 | `entityType` 필터(예: `technology`, `person`). |
| `q` | 선택 | `name` 부분 일치(ILIKE). |

```bash
curl -s 'http://localhost:3001/v1/graph/entities?workspaceId=0a1b2c3d-…&type=technology' \
  -H 'Authorization: Bearer <accessToken>'
```

### 응답 `200 OK` (`entityListResponseSchema`)

```json
{
  "items": [
    {
      "id": "e1000000-…",
      "type": "technology",
      "name": "Route53",
      "canonicalName": "route53",
      "validFrom": "2024-07-19T14:40:00.000Z",
      "validUntil": null,
      "isCurrent": true,
      "createdAt": "2026-07-16T02:00:00.000Z"
    },
    {
      "id": "e2000000-…",
      "type": "person",
      "name": "수빈",
      "canonicalName": "U1",
      "validFrom": "2024-07-19T14:40:00.000Z",
      "validUntil": null,
      "isCurrent": true,
      "createdAt": "2026-07-16T02:00:00.000Z"
    }
  ]
}
```

- `canonicalName` = 멱등 키(technology = 정규화 소문자 term, person = slackUserId).
- `isCurrent` = `validUntil` 이 null 또는 미래.

---

## 3. entity 상세(Local Graph) — `GET /v1/graph/entities/:id`

entity 하나와 그 **1-hop 이웃**(source 또는 target 으로 참여하는 relationship + 상대 entity)을 돌려준다.

### 쿼리

| 필드 | 필수 | 규칙 |
|---|---|---|
| `current` | 선택 | `'true'` → 현재 유효한 관계 이웃만. |
| `asOf` | 선택 | ISO datetime. 그 시점 유효했던 관계 이웃만. |

```bash
curl -s 'http://localhost:3001/v1/graph/entities/e1000000-…' \
  -H 'Authorization: Bearer <accessToken>'
```

### 응답 `200 OK` (`entityDetailSchema`)

```json
{
  "entity": {
    "id": "e1000000-…",
    "type": "technology",
    "name": "Route53",
    "canonicalName": "route53",
    "validFrom": "2024-07-19T14:40:00.000Z",
    "validUntil": null,
    "isCurrent": true,
    "createdAt": "2026-07-16T02:00:00.000Z"
  },
  "neighbors": [
    {
      "relationship": {
        "id": "r1000000-…",
        "type": "resolves",
        "sourceEntityId": "e3000000-…",
        "targetEntityId": "e1000000-…",
        "sourceName": "ACM",
        "targetName": "Route53",
        "validFrom": "2024-07-19T14:40:00.000Z",
        "validUntil": null,
        "supersedesRelationshipId": null,
        "isCurrent": true,
        "sourceRefId": "1721400000.000100",
        "confidence": 90
      },
      "entity": {
        "id": "e3000000-…",
        "type": "technology",
        "name": "ACM",
        "canonicalName": "acm",
        "validFrom": "2024-07-19T14:40:00.000Z",
        "validUntil": null,
        "isCurrent": true,
        "createdAt": "2026-07-16T02:00:00.000Z"
      }
    }
  ]
}
```

- `neighbors[].entity` 는 관계의 **상대편** entity(요청한 entity 가 source 면 target, target 이면 source).
- 없는 entity → `404`, 비소유자 → `403`.

---

## 4. relationship 목록(현재/과거) — `GET /v1/graph/relationships`

relationship 을 조회한다. 양끝 entity 의 `name` 을 조인하고 `isCurrent` 를 파생한다.

### 쿼리

| 필드 | 필수 | 규칙 |
|---|---|---|
| `workspaceId` | ✅ | `workspaces.id`(uuid). 요청자 소유. |
| `entityId` | 선택 | 이 entity 가 source 또는 target 인 관계만. |
| `type` | 선택 | `relationshipType` 필터(예: `resolves`, `relates_to`). |
| `current` | 선택 | `'true'` → `validUntil` null 또는 미래인 관계만. |
| `asOf` | 선택 | ISO datetime. 그 시점 유효(`validFrom<=asOf` AND (`validUntil` null 또는 `>asOf`))한 관계만. |

```bash
# 장애-해결책 관계 검색
curl -s 'http://localhost:3001/v1/graph/relationships?workspaceId=0a1b2c3d-…&type=resolves' \
  -H 'Authorization: Bearer <accessToken>'

# 현재 유효한 관계만
curl -s 'http://localhost:3001/v1/graph/relationships?workspaceId=0a1b2c3d-…&current=true' \
  -H 'Authorization: Bearer <accessToken>'

# 과거 특정 시점 기준(당시 유효했던 관계 — 이미 대체된 것 포함)
curl -s 'http://localhost:3001/v1/graph/relationships?workspaceId=0a1b2c3d-…&asOf=2025-01-01T00:00:00.000Z' \
  -H 'Authorization: Bearer <accessToken>'
```

### 응답 `200 OK` (`relationshipListResponseSchema`)

```json
{ "items": [ /* relationshipSummary … */ ] }
```

> `current` 와 `asOf` 는 애플리케이션 로직(SQL WHERE)으로 판정한다(PRD §3.3). `asOf` 는 그 시점에
> 유효했던, 이미 대체(supersede)된 관계도 포함한다(과거 스냅샷 재현).

---

## 5. relationship 대체(supersede) — `POST /v1/graph/relationships/:id/supersede`

결정/구조가 바뀌었을 때 기존 관계를 닫고 새 관계로 대체한다(한 트랜잭션). 기존 → `validUntil=now`,
새 관계 → `supersedesRelationshipId=<기존>`, `validFrom=now`, `validUntil=null`. 대체는 **명시적**
이며 추출기가 자동 추론하지 않는다(스펙 §1.3).

### 요청 (`relationshipSupersedeRequestSchema`)

| 필드 | 필수 | 규칙 |
|---|---|---|
| `sourceEntityId` | ✅ | 대체 관계의 source entity(uuid). |
| `targetEntityId` | ✅ | 대체 관계의 target entity(uuid). |
| `type` | ✅ | `relationshipType`(대체 관계의 종류). |
| `sourceRefId` | 선택 | 원문 연결(chunk 의 원본 Slack `ts`). 미지정 시 null. |

```bash
curl -s -X POST http://localhost:3001/v1/graph/relationships/r2000000-…/supersede \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{ "sourceEntityId": "e4000000-…", "targetEntityId": "e5000000-…", "type": "relates_to" }'
```

### 응답 `201 Created` (`relationshipSummarySchema`)

```json
{
  "id": "r3000000-…",
  "type": "relates_to",
  "sourceEntityId": "e4000000-…",
  "targetEntityId": "e5000000-…",
  "sourceName": "PostgreSQL",
  "targetName": "Redis",
  "validFrom": "2026-07-16T02:00:05.000Z",
  "validUntil": null,
  "supersedesRelationshipId": "r2000000-…",
  "isCurrent": true,
  "sourceRefId": null,
  "confidence": 60
}
```

- 새 관계(`isCurrent: true`, `supersedesRelationshipId` 설정). 이후 `current=true` 조회는 새 관계만,
  과거 `asOf` 조회는 기존 관계를 돌려준다(결정 변화 = supersede 체인).
- 없는 관계 → `404`, 비소유자 → `403`.

---

## 6. Timeline — `GET /v1/graph/timeline`

entity 관련 relationship 을 **`validFrom` 오름차순**으로 돌려준다(관계 형성/변경 이력 — supersede 전후가
시간순으로 나열된다).

### 쿼리

| 필드 | 필수 | 규칙 |
|---|---|---|
| `workspaceId` | ✅ | `workspaces.id`(uuid). 요청자 소유. |
| `entityId` | ✅ | 대상 entity(uuid). source 또는 target 으로 참여하는 관계를 모은다. |

```bash
curl -s 'http://localhost:3001/v1/graph/timeline?workspaceId=0a1b2c3d-…&entityId=e4000000-…' \
  -H 'Authorization: Bearer <accessToken>'
```

### 응답 `200 OK` (`timelineResponseSchema`)

```json
{
  "entityId": "e4000000-…",
  "items": [
    { "id": "r2000000-…", "type": "relates_to", "validFrom": "2024-07-19T14:40:00.000Z", "validUntil": "2026-07-16T02:00:05.000Z", "isCurrent": false, "supersedesRelationshipId": null, "…": "…" },
    { "id": "r3000000-…", "type": "relates_to", "validFrom": "2026-07-16T02:00:05.000Z", "validUntil": null, "isCurrent": true, "supersedesRelationshipId": "r2000000-…", "…": "…" }
  ]
}
```

- `items` 는 `relationshipSummary` 배열(닫힌 관계 + 현재 관계 모두 포함, `validFrom` 오름차순).
- 없는 entity → `404`, 비소유자 → `403`.

---

## 오류

| 상황 | 코드 |
|---|---|
| 비소유자의 workspace/entity/relationship 접근 | `403 Forbidden` |
| 없는 workspace / entity / relationship | `404 Not Found` |
| 스키마 위반(필수 누락 · 잘못된 enum/uuid/datetime) | `400 Bad Request` |
| 미인증(Bearer 없음/만료) | `401 Unauthorized` |

> 모든 시각은 ISO 8601(UTC `Z`)로 응답하고 표시·기간 경계는 `Asia/Seoul` 기준으로 렌더한다.
> 응답/로그 어디에도 secret 은 포함되지 않으며, 운영 로그는 개수/식별자만 남긴다(PRD §11).
