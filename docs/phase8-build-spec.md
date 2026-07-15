# Phase 8 Build Spec — 장기 기억 (Long-term Memory)

> Phase 0~7 규약 준수(패키지 `type:module` 금지, 공용 dev 이미지, 소스 바인드마운트, Asia/Seoul, 로그 Secret/PII 금지, 새 env는 `.env`도, 새 npm 의존성 시 lockfile 재생성, 교차모듈 `@UseGuards`는 가드 의존성까지 export, drizzle `GROUP BY` ordinal, **BullMQ 커스텀 jobId 에 ':' 금지 → '_' 사용**, SWC watch 재시작 포트 경합 시 컨테이너 clean restart).

---

## 0. 목표 & 완료 조건 (PRD §31 Phase 8)

범위: Task/Decision/Incident/Procedure/Fact 추출 / Memory Candidate / 사용자 승인 / 기억 수정과 삭제.

완료 조건(실측, `scripts/verify-phase8.mjs`):
1. 후보 기억 검토 가능(추출 → candidates 조회).
2. 승인·거부 가능(candidate → memory 또는 rejected).
3. 기억과 원문 연결(memory_sources로 chunk/원문 역추적).
4. 현재 정보와 과거 정보 구분(validFrom/validUntil + supersede).
5. 권한: workspace 소유자만(개인 기억, 유출 0).

### 경계 & 전제
- **추출은 결정적 규칙 함수**(`@family/rag`). PRD상 실제로는 LLM 추출이지만 Mock 환경 검증을 위해 키워드 기반 분류 사용(모델 비종속 — 실제 LLM 추출로 교체 가능하도록 순수 함수 경계 유지).
- 대상 데이터는 Phase 6/7의 Slack chunks. 카드 기록 기반 기억은 확장 지점(생략).
- `personal_events`(공통 Timeline, PRD §19)·GraphRAG는 Phase 9. `memory_feedback`은 후순위(생략).

---

## 1. 핵심 설계

### 1.1 후보 → 승인 → 기억
- 추출(worker `memory-extract` 잡): workspace의 chunks 텍스트 → `extractMemoryCandidates`(규칙) → `memory_candidates`(status='pending', sourceChunkId 연결). 멱등: UNIQUE(workspaceId, sourceChunkId, type, subjectHash).
- 검토/승인: 사용자가 candidates 조회 → approve(→ `memories` 생성, status='approved', `memory_sources` 원문 연결, candidate status='approved') 또는 reject(candidate status='rejected').
- 직접 기억(PRD §20 "명시적으로 기억 요청 → 즉시 승인"): POST memories → status='approved', source 'manual'.

### 1.2 원문 연결 (PRD §3.1)
모든 memory는 `memory_sources`로 원문을 참조: `{ memoryId, sourceType('chunk'|'slack_message'|'card_sms'|'manual'), sourceRefId }`. candidate도 sourceChunkId를 가진다. 승인 시 chunk → 원본 스레드(slack) 역추적 가능.

### 1.3 현재/과거 구분 (PRD §20)
- `memories.validFrom`(기본 observedAt), `validUntil`(null=현재 유효). `observedAt`(관측 시점).
- **supersede**: 새 기억 B가 기존 A를 대체 → A.validUntil=now, A.status='superseded', B.supersedesMemoryId=A.id, B.validFrom=now.
- 조회: `current=true` → status='approved' AND (validUntil null OR validUntil>now). `asOf=DATE` → validFrom<=asOf AND (validUntil null OR validUntil>asOf).

### 1.4 수정 이력
`memory_versions`: PATCH 시 변경 전 스냅샷 저장(version 증가). subject/content/changeReason/changedBy.

### 1.5 권한
memory는 workspace 소유자만(workspaces.ownerUserId==userId). 비소유자 403(PRD §26).

---

## 2. 데이터 모델 — `packages/database` (schema.ts 확장)

### pgEnum
- `memoryType` = `['event','fact','decision','preference','procedure','incident','task']` (PRD §20)
- `memoryStatus` = `['candidate','approved','rejected','superseded']`
- `candidateStatus` = `['pending','approved','rejected']`
- `memorySourceType` = `['chunk','slack_message','card_sms','manual']`

