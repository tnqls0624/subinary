# Phase 6 Build Spec — Slack Import

> Phase 6 = 개인화 AI 영역 시작(업무 기록 수집). Phase 0~5 규약 준수(패키지 `type:module` 금지, 공용 dev 이미지, 소스 바인드마운트, Asia/Seoul, 로그 Secret/PII 금지, 새 env는 `.env`도 갱신, 새 npm 의존성 시 lockfile 재생성, 교차모듈 `@UseGuards`는 가드 의존성까지 export, drizzle `GROUP BY`는 ordinal 사용).

---

## 0. 목표 & 완료 조건 (PRD §31 Phase 6)

범위: Slack Export 업로드 / 채널·사용자 정규화 / 메시지 저장 / 스레드 복원 / 내 메시지 필터 / 키워드 검색.

완료 조건(실측, `scripts/verify-phase6.mjs`):
1. Slack Export를 **중복 없이** Import(재업로드 멱등).
2. 스레드 순서 복원(부모 + 답글 ts 순).
3. 채널·날짜 검색 + 키워드 검색.
4. 원문 출처 표시(채널/작성자/ts/(가능하면)permalink).

### 경계 (하지 않음)
- 실시간 Slack App/OAuth → 후순위(PRD MVP 제외). Phase 6은 Export 업로드만.
- Task/Decision/Incident 추출(§18) → Phase 8(장기기억). Phase 6은 원문·스레드·검색까지.
- Secret 탐지 마스킹(§26) → 최소(파서가 명백한 토큰 패턴만 warning, 저장은 함). 본격 탐지 후순위.
- RAG/임베딩 → Phase 7.

---

## 1. 핵심 설계 결정

### 1.1 업로드 = JSON 번들 multipart (ZIP 아님)
PRD §18 "Slack Export JSON 업로드". Slack export ZIP을 클라이언트가 풀어 하나의 JSON 번들로 업로드한다고 가정. 서버는 `@fastify/multipart`로 파일 수신 → MinIO 원문 저장 → BullMQ 파싱. ZIP 해제 라이브러리 불필요.
- 번들 형식:
  ```json
  {
    "workspace": { "name": "회사 슬랙", "slackTeamId": "T123" },
    "channels": [{ "id": "C1", "name": "eng-backend" }],
    "users": [{ "id": "U1", "name": "soobeen", "real_name": "수빈" }],
    "messages": [
      { "channel": "C1", "ts": "1721040600.000100", "user": "U1",
        "text": "...", "thread_ts": "1721040600.000100", "edited_ts": null }
    ]
  }
  ```
- multipart fields: 파일 `file`(번들 JSON), + `mySlackUserId`(옵션, 내 메시지 필터용), `workspaceName`(옵션 override), `kind`(옵션, 기본 'company').

### 1.2 Workspace 분리 (PRD §3.6/§26)
`workspaces`(개인 데이터 컨테이너, `ownerUserId`+`kind`) 도입. Slack 데이터는 소유 workspace를 통해 **소유자 본인만** 조회(다른 사용자·가족 구성원도 접근 불가). 향후 Phase 8 `personal_events`가 `workspaceId`로 연결.

### 1.3 멱등 Import
- `slack_messages` UNIQUE(slackChannelId, ts) → 재import `onConflictDoNothing`. channels/users는 `onConflictDoUpdate`(이름 갱신). 스레드는 재계산 upsert.
- import 단위로 `source_items`(kind='slack') 1건 + MinIO 번들 저장. 재업로드는 새 source_item이지만 메시지는 중복 저장 안 됨.

### 1.4 스레드 복원
Slack `ts`="epoch.micro" 문자열. `thread_ts===ts`(또는 thread_ts 없음)면 루트, 아니면 답글. `slack_threads`(slackChannelId, threadTs) upsert: rootTs, replyCount, lastReplyAt. 스레드 조회는 threadTs로 메시지를 ts 오름차순(문자열은 zero-pad 아니므로 숫자 비교) 정렬.

### 1.5 키워드 검색
`pg_trgm`(Phase 0 확장 설치됨) + `slack_messages.text ILIKE '%q%'` + GIN(text gin_trgm_ops) 인덱스. 한국어 안전. 채널/날짜(occurredAt)/mine 필터 결합. 본격 FTS/벡터는 Phase 7.

---

## 2. 데이터 모델 — `packages/database` (schema.ts 확장)

### pgEnum
- `workspaceKindEnum` = `['personal','company']`

