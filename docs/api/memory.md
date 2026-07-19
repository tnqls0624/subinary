# 장기 기억 API 명세 (Long-term Memory)

> Phase 8 기준. 계약 스키마의 단일 소스는 `@family/contracts`(zod, `src/memory.ts`)이며, 본 문서는
> 예시다. 모든 엔드포인트는 전역 prefix `v1` 을 사용하고 일반 사용자 인증(Bearer)이 필요하다. 시각은
> ISO 8601 문자열(`toISOString`), 기간 경계·표시는 `Asia/Seoul`, Slack `ts` 는 `"epoch.micro"` 문자열이다.
>
> 관련 설계: [ADR-0013 장기 기억 후보/승인](../adr/0013-memory-candidates-and-approval.md) ·
> [ADR-0012 Hybrid RAG](../adr/0012-hybrid-rag-retrieval.md) ·
> [ADR-0011 Slack Import JSON 번들](../adr/0011-slack-import-json-bundle.md) ·
> [ADR-0004 모델 비종속 AI provider](../adr/0004-model-agnostic-ai-providers.md) ·
> [Phase 8 빌드 스펙](../phase8-build-spec.md)

## 개요

Phase 8 은 Phase 7 이 인덱싱한 Slack `chunks` 를 **결정적 규칙**으로 후보 기억(Task/Decision/Incident/
Procedure/Fact)으로 추출하고, 사용자가 **검토 → 승인/거부**해야 정식 기억이 되며, 모든 기억은 **원문
(provenance)** 으로 역추적되고, **현재/과거를 `validFrom`/`validUntil` + supersede** 로 구분하며,
수정은 **버전 스냅샷**으로 남긴다.

| 동작 | 방식 | 경로 |
|---|---|---|
| 추출 트리거(비동기) | JWT | `POST /v1/memory/extract` |
| 후보 목록 | JWT | `GET /v1/memory/candidates` |
| 후보 승인 | JWT | `POST /v1/memory/candidates/:id/approve` |
| 후보 거부 | JWT | `POST /v1/memory/candidates/:id/reject` |
| 기억 목록(현재/과거) | JWT | `GET /v1/memory/memories` |
| 기억 직접 생성 | JWT | `POST /v1/memory/memories` |
| 기억 수정 | JWT | `PATCH /v1/memory/memories/:id` |
| 기억 대체(supersede) | JWT | `POST /v1/memory/memories/:id/supersede` |
| 기억 삭제(soft) | JWT | `DELETE /v1/memory/memories/:id` |

- **스코프(`workspaceId`)**: memory 는 개인 데이터 컨테이너 **`workspaces.id`** 를 스코프로 쓴다
  (Slack import 응답의 `slackWorkspaceId`(= `slack_workspaces.id`)가 **아니다**). `workspaceId` 는
  `GET /v1/slack/workspaces/:id` 응답의 `workspaceId` 필드에서 얻는다(RAG/AI 와 동일).
- **접근제어(PRD §26)**: `workspaces.ownerUserId == 요청자`인 **소유자 본인만** 읽고 쓸 수 있다. 후보/
  기억을 해석한 뒤 그 workspace 소유를 재검증한다 — 없는 workspace/엔티티는 `404`, 비소유자는 `403`.
- **추출은 결정적 규칙 함수**(PRD §3.4, `@family/rag`): 세그먼트(청크의 `"작성자: 내용"` 줄) 단위 키워드
  규칙으로 분류한다. 우선순위는 incident(장애/에러/오류/실패/문제 + 해결/복구/조치/해소 등 해결 맥락)
  → task(담당/맡/…) → decision(결정/하기로/선택했/…) → procedure(절차/방법/순서/단계) → preference
  → fact. `confidence` 는 키워드 매칭 90, 순수 fact 60. 키워드 없는 10자 미만은 노이즈로 skip.
  실제 LLM 추출로 교체 가능하도록 순수 함수 경계를 유지한다.
- **자동 증분 추출**: RAG가 current chunk/embedding을 게시하면 `rag.chunk.memory-ready.v1` outbox
  event가 `{workspaceId, chunkId, chunkRevisionId}` target 잡을 만든다. 워커는 current revision을
  재확인하고 해당 청크만 읽는다. `POST /extract`는 복구·extractor backfill용 workspace 전체 rebuild다.