### 테이블
```
memory_candidates
  id uuid pk
  workspaceId uuid not null -> workspaces.id
  type memoryType not null
  subject text not null
  content text not null
  confidence integer not null            -- 0~100
  sourceChunkId uuid null -> chunks.id
  sourceRefId text null                  -- chunk sourceRefId(threadTs 등)
  status candidateStatus not null default 'pending'
  extractedAt timestamptz not null
  promotedMemoryId uuid null -> memories.id   -- 승인 시 연결(self-later FK)
  createdAt / updatedAt
  UNIQUE(workspaceId, sourceChunkId, type, subjectHash)  -- subjectHash = md5(subject) 컬럼
  INDEX(workspaceId), INDEX(workspaceId, status)

memories
  id uuid pk
  workspaceId uuid not null -> workspaces.id
  type memoryType not null
  subject text not null
  content text not null
  validFrom timestamptz null
  validUntil timestamptz null
  observedAt timestamptz not null
  confidence integer not null
  status memoryStatus not null default 'approved'
  supersedesMemoryId uuid null -> memories.id  (self-FK, AnyPgColumn)
  createdBy uuid not null -> users.id
  createdAt / updatedAt / deletedAt
  INDEX(workspaceId), INDEX(workspaceId, type), INDEX(workspaceId, status)

memory_sources
  id uuid pk
  memoryId uuid not null -> memories.id
  sourceType memorySourceType not null
  sourceRefId text not null
  createdAt
  UNIQUE(memoryId, sourceType, sourceRefId)
  INDEX(memoryId)

memory_versions
  id uuid pk
  memoryId uuid not null -> memories.id
  version integer not null
  subject text not null
  content text not null
  changeReason text null
  changedBy uuid not null -> users.id
  changedAt timestamptz not null default now
  UNIQUE(memoryId, version)
  INDEX(memoryId)
```

`subjectHash`는 후보 멱등용 별도 컬럼(text, md5(subject))로 저장(앱이 계산). 추론 타입 export. 마이그레이션 0008. self-FK/forward-FK(candidate.promotedMemoryId → memories)는 AnyPgColumn lazy 콜백.

---

## 3. `@family/rag` — 추출 순수 함수 (`src/extract.ts`)
- `interface MemoryCandidateDraft { type:MemoryType; subject:string; content:string; confidence:number }`
- `type MemoryType = 'event'|'fact'|'decision'|'preference'|'procedure'|'incident'|'task'`
- `function extractMemoryCandidates(text: string): MemoryCandidateDraft[]` — 텍스트를 문장/스레드 단위로 보고 규칙 분류:
  - decision: '결정', '하기로', 'decided', '선택했' 포함.
  - incident: '장애', '에러', '오류', 'incident', '실패', '문제' + 해결 맥락.
  - task: '담당', 'TODO', '하기로 했', '작성 예정', '맡', '할 일'.
  - procedure: '절차', '방법', '순서', 'how to', '단계'.
  - preference: '선호', '좋아', '싫어'.
  - else fact(정보성 문장).
  - subject = 첫 문장/핵심구(최대 120자), content = 발췌(최대 500자), confidence = 규칙 강도(정확 키워드 90, 약함 60).
  - 한 텍스트에서 여러 후보 가능(문단별). 노이즈(짧은 잡담)는 skip(빈 배열).
- `index.ts` 배럴에 추가. vitest ≥8케이스(각 type 분류, 잡담 skip, subject/content 길이, confidence).

> 실제 구현 시엔 `LlmProvider`로 추출하도록 교체 가능(순수 함수 시그니처 유지). Phase 8은 규칙 기반 결정적 추출.

---

