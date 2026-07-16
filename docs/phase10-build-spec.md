# Phase 10 Build Spec — MCP 서버 (마지막 단계)

> Phase 0~9 규약 준수. Phase 10은 `apps/mcp`(현재 자리표시자)에 stdio MCP 서버를 구현해 Claude Code/Cursor에서 개인 메모리·금융 요약을 도구로 노출한다. 도구는 **기존 API를 HTTP 호출**하므로 권한/출처가 API 계층에서 그대로 강제된다(PRD §23/§26).

---

## 0. 목표 & 완료 조건 (PRD §31 Phase 10)

도구: memory_search / memory_read / memory_remember / memory_forget / memory_timeline / finance_summary.

완료 조건(실측, `scripts/verify-phase10.mjs` — MCP 서버 프로세스를 spawn하고 JSON-RPC(stdio)로 검증):
1. Claude Code/Cursor에서 개인 메모리 검색(tools/list에 6도구, memory_search 호출 → 결과).
2. 출처 확인(검색/읽기 결과에 citations/원문 출처 포함).
3. Workspace 권한 적용(로그인 사용자 = 소유자만 접근 — 타 사용자 데이터 미노출).

### 전제
- MCP 서버는 **stdio 트랜스포트**(Claude Code가 `node dist/main.js` 실행). compose 서비스 아님(PRD §7.4).
- 인증: env `FAMILY_API_URL` + `FAMILY_EMAIL` + `FAMILY_PASSWORD`로 로그인 → access token(메모리) + refresh(쿠키 수동 관리), 401 시 refresh 1회. 도구 호출은 기존 API로.
- 새 API/스키마 없음(기존 재사용). `@modelcontextprotocol/sdk` 신규 의존.

---

## 1. 도구 ↔ API 매핑

| MCP 도구 | 인자(zod) | API 호출 | 반환(출처) |
|---|---|---|---|
| `memory_search` | `{ question: string, workspaceId?: string }` | `POST /v1/ai/work-query` | answer + citations(channelName/sourceRefId/occurredAt) |
| `memory_read` | `{ query: string, topK?: number(1-20), workspaceId?: string }` | `POST /v1/ai/retrieval` | items(snippet + citation) |
| `memory_remember` | `{ type: memoryType, subject: string, content: string, workspaceId?: string }` | `POST /v1/memory/memories` | 생성된 memory(id/type/subject) |
| `memory_forget` | `{ memoryId: string }` | `DELETE /v1/memory/memories/:id` | { deleted:true } |
| `memory_timeline` | `{ entityId?: string, workspaceId?: string }` | entityId 있으면 `GET /v1/graph/timeline`, 없으면 `GET /v1/memory/memories?current=true`(최근순) | 시간순 관계/기억 |
| `finance_summary` | `{ month?: string(YYYY-MM), householdId?: string }` | `GET /v1/analytics/monthly` | 순지출/전월대비/기간 메타 |

- `workspaceId` 미지정 시 기본 = env `FAMILY_WORKSPACE_ID` 또는 자동(`GET /v1/slack/workspaces` 첫 것). `householdId` 미지정 시 env `FAMILY_HOUSEHOLD_ID` 또는 자동(`GET /v1/auth/me` memberships 첫 것). 없으면 도구가 명확한 에러 반환.
- 모든 도구 결과는 **출처를 사람이 읽을 수 있는 형태**로 텍스트에 포함(citations 목록: 채널/작성자/시각/스니펫). 권한/근거 없음은 API 응답(refused/403)을 그대로 전달.

---

## 2. `apps/mcp` 구현