### 테이블
```
workspaces
  id uuid pk
  ownerUserId uuid not null -> users.id
  kind workspaceKindEnum not null
  name text not null
  createdAt / updatedAt
  INDEX(ownerUserId)

slack_workspaces
  id uuid pk
  workspaceId uuid not null -> workspaces.id   -- UNIQUE
  slackTeamId text null
  name text not null
  mySlackUserId text null                       -- 내 메시지 필터
  lastImportedAt timestamptz null
  createdAt / updatedAt
  UNIQUE(workspaceId)

slack_channels
  id uuid pk
  slackWorkspaceId uuid not null -> slack_workspaces.id
  slackChannelId text not null
  name text not null
  createdAt / updatedAt
  UNIQUE(slackWorkspaceId, slackChannelId)

slack_users
  id uuid pk
  slackWorkspaceId uuid not null -> slack_workspaces.id
  slackUserId text not null
  name text not null
  realName text null
  createdAt / updatedAt
  UNIQUE(slackWorkspaceId, slackUserId)

slack_messages
  id uuid pk
  slackWorkspaceId uuid not null -> slack_workspaces.id
  slackChannelId uuid not null -> slack_channels.id
  slackUserId text null                          -- Slack user id 문자열(정규화는 slack_users)
  ts text not null                               -- "epoch.micro"
  threadTs text null
  text text not null
  editedTs text null
  occurredAt timestamptz not null                -- ts → Date
  sourceItemId uuid null -> source_items.id
  createdAt
  UNIQUE(slackChannelId, ts)
  INDEX(slackWorkspaceId), INDEX(slackChannelId), INDEX(threadTs), INDEX(occurredAt)
  GIN index on text (gin_trgm_ops)               -- 키워드 검색

slack_threads
  id uuid pk
  slackWorkspaceId uuid not null -> slack_workspaces.id
  slackChannelId uuid not null -> slack_channels.id
  threadTs text not null
  rootTs text not null
  replyCount integer not null default 0
  lastReplyAt timestamptz null
  createdAt / updatedAt
  UNIQUE(slackChannelId, threadTs)
```

추론 타입 export(Workspace/…, SlackWorkspace/…, SlackChannel/…, SlackUser/…, SlackMessage/…, SlackThread/…). 마이그레이션 0005는 통합에서 generate. GIN trgm 인덱스는 drizzle `index().using('gin', sql\`... gin_trgm_ops\`)` 또는 마이그레이션 SQL 수동 보강(generate 후 확인).

---

## 3. `@family/slack-parser` 패키지 (신규, 순수)
`packages/slack-parser/`. Phase 0 공통 형태(tsup, `type:module` 없음, sideEffects:false, vitest). deps 없음(순수 TS). 
### 타입 (`src/types.ts`)
```ts
interface SlackExportBundle { workspace:{name?:string; slackTeamId?:string}; channels:RawChannel[]; users:RawUser[]; messages:RawMessage[]; }
interface RawChannel { id:string; name:string }
interface RawUser { id:string; name:string; real_name?:string }
interface RawMessage { channel:string; ts:string; user?:string; text?:string; thread_ts?:string; edited_ts?:string|null }
interface NormalizedMessage { slackChannelId:string; slackUserId:string|null; ts:string; threadTs:string|null; text:string; editedTs:string|null; occurredAt:Date }
interface NormalizedThread { slackChannelId:string; threadTs:string; rootTs:string; replyCount:number; lastReplyAt:Date|null }
interface ParsedSlackExport { workspace:{...}; channels:{slackChannelId,name}[]; users:{slackUserId,name,realName}[]; messages:NormalizedMessage[]; threads:NormalizedThread[]; warnings:string[]; }
```
### 함수 (`src/parse.ts`)
- `parseSlackExport(bundle: unknown): ParsedSlackExport` — 구조 검증(형식 오류 throw), 채널/유저 정규화, 메시지 정규화(text 없으면 skip/빈 문자열, ts→occurredAt=`new Date(Number(ts.split('.')[0])*1000)`), 스레드 그룹핑(threadTs로 그룹, root=최소 ts, replyCount=그룹 크기-1, lastReplyAt=최대 occurredAt). channel id가 channels에 없으면 warning + skip. 명백한 secret 패턴(예: `xoxb-`, `AKIA`, `-----BEGIN`)이 text에 있으면 warning(저장은 유지 — MVP).
- `tsToDate(ts): Date` 헬퍼. `compareTs(a,b): number`(숫자 비교) export.
- `index.ts` 배럴.
### 테스트 (`src/*.test.ts`)
vitest ≥8케이스: 정규화, 스레드 그룹핑(부모+답글 replyCount/lastReplyAt), 누락 채널 skip, ts→occurredAt, 빈 export, secret warning.

---