## 4. API 계약 — `packages/contracts` (`src/memory.ts` + 배럴)
- `memoryTypeSchema` = `z.enum([...7])`, `memoryStatusSchema`, `candidateStatusSchema`.
- `memoryExtractRequestSchema` = `{ workspaceId: uuid }`
- `memoryExtractResponseSchema` = `{ jobId: string, status: z.enum(['queued']) }`
- `candidateSummarySchema` = `{ id, type, subject, content, confidence: int, status, sourceChunkId: nullable, sourceRefId: nullable, extractedAt: string }`
- `candidateApproveRequestSchema` = `{ validFrom?: string.datetime(), validUntil?: string.datetime(), subject?: string, content?: string }` (승인 시 편집 허용)
- `memorySummarySchema` = `{ id, type, subject, content, validFrom: nullable, validUntil: nullable, observedAt: string, confidence: int, status, supersedesMemoryId: nullable, isCurrent: boolean, sources: { sourceType, sourceRefId }[], createdAt }`
- `memoryCreateRequestSchema` = `{ workspaceId: uuid, type: memoryType, subject: string.min(1), content: string.min(1), validFrom?: string.datetime(), validUntil?: string.datetime(), observedAt?: string.datetime() }`
- `memoryUpdateRequestSchema` = `{ subject?: string, content?: string, validUntil?: string.datetime()|null, changeReason?: string }`
- `memorySupersedeRequestSchema` = `{ type: memoryType, subject: string, content: string, observedAt?: string.datetime() }`  (기존 대체하는 새 기억)
- `candidateListResponseSchema`, `memoryListResponseSchema` = `{ items: [...] }`
- 추론 타입.

---

## 5. apps/worker — 추출
- `apps/worker/package.json`: `@family/rag` 이미 의존(Phase 7). 추가 없음.
- 큐 `QUEUE_NAMES.MEMORY_EXTRACT='memory-extract'`(shared는 P5 api가 추가, worker import).
- `memory-extract.processor.ts`(`@Processor(MEMORY_EXTRACT)`): process({workspaceId}) → 소유 workspace의 chunks 로드 → 각 chunk `extractMemoryCandidates(text)` → memory_candidates upsert(멱등 UNIQUE(workspaceId,sourceChunkId,type,subjectHash), subjectHash=md5(subject)). status='pending', extractedAt=now, sourceRefId=chunk.sourceRefId. 배치. 로그 count만.
- `processors.module`: MemoryExtractProcessor + registerQueue(MEMORY_EXTRACT).

## 6. apps/api — memory 모듈 (`apps/api/src/memory/`)
### 6.1 배선
- `packages/shared/src/constants.ts`: `QUEUE_NAMES.MEMORY_EXTRACT='memory-extract'`.
- `app.module.ts`: MemoryModule import.
### 6.2 memory.service (Db + @InjectQueue(MEMORY_EXTRACT) 주입, workspace 소유 검증 헬퍼)
- `extract(userId, {workspaceId})`: 소유검증 → MEMORY_EXTRACT enqueue({workspaceId}, jobId `memory-extract_${workspaceId}`, removeOnComplete). 반환 {jobId,status:'queued'}.
- `listCandidates(userId, {workspaceId, status?})`: 소유검증 → memory_candidates.
- `approveCandidate(userId, candidateId, edits)`: 소유검증 → candidate(pending) 조회 → 트랜잭션: memories insert(type/subject/content(edits override)/observedAt=extractedAt/validFrom(edits ?? now)/validUntil(edits)/status='approved'/createdBy) + memory_sources insert(chunk sourceType 'chunk', sourceRefId=candidate.sourceChunkId; 있으면 원본 slack thread도) + candidate update(status='approved', promotedMemoryId). memory_versions v1 insert. 반환 memorySummary.
- `rejectCandidate(userId, candidateId)`: status='rejected'.
- `createMemory(userId, input)`: 소유검증 → memories insert(status='approved', createdBy) + memory_sources('manual') + versions v1. 반환.
- `listMemories(userId, {workspaceId, type?, status?, current?, asOf?})`: 소유검증 → 필터. current/asOf 로직(§1.3). sources 조인.
- `updateMemory(userId, id, input)`: 소유검증 → 변경 전 스냅샷 memory_versions insert(version+1) → memories update(subject/content/validUntil). 반환.
- `supersedeMemory(userId, id, input)`: 소유검증 → 트랜잭션: 기존 update(status='superseded', validUntil=now) + 새 memories insert(supersedesMemoryId=id, validFrom=now, status='approved') + 새 memory_sources(기존 sources 복사 or 'manual') + versions. 반환 새 기억.
- `deleteMemory(userId, id)`: soft delete(deletedAt) 또는 status. 반환 {deleted:true}.
- isCurrent 계산(status approved && validUntil null|>now).
### 6.3 컨트롤러 (`@Controller('memory')`, 일반 인증)
- POST `/extract`, GET `/candidates`, POST `/candidates/:id/approve`, POST `/candidates/:id/reject`, GET `/memories`, POST `/memories`, PATCH `/memories/:id`, POST `/memories/:id/supersede`, DELETE `/memories/:id`. CurrentUser. DTO createZodDto. 비소유자 403.
### 6.4 memory.module
`imports: [BullModule.registerQueue({name:QUEUE_NAMES.MEMORY_EXTRACT})]`, providers/controllers.

