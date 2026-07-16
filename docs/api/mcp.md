# MCP 서버 명세 (Model Context Protocol)

> Phase 10 기준. MCP 서버(`apps/mcp`)는 Claude Code/Cursor 등 MCP 호환 클라이언트에 개인 메모리·
> 금융 요약을 **도구(tool)** 로 노출한다. 모든 도구는 **기존 REST API(`/v1/*`)를 HTTP 로 호출**하므로
> 권한(소유자 전용, PRD §26)과 출처(citations)는 API 계층에서 그대로 강제된다. 계약 스키마의 단일
> 소스는 `@family/contracts` 이며, 본 문서는 도구 시그니처·예시·등록법을 설명한다.
>
> 관련 설계: [ADR-0015 MCP over HTTP API](../adr/0015-mcp-server-over-http-api.md) ·
> [Phase 10 빌드 스펙](../phase10-build-spec.md) ·
> [AI/RAG API](ai.md) · [장기 기억 API](memory.md) · [GraphRAG API](graph.md) ·
> [분석·예산 API](analytics-budgets.md) · [인증·가족 API](auth-household.md)

## 개요

- **전송(transport)**: stdio. 클라이언트가 `node dist/main.js` 를 spawn 하고 stdin/stdout 으로
  JSON-RPC(개행 구분 메시지)를 주고받는다. compose 서비스가 아니다(PRD §7.4).
- **인증**: 시작 시 env `FAMILY_EMAIL` + `FAMILY_PASSWORD` 로 `POST /v1/auth/login` → access token
  (메모리) + refresh(쿠키 수동 관리). 401 시 `POST /v1/auth/refresh` 로 1회 재발급 후 재시도.
- **권한(PRD §26)**: 도구는 **로그인 사용자 = 소유자 본인** 데이터만 다룬다. 타 사용자의 workspace/
  가족을 지정하면 API 가 403 을 반환하고, MCP 는 이를 사람이 읽는 오류 메시지로 전달한다(데이터 유출 0).
- **출처(citations)**: 검색/읽기 도구 결과 텍스트에 **채널명 · 작성 시각 · 스니펫** 등 원문 출처가
  `출처:` 목록으로 포함된다. 근거가 없으면(refused) API 응답 그대로 "근거를 찾지 못했습니다" 를 전달한다.
- **stdout/stderr**: stdout 은 MCP 프로토콜 전용이다. 서버 로그는 stderr 로만 나가며 토큰/쿠키/
  비밀번호/원문/PII 를 남기지 않는다(PRD §11).

### 환경변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `FAMILY_API_URL` | 아니오 | API base URL. 기본 `http://localhost:3001`. |
| `FAMILY_EMAIL` | 예 | 로그인 이메일(도구가 대신 접근할 사용자 = 소유자). |
| `FAMILY_PASSWORD` | 예 | 로그인 비밀번호. **로그에 남지 않는다.** |
| `FAMILY_WORKSPACE_ID` | 아니오 | 기본 workspace(`workspaces.id`). 미지정 시 `GET /v1/slack/workspaces` 첫 항목. |
| `FAMILY_HOUSEHOLD_ID` | 아니오 | 기본 가족(`households.id`). 미지정 시 `GET /v1/auth/me` memberships 첫 항목. |

> `workspaceId` 는 개인 데이터 컨테이너 **`workspaces.id`** 다(Slack import 응답의 `slackWorkspaceId`
> = `slack_workspaces.id` 가 **아니다**). `GET /v1/slack/workspaces/:id` 응답의 `workspaceId`
> 필드에서 얻는다(RAG/memory/graph 스코프와 동일).

## 도구 목록

| 도구 | 인자 | API 매핑 | 반환 |
|---|---|---|---|
| `memory_search` | `question`, `workspaceId?` | `POST /v1/ai/work-query` | 근거 기반 답변 + 출처(citations) |
| `memory_read` | `query`, `topK?`, `workspaceId?` | `POST /v1/ai/retrieval` | 랭킹된 스니펫 + 출처 |
| `memory_remember` | `type`, `subject`, `content`, `workspaceId?` | `POST /v1/memory/memories` | 생성된 기억(id/type/subject) |
| `memory_forget` | `memoryId` | `DELETE /v1/memory/memories/:id` | 삭제 확인(`{ deleted: true }`) |
| `memory_timeline` | `entityId?`, `workspaceId?` | entityId 有 `GET /v1/graph/timeline` · 無 `GET /v1/memory/memories?current=true` | 시간순 관계/기억 |
| `finance_summary` | `month?`, `householdId?` | `GET /v1/analytics/monthly` | 순지출 · 전월대비 · 기간 메타 |

### 인자 상세(zod 입력 스키마)

- **`memory_search`** — `{ question: string, workspaceId?: string }`
  - `question`: 자연어 질의(1~1000자). Slack 업무 기록 위에서 근거를 찾아 답한다.
- **`memory_read`** — `{ query: string, topK?: number(1–20, 기본 5), workspaceId?: string }`
  - 답변 생성 없이 하이브리드(FTS+벡터) 검색 결과를 스니펫으로 반환(디버그/근거 확인용).
- **`memory_remember`** — `{ type: MemoryType, subject: string, content: string, workspaceId?: string }`
  - `type` ∈ `event | fact | decision | preference | procedure | incident | task`.
  - "이거 기억해둬" 를 명시적으로 저장(`status='approved'`, `sourceType='manual'`).