- **멱등/버전**: 후보 identity는 `workspaceId + sourceChunkRevisionId + type + subjectHash +
  extractorVersion`이다. 동일 revision 재시도는 중복을 만들지 않고, 새 revision/추출기 결과는 기존
  사용자 검토 상태를 덮지 않는 별도 후보다. 편집 전 후보는 rejected, tombstone 후보 본문은 삭제된다.
- **원문 연결(PRD §3.1)**: 승인 시 `memory_sources` 에 `chunk`(sourceRefId=chunk uuid) + 원본 참조가
  있으면 `slack_message`(sourceRefId=threadTs)를 넣어 원문까지 역추적한다. 직접 생성은 `manual`.
- **로그 비노출(PRD §11)**: `subject`/`content`/PII/secret 을 운영 로그에 남기지 않는다(개수/식별자만).

### 열거형(enum)

| 스키마 | 값 |
|---|---|
| `memoryType` | `event` · `fact` · `decision` · `preference` · `procedure` · `incident` · `task` |
| `memoryStatus` | `candidate` · `approved` · `rejected` · `superseded` |
| `candidateStatus` | `pending` · `approved` · `rejected` |
| `memorySourceType`(응답 `sources[].sourceType`) | `chunk` · `slack_message` · `card_sms` · `manual` |

> `event` 는 규칙 추출이 만들지 않는다(공통 Timeline `personal_events` = Phase 9).

---

## 1. 추출 트리거 — `POST /v1/memory/extract`

소유한 workspace 의 current chunk revision 전체를 다시 규칙 추출하는 복구/backfill 잡을 큐에 넣는다.
일상적인 메시지 변경은 RAG outbox가 자동으로 대상 revision만 처리한다.

### 요청 (`memoryExtractRequestSchema`)

| 필드 | 필수 | 규칙 |
|---|---|---|
| `workspaceId` | ✅ | 개인 컨테이너 `workspaces.id`(uuid). 요청자가 소유해야 함. |

```bash
curl -s -X POST http://localhost:3001/v1/memory/extract \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{ "workspaceId": "0a1b2c3d-…" }'
```

### 응답 `202 Accepted` (`memoryExtractResponseSchema`)

```json
{ "jobId": "memory-extract_0a1b2c3d-…", "status": "queued" }
```

- 비소유자 → `403`, 없는 workspace → `404`.

---

## 2. 후보 목록 — `GET /v1/memory/candidates`

추출된 후보를 최신순(`extractedAt` 내림차순)으로 조회한다.

### 쿼리

| 필드 | 필수 | 규칙 |
|---|---|---|
| `workspaceId` | ✅ | `workspaces.id`(uuid). 요청자 소유. |
| `status` | 선택 | `pending` · `approved` · `rejected` 필터. |

```bash
curl -s 'http://localhost:3001/v1/memory/candidates?workspaceId=0a1b2c3d-…&status=pending' \
  -H 'Authorization: Bearer <accessToken>'
```

### 응답 `200 OK` (`candidateListResponseSchema`)

```json
{
  "items": [
    {
      "id": "c0000000-…",
      "type": "decision",
      "subject": "soobeen: PostgreSQL 파티셔닝을 도입하기로 결정했습니다",
      "content": "soobeen: PostgreSQL 파티셔닝을 도입하기로 결정했습니다",
      "confidence": 90,
      "status": "pending",
      "sourceChunkId": "ch000000-…",
      "sourceChunkRevisionId": "cr000000-…",
      "extractorVersion": "memory-rule-v1",
      "sourceRefId": "1721400000.000100",
      "extractedAt": "2026-07-16T02:00:00.000Z"
    }
  ]
}
```

- `sourceChunkRevisionId`와 `extractorVersion`이 재현 경계이며, `sourceRefId`는 원본 Slack
  `threadTs`/`ts`를 역추적한다.

---

## 3. 후보 승인 — `POST /v1/memory/candidates/:id/approve`

pending 후보를 `approved` 기억으로 승격한다(한 트랜잭션: `memories` + `memory_sources` +
`memory_versions` v1, 후보 status='approved' + `promotedMemoryId`). 승인 시 편집을 허용한다.

### 요청 (`candidateApproveRequestSchema`) — 모두 선택

| 필드 | 규칙 |
|---|---|
| `subject` | 승인 시 subject 덮어쓰기. |
| `content` | 승인 시 content 덮어쓰기. |
| `validFrom` | ISO datetime. 미지정 시 now. |
| `validUntil` | ISO datetime. 미지정 시 null(현재 유효). |