## 4. API 계약 — `packages/contracts` (`src/slack.ts` + 배럴)
- `slackImportResponseSchema` = `{ importId: string, slackWorkspaceId: string, status: z.enum(['queued']), }`
- `slackWorkspaceSummarySchema` = `{ id, workspaceId, name, slackTeamId: nullable, mySlackUserId: nullable, channelCount: int, userCount: int, messageCount: int, lastImportedAt: string.nullable() }`
- `slackMessageSummarySchema` = `{ id, slackChannelId, channelName, slackUserId: nullable, authorName: nullable, ts, threadTs: nullable, text, editedTs: nullable, occurredAt: string, isMine: boolean, permalinkHint: string.nullable() }`
- `slackMessageListResponseSchema` = `{ items: slackMessageSummary[], nextCursor: string.nullable() }`
- `slackThreadResponseSchema` = `{ threadTs, channelName, replyCount: int, messages: slackMessageSummary[] }`
- 추론 타입 export.
(`permalinkHint`은 `slack://` 또는 `#channel@ts` 형태의 출처 힌트 문자열 — 실제 permalink는 export에 없으므로 채널명+ts 조합.)

---

## 5. apps/api 구현 (`apps/api/src/slack/`)
### 5.1 의존성/배선
- `apps/api/package.json`: `@fastify/multipart ^9` 추가.
- `main.ts`: `await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } })`(cookie 등록 부근). rawBody/bodyLimit(16KB) 유지 — multipart는 별도 처리.
- `packages/shared/src/constants.ts`: `QUEUE_NAMES.SLACK_IMPORT = 'slack-import'`.
- `app.module.ts`: SlackModule import.

### 5.2 slack.service
- `workspace.service` 또는 slack.service 내: `ensureWorkspace(userId, {name, kind})` — workspaces(ownerUserId=userId) + slack_workspaces upsert. 소유자 검증 헬퍼 `requireOwnedSlackWorkspace(userId, slackWorkspaceId)`(ownerUserId!=userId → Forbidden).
- `import(userId, file: Buffer, fields)`:
  1. 번들 JSON 파싱(`JSON.parse`, 실패 시 BadRequest). (전체 구조 검증은 worker의 parseSlackExport에서, 여기선 최소.)
  2. workspaces + slack_workspaces upsert(name = fields.workspaceName ?? bundle.workspace.name ?? 'Slack', kind = fields.kind ?? 'company', mySlackUserId = fields.mySlackUserId ?? 기존 유지).
  3. source_items insert(kind='slack', objectKey `slack/{workspaceId}/{sourceItemId or uuid}.json`, contentHash sha256, receivedAt now) + MinIO putObject(번들).
  4. BullMQ `SLACK_IMPORT` enqueue { sourceItemId, slackWorkspaceId }.
  5. 응답 { importId: sourceItemId, slackWorkspaceId, status:'queued' }.
- `listWorkspaces(userId)`, `getWorkspace(userId, id)`(count 집계 SQL).
- `searchMessages(userId, {slackWorkspaceId, channelId?, from?, to?, q?, mine?, limit, cursor})`: 소유 검증 → slack_messages 조인(channel name, user name) + ILIKE(q) + occurredAt 범위 + mine(slackUserId=workspace.mySlackUserId) 필터. isMine 계산. keyset 페이지네이션(occurredAt desc, id).
- `getThread(userId, slackWorkspaceId, channelId, threadTs)`: 소유 검증 → 해당 스레드 메시지 ts 오름차순.
### 5.3 컨트롤러 (`@Controller('slack')`, 일반 인증)
- `POST /v1/slack/import` — multipart. Fastify req에서 파일 파싱(`req.file()` 또는 parts). `@Req()` FastifyRequest 사용(multipart는 DTO 파이프 우회, 수동 파싱). fields + file buffer → service.import.
- `GET /v1/slack/workspaces`, `GET /v1/slack/workspaces/:id`.
- `GET /v1/slack/messages?slackWorkspaceId=&channelId=&from=&to=&q=&mine=&limit=&cursor=`.
- `GET /v1/slack/threads?slackWorkspaceId=&channelId=&threadTs=` (또는 `/threads/:threadTs` + query workspaceId/channelId).
- CurrentUser로 actorUserId. 소유자 아닌 조회 403.
### 5.4 slack.module
`imports: [StorageModule, BullModule.registerQueue({name:QUEUE_NAMES.SLACK_IMPORT})]`, providers/controllers.

---

## 6. apps/worker (`apps/worker/src/processors/slack-import.processor.ts`)
- `apps/worker/package.json`: `@family/slack-parser: workspace:*` 추가. (StorageModule 필요 → worker에 ObjectStorage 접근: worker는 현재 storage 모듈 없음. **번들을 MinIO에서 읽으려면 worker에 S3 클라이언트 필요.** → worker에 경량 storage provider 추가 or api가 번들을 DB/큐 payload로 전달.)
  - **결정**: MinIO 왕복을 피해 **enqueue payload에 번들을 직접 넣지 않고**(크기), worker에 `@aws-sdk/client-s3` + 간단 storage 서비스 추가. worker package.json에 `@aws-sdk/client-s3` 추가, `apps/worker/src/storage/`(object-storage 경량, config.storage). config.storage는 이미 존재.