- **`memory_forget`** — `{ memoryId: string }`
  - 기억을 soft-delete 한다(목록에서 제외). 소유자 본인 기억만 삭제 가능.
- **`memory_timeline`** — `{ entityId?: string, workspaceId?: string }`
  - `entityId` 지정 시 그래프 타임라인(관계 형성/변경, `validFrom` 오름차순).
  - 미지정 시 현재 유효한 기억 목록(최근순).
- **`finance_summary`** — `{ month?: string(YYYY-MM), householdId?: string }`
  - `month` 미지정 시 현재 Asia/Seoul 달. 순지출(`totalNet`) · 전월대비(`deltaNet`/`deltaRate`) ·
    기간 메타를 KRW 정수로 반환.

## 예시

### tools/list (JSON-RPC over stdio)

요청:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }
```

응답(발췌):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      { "name": "memory_search", "description": "…", "inputSchema": { "type": "object", "properties": { "question": { "type": "string" } }, "required": ["question"] } },
      { "name": "finance_summary", "description": "…", "inputSchema": { "type": "object", "properties": { "month": { "type": "string" } } } }
    ]
  }
}
```

### memory_search — 근거 기반 검색 + 출처

요청:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "memory_search",
    "arguments": { "question": "PostgreSQL 파티셔닝과 Redis 캐시 도입은 어떻게 결정됐나요?" }
  }
}
```

응답(사람이 읽는 텍스트 — 답변 + 출처):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "PostgreSQL 월 단위 range 파티셔닝을 Redis 캐시와 함께 도입하기로 결정했습니다.\n\n출처:\n- [eng-log] 2024-07-19 14:43 — \"PostgreSQL 파티셔닝을 Redis 캐시와 함께 도입하기로 결정…\"\n- [eng-log] 2024-07-19 14:44 — \"월 단위 range 파티셔닝으로 진행하기로 정리…\""
      }
    ]
  }
}
```

> 근거가 없으면 `text` 는 "근거를 찾지 못했습니다"(refused)를 담고 출처는 비어 있다. 권한이 없는
> workspace 를 지정하면 API 403 이 사람이 읽는 오류 메시지로 전달되며 원문은 노출되지 않는다.

### finance_summary — 이번 달 순지출

요청:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": { "name": "finance_summary", "arguments": { "month": "2026-07" } }
}
```

응답(발췌):

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [
      { "type": "text", "text": "2026-07 순지출: 80,000원 (전월 대비 +80,000원). 기간: 2026-07-01 ~ 2026-08-01 (Asia/Seoul)." }
    ]
  }
}
```

### memory_remember / memory_forget

```json
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
  "params": { "name": "memory_remember",
    "arguments": { "type": "decision", "subject": "여름 휴가", "content": "가족 여행을 8월로 확정" } } }
```

```json
{ "jsonrpc": "2.0", "id": 6, "method": "tools/call",
  "params": { "name": "memory_forget", "arguments": { "memoryId": "<생성된 기억 id>" } } }
```

## Claude Code 등록법

먼저 서버를 빌드한다(모노레포 루트에서):

```bash
pnpm --filter @family/mcp build   # dist/main.js 생성
```

Claude Code CLI 로 stdio MCP 서버를 등록한다. 자격/URL 은 `--env` 로 주입한다:

```bash
claude mcp add family-memory \
  --env FAMILY_API_URL=http://localhost:3001 \
  --env FAMILY_EMAIL=you@example.com \
  --env FAMILY_PASSWORD='<password>' \
  -- node /absolute/path/to/apps/mcp/dist/main.js
```

또는 클라이언트 설정 파일(`.mcp.json` / `claude_desktop_config.json`)에 직접 추가:

```json
{
  "mcpServers": {
    "family-memory": {
      "command": "node",
      "args": ["/absolute/path/to/apps/mcp/dist/main.js"],
      "env": {
        "FAMILY_API_URL": "http://localhost:3001",
        "FAMILY_EMAIL": "you@example.com",
        "FAMILY_PASSWORD": "<password>"
      }
    }
  }
}
```

등록 후 클라이언트에서 도구가 노출되는지 확인한다:

```bash
claude mcp list          # family-memory 가 목록에 보이면 OK
```

> - `command` 는 실행 파일(`node`), `args` 는 빌드 산출물 절대경로다. 전역 설치(bin `family-memory-mcp`)
>   시에는 `command` 를 `family-memory-mcp` 로 두고 `args` 를 생략할 수 있다.
> - 자격 정보(비밀번호)는 클라이언트 설정에 평문으로 저장된다(로컬 사용자 스코프). 서버는 이를 로그로
>   노출하지 않는다. 원격 공유가 필요하면 트랜스포트/인증 방식을 재검토한다(ADR-0015 참고).
> - API(`FAMILY_API_URL`)가 먼저 기동돼 있어야 한다. 서버는 시작 시 login 하고 실패하면 stderr 에
>   오류를 남기고 종료한다.

## 검증

`scripts/verify-phase10.mjs` 가 **api 컨테이너 내부**에서 MCP 서버를 child 로 spawn 해 stdio
JSON-RPC 로 완료 조건을 실측한다(시드 → initialize → tools/list(6개) → tools/call 각 도구 →
출처/권한 스코프 확인 → 종료):

```bash
docker compose exec -T api node /app/scripts/verify-phase10.mjs
```