---

## 7. Docker / 마이그레이션
- 새 npm 의존성 없음(rag 기존). schema 변경 → generate 0008. lockfile 변화 없을 수 있으나 확인.
- 통합: build → rag vitest → generate 0008 → up --force-recreate → verify-phase8.

## 8. 검증 — `scripts/verify-phase8.mjs`
1. userA + Slack import(구분되는 스레드: 결정 "PostgreSQL 파티셔닝 도입하기로 결정", 장애 "Route53 인증서 만료 장애 ACM 재발급으로 해결", task "수빈이 마이그레이션 스크립트 작성 담당", 절차, 사실).
2. RAG 인덱싱 완료 폴링(chunks 생성).
3. POST /memory/extract → 후보 추출 폴링(≤15s).
4. GET /memory/candidates → 후보 존재, type 분류 확인(decision/incident/task 최소), sourceChunkId 연결.
5. approve 후보 → memory 생성(approved), GET /memories 에 존재, memory_sources 원문 연결.
6. reject 다른 후보 → status rejected.
7. 직접 POST /memories → approved.
8. PATCH memory → memory_versions 기록(수정 반영).
9. supersede → 기존 superseded, 새 기억 current, GET current=true 는 새 것만, asOf 과거는 기존.
10. 원문 연결: memory.sources 로 sourceRefId 역추적.
11. 권한: userB(비소유자) 조회/승인 403.
12. 멱등: extract 재실행 후 candidates 중복 없음.
통과/실패 카운트, 실패 시 exit 1.

## 9. 문서 / 커밋
- ADR: `docs/adr/0013-memory-candidates-and-approval.md`(후보→승인, 원문연결, 현재/과거 supersede, 규칙추출 근거).
- `docs/api/memory.md`: memory API 예시.
- 커밋: `feat(db)` → `feat(rag)` extract → `feat(contracts)` → `feat(worker)` → `feat(memory)` api → `chore(shared)` → `test`/`docs`.

## 10. 파티션 맵
- **P1 database**: memory 4테이블 + enum + subjectHash + self/forward-FK + 추론타입.
- **P2 contracts**: `src/memory.ts` + index 배럴.
- **P3 rag-extract**: `packages/rag/src/extract.ts` + index 갱신 + vitest.
- **P4 worker**: `apps/worker/src/processors/memory-extract.processor.ts`, `processors.module.ts`(등록+queue).
- **P5 api-memory**: `apps/api/src/memory/**`, `packages/shared/src/constants.ts`(MEMORY_EXTRACT), `apps/api/src/app.module.ts`(MemoryModule).
- **P6 verify+docs**: `scripts/verify-phase8.mjs`, ADR 0013, `docs/api/memory.md`.

주의: shared constants/app.module은 **P5만**. worker 파일은 **P4만**. 각 에이전트는 본 스펙 + phase7/6/0 스펙 + 기존 소스(chunks 스키마, slack/retrieval 소유검증 패턴, rag 패키지, worker processors, contracts, shared)를 Read.