```bash
curl -s -X POST http://localhost:3001/v1/memory/candidates/c0000000-…/approve \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### 응답 `200 OK` (`memorySummarySchema`)

```json
{
  "id": "m0000000-…",
  "type": "decision",
  "subject": "soobeen: PostgreSQL 파티셔닝을 도입하기로 결정했습니다",
  "content": "soobeen: PostgreSQL 파티셔닝을 도입하기로 결정했습니다",
  "validFrom": "2026-07-16T02:00:05.000Z",
  "validUntil": null,
  "observedAt": "2026-07-16T02:00:00.000Z",
  "confidence": 90,
  "status": "approved",
  "supersedesMemoryId": null,
  "isCurrent": true,
  "sources": [
    { "sourceType": "chunk", "sourceRefId": "ch000000-…" },
    { "sourceType": "slack_message", "sourceRefId": "1721400000.000100" }
  ],
  "createdAt": "2026-07-16T02:00:05.000Z"
}
```

- pending 이 아닌 후보 → `409 Conflict`. 비소유자 → `403`, 없는 후보 → `404`.

---

## 4. 후보 거부 — `POST /v1/memory/candidates/:id/reject`

후보 status 를 `rejected` 로 바꾼다(기억은 만들지 않는다).

```bash
curl -s -X POST http://localhost:3001/v1/memory/candidates/c0000001-…/reject \
  -H 'Authorization: Bearer <accessToken>'
```

### 응답 `200 OK` (`candidateSummarySchema`)

```json
{
  "id": "c0000001-…",
  "type": "incident",
  "subject": "soobeen: Route53 인증서 만료로 장애가 발생하여 ACM 재발급으로 해결했습니다",
  "content": "…",
  "confidence": 90,
  "status": "rejected",
  "sourceChunkId": "ch000001-…",
  "sourceRefId": "1721400200.000100",
  "extractedAt": "2026-07-16T02:00:00.000Z"
}
```

---

## 5. 기억 목록(현재/과거) — `GET /v1/memory/memories`

soft delete 되지 않은 기억을 최신순(`createdAt` 내림차순)으로 조회한다. `sources` 를 조인하고
`isCurrent` 를 파생한다.

### 쿼리

| 필드 | 필수 | 규칙 |
|---|---|---|
| `workspaceId` | ✅ | `workspaces.id`(uuid). 요청자 소유. |
| `type` | 선택 | `memoryType` 필터. |
| `status` | 선택 | `memoryStatus` 필터. |
| `current` | 선택 | `'true'`/`'false'`. `true` → `approved` AND (`validUntil` null 또는 미래)만. |
| `asOf` | 선택 | ISO datetime. 그 시점 유효(`validFrom<=asOf` AND (`validUntil` null 또는 `>asOf`))만. |

```bash
# 현재 유효한 기억만
curl -s 'http://localhost:3001/v1/memory/memories?workspaceId=0a1b2c3d-…&current=true' \
  -H 'Authorization: Bearer <accessToken>'

# 과거 특정 시점 기준(당시 유효했던 기억 — superseded 포함)
curl -s 'http://localhost:3001/v1/memory/memories?workspaceId=0a1b2c3d-…&asOf=2021-06-01T00:00:00.000Z' \
  -H 'Authorization: Bearer <accessToken>'
