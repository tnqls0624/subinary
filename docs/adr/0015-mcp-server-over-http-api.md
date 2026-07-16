# ADR-0015: MCP 서버 — 기존 HTTP API 재사용 · stdio 트랜스포트 · login+refresh 인증 · DB 직접접근 대비 트레이드오프

## 제목

Family Memory AI 의 MCP(Model Context Protocol) 서버(`apps/mcp`)를 **DB/서비스 계층에 직접
접근하지 않고 기존 REST API(`/v1/*`)를 HTTP 로 호출**하는 얇은 도구 계층으로 구현하고,
전송은 **stdio 트랜스포트**(Claude Code/Cursor 가 `node dist/main.js` 를 실행), 인증은
**env 자격으로 login → access token(메모리) + refresh(쿠키 수동) → 401 시 refresh 1회**로
처리하며, 6개 도구(memory_search / memory_read / memory_remember / memory_forget /
memory_timeline / finance_summary)를 노출하는 설계 채택(PRD §37/§23/§26, Phase 10).

## 상태

승인됨 (Accepted) — 2026-07-16

## 배경

Phase 10 은 개인화 AI 의 **외부 노출 계층**이다(PRD §31 Phase 10). Phase 6~9 로 적재·구조화한
개인 데이터(Slack RAG chunks, 장기 기억, Temporal Graph, 카드 지출)를 Claude Code/Cursor 같은
**MCP 호환 클라이언트**가 도구로 호출해 "우리 팀은 무엇을 왜 결정했나", "이번 달 순지출은",
"이거 기억해둬" 같은 작업을 수행할 수 있어야 한다. 완료 조건(PRD §31 Phase 10)은 다음과 같다.

- **개인 메모리 검색**: 클라이언트의 tools/list 에 도구가 노출되고, 자연어 질의로 결과를 받는다.
- **출처(citation)**: 검색/읽기 결과에 채널/작성 시각/스니펫 등 **원문 출처**가 포함된다.
- **접근제어(PRD §26)**: 로그인 사용자 = 소유자 본인 데이터만 반환. 타 사용자 데이터 유출 0.

핵심 설계 질문은 네 가지다. (1) MCP 도구는 **데이터에 어떻게 접근**하는가(DB/서비스 직접 vs
HTTP API 재사용), (2) **전송(transport)** 은 무엇인가, (3) **인증/권한**을 어디서 강제하는가,
(4) 서버 프로세스가 **stdout/stderr** 를 어떻게 다루는가.

## 결정

### 1. 데이터 접근 = 기존 HTTP API 재사용(DB/서비스 직접접근 금지)

- MCP 도구는 `@family/database` 나 API 내부 서비스(NestJS provider)를 **직접 호출하지 않는다**.
  대신 이미 운영 중인 REST API 를 HTTP 로 호출한다(도구↔API 매핑은 Phase 10 스펙 §1, 아래 요약).

  | MCP 도구 | API 호출 | 반환(출처) |
  |---|---|---|
  | `memory_search` | `POST /v1/ai/work-query` | answer + citations(channelName/sourceRefId/occurredAt) |
  | `memory_read` | `POST /v1/ai/retrieval` | items(snippet + citation) |
  | `memory_remember` | `POST /v1/memory/memories` | 생성 memory(id/type/subject) |
  | `memory_forget` | `DELETE /v1/memory/memories/:id` | { deleted:true } |
  | `memory_timeline` | entityId 有 `GET /v1/graph/timeline` · 無 `GET /v1/memory/memories?current=true` | 시간순 관계/기억 |
  | `finance_summary` | `GET /v1/analytics/monthly` | 순지출/전월대비/기간 메타 |

- **근거(PRD §23/§26)**: API 계층은 이미 **소유자 전용 접근제어**(`workspaces.ownerUserId == 요청자`
  → 비소유자 403, PRD §26)와 **출처(citation) 조립**(work-query/retrieval 응답의 citations)을
  구현하고 검증(verify-phase7/8/9)을 통과했다. MCP 가 이 API 를 재사용하면 **권한·출처 로직을
  중복 구현하지 않고 그대로 상속**한다. 도구는 응답을 사람이 읽는 텍스트로 포매팅할 뿐, 권한 판단이나
  근거 판단(evidence sufficiency, refused 여부)을 **다시 하지 않는다** — 판단의 단일 소스는 API 다.
- 새 API/스키마를 만들지 않는다. 타입/enum 은 `@family/contracts` 를 재사용한다.

### 2. 전송 = stdio 트랜스포트(compose 서비스 아님)

- `@modelcontextprotocol/sdk` 의 `McpServer` + `StdioServerTransport` 를 사용한다. 클라이언트
  (Claude Code)가 서버 프로세스를 **직접 spawn**(`node dist/main.js`)하고 stdin/stdout 으로
  JSON-RPC 를 주고받는다(개행 구분 JSON 메시지 프레이밍).
- MCP 서버는 **`docker-compose.yml` 서비스가 아니다**(PRD §7.4). 상시 떠 있는 HTTP 데몬이 아니라
  클라이언트 세션 수명에 종속된 로컬 프로세스다. 접근 대상 API(`FAMILY_API_URL`)만 살아 있으면 된다.
- 근거: MCP 클라이언트 표준 배포 형태가 "로컬 실행 파일 + stdio" 이고, 개인용 도구는 세션 스코프
  프로세스가 자연스럽다. Streamable HTTP 트랜스포트는 다중 사용자/원격 노출이 필요할 때의 후속
  선택지로 남긴다(현재 완료 조건 밖).

### 3. 인증 = env 자격 login → access(메모리) + refresh(쿠키 수동), 401 → refresh 1회