- `slack-import.processor.ts`: `@Processor(SLACK_IMPORT)`. process: source_items 조회 → MinIO getObject(objectKey) → JSON.parse → `parseSlackExport` → 트랜잭션으로 slack_channels/users upsert(onConflictDoUpdate), slack_messages onConflictDoNothing(sourceItemId 연결), slack_threads upsert. slack_workspaces.lastImportedAt 갱신. 로그는 count만(원문·PII 미기록).
- `processors.module.ts`: SlackImportProcessor + registerQueue + storage provider.

---

## 7. Docker / 마이그레이션
- 새 의존성: api `@fastify/multipart`, worker `@family/slack-parser`+`@aws-sdk/client-s3`, 신규 패키지 slack-parser(vitest). lockfile 재생성.
- 새 테이블 → generate 0005. GIN trgm 인덱스가 generate에 포함되는지 확인, 누락 시 마이그레이션 SQL에 `CREATE INDEX ... USING gin (text gin_trgm_ops)` 수동 추가.
- 통합: lockfile → build → slack-parser vitest → generate 0005(+GIN 확인) → up --force-recreate → verify-phase6.

---

## 8. 검증 — `scripts/verify-phase6.mjs` (Node fetch + FormData/Blob, 호스트 실행)
1. userA 회원가입.
2. Slack export 번들 JSON 생성(채널 2, 유저 2, 메시지: 스레드 루트+답글 2개, 일반 메시지 몇 개, 다른 유저 메시지, secret 포함 1개).
3. multipart 업로드(FormData, file=Blob(JSON), mySlackUserId=U1) → 200 { importId, slackWorkspaceId, status:queued }.
4. 폴링(≤10s): GET workspaces/:id → messageCount>0, channelCount=2, userCount=2.
5. **멱등**: 동일 번들 재업로드 → messageCount 증가 없음.
6. **스레드 복원**: GET threads(threadTs) → 메시지 ts 오름차순, replyCount 정확, 루트+답글 포함.
7. **키워드 검색**: q=특정단어 → 해당 메시지만. 채널 필터. 날짜(from/to) 필터.
8. **mine 필터**: mine=true → mySlackUserId 메시지만, isMine=true.
9. **출처**: 각 메시지에 channelName/authorName/ts/permalinkHint.
10. **접근제어**: userB(비소유자)가 userA workspace 조회 → 403.
통과/실패 카운트, 실패 시 exit 1.

---

## 9. 문서 / 커밋
- ADR: `docs/adr/0011-slack-import-json-bundle.md`(JSON 번들 업로드/workspace 분리/멱등/스레드 복원/trgm 검색 근거).
- `docs/api/slack.md`: import/messages/threads API + 번들 형식 예시.
- 커밋(PRD §38): `feat(db)` slack → `feat(contracts)` → `feat(slack-parser)` → `feat(slack)` api → `feat(worker)` slack-import → `chore(shared/api)` 배선 → `test`/`docs`.

## 10. 파티션 맵
- **P1 database**: schema.ts에 workspaces + slack 5테이블 + enum + 추론타입 + GIN trgm(가능 시).
- **P2 contracts**: `src/slack.ts` + index 배럴.
- **P3 slack-parser**: `packages/slack-parser/**`(types, parse, index, vitest).
- **P4 api-slack**: `apps/api/src/slack/**`, `apps/api/package.json`(@fastify/multipart), `apps/api/src/main.ts`(multipart 등록), `packages/shared/src/constants.ts`(SLACK_IMPORT), `apps/api/src/app.module.ts`(SlackModule).
- **P5 worker-slack**: `apps/worker/src/processors/slack-import.processor.ts`, `apps/worker/src/storage/**`(경량 object-storage), `apps/worker/src/processors/processors.module.ts`(등록+queue+storage), `apps/worker/package.json`(@family/slack-parser + @aws-sdk/client-s3).
- **P6 verify+docs**: `scripts/verify-phase6.mjs`, ADR 0011, `docs/api/slack.md`.

주의: main.ts/app.module/api package.json/shared constants는 **P4만**. worker 파일은 **P5만**. 각 에이전트는 본 스펙 + phase5/3/0 스펙 + 기존 소스(card-sms ingest[멱등/source_items/MinIO], storage 모듈, worker processors, database schema, contracts, shared constants)를 Read.
