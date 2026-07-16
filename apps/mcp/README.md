# @family/mcp — Family Memory AI MCP 서버

Family Memory AI의 개인 기억·금융 데이터를 **MCP(Model Context Protocol) 도구**로
노출하는 **stdio 서버**입니다. Claude Code / Cursor 같은 MCP 클라이언트가
`node dist/main.js` 를 실행하면, 아래 6개 도구를 통해 자연어로 기억을 검색·저장하고
금융 요약을 조회할 수 있습니다.

핵심 원칙:

- **DB 직접 접근 없음.** 모든 도구는 기존 Family Memory **HTTP API**를 호출합니다.
  따라서 권한(로그인 사용자 = 소유자만 접근)과 출처(citations)는 **API 계층이 그대로
  강제/제공**합니다. MCP는 권한을 우회하지 않습니다.
- **stdio 전송.** compose 서비스가 아니며, 클라이언트가 프로세스를 직접 띄웁니다.
- **stdout은 MCP 프로토콜 전용.** 모든 로그는 stderr로만 나갑니다.

---

## 빌드

이 패키지는 모노레포의 일부입니다. 루트에서 의존성 설치 후 빌드합니다.

```bash
pnpm install
pnpm --filter @family/mcp build   # tsup → dist/main.js (self-contained CJS)
```

빌드 산출물은 `dist/main.js` 하나이며, shebang(`#!/usr/bin/env node`)이 포함되어
`bin` 이름 `family-memory-mcp` 로도 실행할 수 있습니다.

---

## 환경변수

클라이언트(예: Claude Code)가 서버를 실행할 때 아래 env 를 주입합니다.

| 변수 | 필수 | 설명 |
|---|---|---|
| `FAMILY_API_URL` | 아니오 | API 베이스 URL (기본 `http://localhost:3001`) |
| `FAMILY_EMAIL` | **예** | 로그인 이메일 |
| `FAMILY_PASSWORD` | **예** | 로그인 비밀번호 |
| `FAMILY_WORKSPACE_ID` | 아니오 | 기본 워크스페이스 id(`workspaces.id`). 생략 시 `GET /v1/slack/workspaces` 의 첫 워크스페이스 자동 사용 |
| `FAMILY_HOUSEHOLD_ID` | 아니오 | 기본 가구 id. 생략 시 `GET /v1/auth/me` 의 첫 membership 자동 사용 |

> 비밀번호/토큰/쿠키는 어떤 로그에도 출력되지 않습니다. `FAMILY_EMAIL` / `FAMILY_PASSWORD`
> 는 커밋하지 마세요.

인증 흐름: 시작 시 `POST /v1/auth/login` 으로 access token(메모리) + refresh 쿠키(수동
관리)를 얻고, 이후 도구 호출은 `Authorization: Bearer` 로 수행합니다. 401 이 발생하면
`POST /v1/auth/refresh` 로 1회 갱신 후 재시도합니다.

---

## Claude Code 등록

빌드된 절대경로를 사용하는 것을 권장합니다.

```bash
claude mcp add family-memory-ai \
  --env FAMILY_API_URL=http://localhost:3001 \
  --env FAMILY_EMAIL=you@example.com \
  --env FAMILY_PASSWORD='********' \
  --env FAMILY_WORKSPACE_ID=<workspaces.id, 선택> \
  --env FAMILY_HOUSEHOLD_ID=<household id, 선택> \
  -- node /absolute/path/to/apps/mcp/dist/main.js
```

또는 클라이언트 설정 파일(JSON)에 직접 등록:

```json
{
  "mcpServers": {
    "family-memory-ai": {
      "command": "node",
      "args": ["/absolute/path/to/apps/mcp/dist/main.js"],
      "env": {
        "FAMILY_API_URL": "http://localhost:3001",
        "FAMILY_EMAIL": "you@example.com",
        "FAMILY_PASSWORD": "********"
      }
    }
  }
}
```

---

## 도구

| 도구 | 인자 | 호출 API | 반환 |
|---|---|---|---|
| `memory_search` | `question`, `workspaceId?` | `POST /v1/ai/work-query` | 근거 기반 답변 + 출처(채널/시각/스니펫). 근거 없으면 사유 반환 |
| `memory_read` | `query`, `topK?`(1-20), `workspaceId?` | `POST /v1/ai/retrieval` | 관련도순 원문 스니펫 + 출처 |
| `memory_remember` | `type`, `subject`, `content`, `workspaceId?` | `POST /v1/memory/memories` | 생성된 기억 id/type/subject |
| `memory_forget` | `memoryId` | `DELETE /v1/memory/memories/:id` | 삭제 확인 |
| `memory_timeline` | `entityId?`, `workspaceId?` | entityId 있으면 `GET /v1/graph/timeline`, 없으면 `GET /v1/memory/memories?current=true` | 관계 이력(시간순) 또는 최근 기억(최신순) |
| `finance_summary` | `month?`(YYYY-MM), `householdId?` | `GET /v1/analytics/monthly` | 순지출 / 전월 대비 증감 / 기간 메타 |

`type`(memory_remember)은 `@family/contracts` 의 열거형입니다:
`event` · `fact` · `decision` · `preference` · `procedure` · `incident` · `task`.

---

## 권한과 출처

- **권한:** 로그인한 사용자가 **소유한 데이터만** 조회/변경할 수 있습니다. 타 사용자의
  데이터는 API가 403 으로 차단하며, MCP 도구는 이를 사람이 읽을 수 있는 메시지로
  전달합니다. MCP는 권한 경계를 만들거나 우회하지 않고, API의 결정을 그대로 노출합니다.
- **출처(citations):** `memory_search` / `memory_read` 결과 텍스트에는 항상 "출처:" 블록이
  포함됩니다(채널명, Asia/Seoul 시각, 원문 참조 id, 스니펫). 근거가 없으면 답변 대신
  사유를 반환합니다.