```

### 응답 `200 OK` (`memoryListResponseSchema`)

```json
{ "items": [ /* memorySummary … */ ] }
```

> `current` 와 `asOf` 는 애플리케이션 로직(SQL WHERE)으로 판정한다(PRD §3.3). `asOf` 는 status 를
> 필터하지 않으므로 그 시점에 유효했던 `superseded` 기억도 포함한다(과거 스냅샷 재현).

---

## 6. 기억 직접 생성 — `POST /v1/memory/memories`

후보 단계 없이 `approved` 기억을 만든다(PRD §20 "명시적으로 기억 요청 → 즉시 승인"). provenance 는
`manual`(원문은 자기 자신), `confidence`=100, `memory_versions` v1 을 남긴다.

### 요청 (`memoryCreateRequestSchema`)

| 필드 | 필수 | 규칙 |
|---|---|---|
| `workspaceId` | ✅ | `workspaces.id`(uuid). 요청자 소유. |
| `type` | ✅ | `memoryType`. |
| `subject` | ✅ | `min(1)`. |
| `content` | ✅ | `min(1)`. |
| `validFrom` | 선택 | ISO datetime. 미지정 시 `observedAt`. |
| `validUntil` | 선택 | ISO datetime. 미지정 시 null. |
| `observedAt` | 선택 | ISO datetime. 미지정 시 now. |

```bash
curl -s -X POST http://localhost:3001/v1/memory/memories \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{ "workspaceId": "0a1b2c3d-…", "type": "fact", "subject": "결제 서버 인스턴스 타입은 t3.medium 이다", "content": "결제 서버 인스턴스 타입은 t3.medium 이다" }'
```

### 응답 `201 Created` (`memorySummarySchema`)

`status: "approved"`, `isCurrent: true`, `sources: [{ "sourceType": "manual", "sourceRefId": "<memoryId>" }]`.

---

## 7. 기억 수정 — `PATCH /v1/memory/memories/:id`

기억을 편집한다. **변경 전** 상태를 `memory_versions`(version = 현재 최대 + 1)로 먼저 스냅샷한 뒤
변경을 적용한다.

### 요청 (`memoryUpdateRequestSchema`) — 모두 선택

| 필드 | 규칙 |
|---|---|
| `subject` | 새 subject. |
| `content` | 새 content. |
| `validUntil` | ISO datetime **또는 `null`**(null → 만료 해제, 다시 현재 유효화). |
| `changeReason` | 변경 사유(버전에 기록). |

```bash
curl -s -X PATCH http://localhost:3001/v1/memory/memories/m0000000-… \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{ "content": "수정된 본문", "changeReason": "오탈자 수정" }'
```

### 응답 `200 OK` (`memorySummarySchema`)

수정이 반영된 최신 기억. 변경 전 상태는 `memory_versions` 로 보존된다.

---

## 8. 기억 대체(supersede) — `POST /v1/memory/memories/:id/supersede`

사실이 바뀌었을 때 기존을 닫고 새 기억으로 대체한다(한 트랜잭션). 기존 → `superseded`
(`validUntil=now`), 새 기억 → `approved`(`supersedesMemoryId=<기존>`, `validFrom=now`,
`validUntil=null`), 기존 provenance 를 복사(없으면 `manual`), `memory_versions` v1.

### 요청 (`memorySupersedeRequestSchema`)

| 필드 | 필수 | 규칙 |
|---|---|---|
| `type` | ✅ | `memoryType`(대체 기억의 종류). |
| `subject` | ✅ | 대체 기억 subject. |
| `content` | ✅ | 대체 기억 content. |
| `observedAt` | 선택 | ISO datetime. 미지정 시 now. |

```bash
curl -s -X POST http://localhost:3001/v1/memory/memories/m0000001-…/supersede \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{ "type": "fact", "subject": "결제 서버 인스턴스 타입은 t3.large 이다", "content": "결제 서버를 t3.large 로 증설했다" }'
```

### 응답 `201 Created` (`memorySummarySchema`)

새 기억(`isCurrent: true`, `supersedesMemoryId` 설정). 이후 `current=true` 조회는 새 기억만,
과거 `asOf` 조회는 기존 기억을 돌려준다.

---

## 9. 기억 삭제(soft) — `DELETE /v1/memory/memories/:id`

`deletedAt` 을 설정하는 soft delete. 이후 목록에서 제외된다.

```bash
curl -s -X DELETE http://localhost:3001/v1/memory/memories/m0000000-… \
  -H 'Authorization: Bearer <accessToken>'
```

### 응답 `200 OK`

```json
{ "deleted": true }
```

---

## 오류

| 상황 | 코드 |
|---|---|
| 비소유자의 workspace/후보/기억 접근 | `403 Forbidden` |
| 없는 workspace / 후보 / 기억 | `404 Not Found` |
| pending 이 아닌 후보 승인 | `409 Conflict` |
| 스키마 위반(필수 누락 · 잘못된 enum/uuid/datetime) | `400 Bad Request` |
| 미인증(Bearer 없음/만료) | `401 Unauthorized` |

> 모든 시각은 ISO 8601(UTC `Z`)로 응답하고 표시·기간 경계는 `Asia/Seoul` 기준으로 렌더한다.
> 응답/로그 어디에도 secret 은 포함되지 않으며, 운영 로그는 개수/식별자만 남긴다(PRD §11).