- 서버는 시작 시 env `FAMILY_EMAIL` + `FAMILY_PASSWORD` 로 `POST /v1/auth/login` 을 호출해
  **access token 을 메모리에 보관**하고, 응답 `Set-Cookie` 의 refresh 토큰을 **수동으로 파싱해
  Cookie 헤더로 보관**한다(Node fetch 는 자동 쿠키 저장이 없으므로 직접 관리).
- 이후 모든 도구 호출은 `Authorization: Bearer <access>` (+ refresh Cookie)로 API 를 부른다.
  **401 을 받으면 `POST /v1/auth/refresh`(Cookie)로 1회 재발급 후 원 요청을 재시도**하고, 그래도
  실패하면 도구가 명확한 에러를 반환한다(ADR-0005 refresh 회전 규약 계승).
- 자격 정보는 **클라이언트(Claude Code)가 MCP 서버 등록 시 env 로 주입**한다. 서버는 토큰/쿠키/
  비밀번호를 **로그에 남기지 않는다**(PRD §11).

### 4. stdout 은 프로토콜 전용 · 로그는 stderr 전용

- stdio 트랜스포트에서 **stdout 은 MCP JSON-RPC 메시지 전용 채널**이다. 진단 로그·경고·에러는
  **모두 stderr(`console.error`)로만** 출력한다. stdout 에 임의 문자열을 찍으면 JSON-RPC 프레이밍이
  깨져 클라이언트가 프로토콜 오류를 낸다.
- 로그에는 개수·식별자·모델 id 등 **비민감 정보만** 남기고, 비밀번호/토큰/쿠키/원문/PII 를 금지한다.

### 기본값 자동 해석(workspaceId / householdId)

- 대부분의 도구는 `workspaceId`(개인 데이터 컨테이너 `workspaces.id`) 또는 `householdId` 를 받는다.
  미지정 시 **env(`FAMILY_WORKSPACE_ID`/`FAMILY_HOUSEHOLD_ID`) → 자동 조회** 순으로 해석한다
  (workspace 는 `GET /v1/slack/workspaces` 첫 항목, household 는 `GET /v1/auth/me` memberships 첫
  항목). 해석 불가 시 도구가 명확한 에러를 반환한다. 이 편의 로직 또한 **API 응답에만 의존**한다.

## 트레이드오프 — DB/서비스 직접접근 대비

**채택안(HTTP API 재사용)**

- 장점
  - 권한(PRD §26 소유자 전용)·출처(citations)·근거 판단(refused)·시간성 필터(current/asOf) 등
    검증된 도메인 로직을 **중복 없이 상속**. MCP 는 얇은 어댑터로 유지된다.
  - API 계약(`@family/contracts`)이 단일 진실. API 가 진화하면 MCP 는 계약만 따라가면 된다.
  - DB 커넥션 풀/마이그레이션/트랜잭션 경계를 MCP 프로세스가 떠안지 않는다(운영 단순).
- 단점
  - 네트워크 홉이 하나 늘어난다(도구 호출 → HTTP → API). 로컬/컨테이너 내부라 지연은 작다.
  - API 가 노출한 것만 접근 가능(엔드포인트 없는 데이터는 도구화 불가) — 현재 6개 도구는 모두
    기존 엔드포인트로 충족된다.

**대안(DB/서비스 직접접근)**

- 장점: 홉 제거, 이론상 최저 지연.
- 단점: **접근제어/출처/근거 로직을 MCP 안에서 재구현**해야 하고(권한 유출 위험 표면 증가),
  DB 스키마·커넥션·마이그레이션에 MCP 가 강결합된다. 로직 이중화로 API 와 MCP 의 권한 판단이
  어긋날 위험. PRD §23(권한/출처를 한 곳에서 강제) 위배 소지.

→ 개인 데이터의 **접근제어와 출처는 반드시 한 계층에서만 강제**되어야 한다는 원칙(PRD §23/§26)이
결정적이다. HTTP API 재사용을 채택한다.

## 결과

- `apps/mcp` 는 `config`(env 검증) → `api-client`(login/refresh + 도메인 메서드) → `tools/*`(6개)
  → `main`(McpServer + StdioServerTransport, registerTool) 구조의 얇은 계층이 된다.
- 검증은 `scripts/verify-phase10.mjs` 가 **api 컨테이너 내부**에서 MCP 서버를 child 로 spawn 하고
  stdio JSON-RPC(initialize → tools/list → tools/call)로 6개 도구·출처·권한 스코프를 실측한다.
- MCP 는 compose 서비스가 아니므로 배포 토폴로지는 불변. Docker dev 이미지에 `apps/mcp/dist` 빌드
  산출물만 포함하고(검증이 컨테이너에서 실행), `@modelcontextprotocol/sdk` 의존 추가로 lockfile 을
  재생성한다.
- 신규 위험: env 자격이 클라이언트 설정에 평문으로 존재(로컬 사용자 스코프). 서버는 이를 로그로
  절대 노출하지 않으며, 원격 노출이 필요해지면 트랜스포트(Streamable HTTP) + 인증 방식을 재검토한다.

## 관련 문서

- [Phase 10 빌드 스펙](../phase10-build-spec.md)
- [MCP API 명세](../api/mcp.md)
- [ADR-0005 JWT + refresh 회전](0005-auth-jwt-refresh-rotation.md)
- [ADR-0012 Hybrid RAG](0012-hybrid-rag-retrieval.md) ·
  [ADR-0013 장기 기억](0013-memory-candidates-and-approval.md) ·
  [ADR-0014 Temporal GraphRAG](0014-postgres-temporal-graph.md)
- [ADR-0004 모델 비종속 AI provider](0004-model-agnostic-ai-providers.md)