### 2.1 패키지 (`apps/mcp/package.json`)
- name `@family/mcp`, private, bin `family-memory-mcp` → `dist/main.js`.
- deps: `@modelcontextprotocol/sdk ^1`, `zod ^3.24`, `@family/contracts`(타입/enum 재사용), `@family/shared`(선택).
- devDeps: `tsup`, `typescript`, `@types/node`.
- scripts: `"build":"tsup"`, `"dev":"tsup --watch"`, `"typecheck":"tsc --noEmit"`, `"lint":"echo noop"`, `"start":"node dist/main.js"`.
- `tsup.config.ts`: entry `src/main.ts`, format `['esm','cjs']`(또는 esm만), `banner: { js: '#!/usr/bin/env node' }`(bin), dts false, clean, sourcemap. **주의: MCP SDK가 ESM이므로 esm 우선**; main.ts는 stdio 서버라 최종 실행 파일. `dist/main.js`(cjs) 또는 `dist/main.mjs`. bin은 `dist/main.js`로 통일(cjs)하거나 `type:module`+mjs. → **cjs 출력(dist/main.js)** 로 두고 SDK를 dynamic import 필요 없으면 정적 import(tsup이 번들). tsconfig는 base extends, module commonjs.
- tsconfig.json: extends ../../tsconfig.base.json, module commonjs, outDir dist.

### 2.2 `src/config.ts`
env 로드(zod): `FAMILY_API_URL`(default http://localhost:3001), `FAMILY_EMAIL`, `FAMILY_PASSWORD`(필수), `FAMILY_WORKSPACE_ID?`, `FAMILY_HOUSEHOLD_ID?`. 검증 실패 시 명확한 에러(값은 로그 금지).

### 2.3 `src/api-client.ts`
- `class FamilyApiClient`:
  - `login()`: `POST /v1/auth/login {email,password}` → accessToken(메모리) + set-cookie(refresh) 저장.
  - `authedFetch<T>(path, {method,body})`: Authorization Bearer + Cookie(refresh) 포함, `credentials` 불필요(Node fetch 수동 Cookie 헤더). 401 → `refresh()`(POST /v1/auth/refresh, Cookie) 1회 재시도 → 실패 시 throw.
  - 도메인 메서드: `workQuery/retrieve/createMemory/deleteMemory/graphTimeline/listMemories/monthly/listWorkspaces/me`.
  - `resolveWorkspaceId(arg?)`: arg ?? env ?? listWorkspaces()[0]. `resolveHouseholdId(arg?)`: arg ?? env ?? me().memberships[0]. 없으면 명확한 Error.
  - Secret(비번/토큰/쿠키) 로그 금지.

### 2.4 `src/tools/*.ts` (6개)
각 도구: zod 입력 스키마 + handler(client 호출 → 결과를 `{ content: [{ type:'text', text }] }`로). 출처는 text에 "출처:" 목록으로 포맷. 에러(refused/403/근거없음)는 사람이 읽는 메시지로 반환(isError 표시 가능).

### 2.5 `src/main.ts`
- `McpServer`(@modelcontextprotocol/sdk) + `StdioServerTransport`.
- 서버 메타(name 'family-memory-ai', version). `registerTool`(또는 setRequestHandler)로 6도구 등록(입력 zod, description 한국어/영문).
- 시작 시 `config` 로드 + `client.login()`(실패 시 stderr 에러 후 종료). stdio 연결.
- stdout은 MCP 프로토콜 전용 — **로그는 stderr로만**(console.error), stdout에 잡음 출력 금지(프로토콜 오염 방지).

### 2.6 `apps/mcp/README.md`
설치/실행(Claude Code `claude mcp add` 예시 + env), 도구 목록, 권한/출처 설명.

---

## 3. Docker / 빌드
- `infrastructure/docker/Dockerfile.dev`: `RUN pnpm -r --filter "./packages/*" build` 뒤에 `&& pnpm --filter @family/mcp build`(또는 별도 RUN) 추가 — 이미지에 `apps/mcp/dist` 포함(검증이 컨테이너에서 실행).
- 새 의존성(@modelcontextprotocol/sdk) → **lockfile 재생성**.
- MCP는 compose 서비스 아님(변경 없음). `.env.example`에 MCP env 주석 블록 추가(FAMILY_EMAIL 등, 실제 실행은 Claude Code가 주입).

## 4. 검증 — `scripts/verify-phase10.mjs`
**api 컨테이너 내부에서 실행**(MCP 서버를 child로 spawn, API는 localhost:3001). 통합자가 `docker compose exec -T -e FAMILY_EMAIL=.. -e FAMILY_PASSWORD=.. api node /app/scripts/verify-phase10.mjs` 로 실행.
1. (사전 시드는 스크립트가 API로 직접 수행) 시드 계정 register + 가족 + 카드/승인문자(finance_summary용) + Slack import + RAG 인덱싱 대기 + memory 후보/승인 or 직접 remember.
2. MCP 서버 spawn: `child_process.spawn('node', ['/app/apps/mcp/dist/main.js'], { env: { FAMILY_API_URL:'http://localhost:3001', FAMILY_EMAIL, FAMILY_PASSWORD, ... }, stdio:['pipe','pipe','pipe'] })`.
3. JSON-RPC over stdio(줄 단위 or Content-Length framing — MCP는 **줄바꿈 구분 JSON-RPC**(newline-delimited)가 아니라 표준 stdio 프레이밍; SDK StdioServerTransport는 개행 구분 JSON 메시지 사용). verify는 각 요청을 `JSON.stringify(msg)+'\n'`로 write, stdout에서 개행 단위 파싱.
   - `initialize` → 서버 capabilities.
   - `notifications/initialized`.
   - `tools/list` → 6개 도구 존재(memory_search/read/remember/forget/timeline, finance_summary).
   - `tools/call` 각 도구:
     - memory_search{question} → content text에 답변 + 출처(refused 아니면).
     - memory_read{query} → snippet + 출처.
     - memory_remember{type,subject,content} → 생성 확인.
     - memory_timeline{} → 최근 기억/시간순.
     - finance_summary{month} → 순지출 요약.
     - memory_forget{memoryId} → 삭제(remember로 만든 것).
4. 출처 확인: search/read 결과 text에 출처(채널/시각) 포함.
5. 권한: (선택) 잘못된 자격/타 워크스페이스는 API가 차단 — MCP 로그인 사용자 스코프만 반환됨을 확인(다른 사용자 시드 데이터 미노출).
6. MCP 서버 종료(kill).
통과/실패 카운트, 실패 시 exit 1. stdout 파싱 견고하게(부분 청크 버퍼링), 타임아웃 가드.

## 5. 문서 / 커밋
- ADR: `docs/adr/0015-mcp-server-over-http-api.md`(MCP가 DB 직접 접근 대신 HTTP API 재사용 → 권한/출처 재사용, stdio 트랜스포트, 인증(로그인+refresh) 근거).
- `docs/api/mcp.md`: 도구 목록/인자/예시 + Claude Code 등록법.
- 커밋: `feat(mcp)` 서버/도구 → `chore(infra)` Dockerfile mcp build + .env → `test`/`docs`.

## 6. 파티션 맵
- **P1 mcp**: `apps/mcp/**`(package.json, tsconfig, tsup.config, src/config, src/api-client, src/tools/*, src/main, README).
- **P2 infra**: `infrastructure/docker/Dockerfile.dev`(mcp build 추가), `.env.example`(MCP env 주석).
- **P3 verify+docs**: `scripts/verify-phase10.mjs`, ADR 0015, `docs/api/mcp.md`.

주의: apps/mcp 외 기존 파일 최소 변경(P2만 Dockerfile/.env). 각 에이전트는 본 스펙 + phase7/8/9 스펙 + 기존 소스(api 엔드포인트: /v1/ai/work-query·retrieval, /v1/memory/memories, /v1/graph/timeline, /v1/analytics/monthly, /v1/auth/login·refresh·me, /v1/slack/workspaces, contracts 스키마, verify-phase* 의 auth/쿠키 패턴)를 Read. @modelcontextprotocol/sdk 최신 API(McpServer/StdioServerTransport/registerTool) 사용법 정확히.
