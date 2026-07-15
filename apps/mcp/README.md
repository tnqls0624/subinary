# @family/mcp — MCP Server (자리표시자)

> **Phase 10에서 구현 예정. 현재 비활성.**

이 디렉터리는 Family Memory AI의 **MCP(Model Context Protocol) 서버** 자리표시자다.
Phase 0에서는 어떤 코드도 실행되지 않으며, `docker-compose.yml`에도 포함되지 않는다.
pnpm workspace가 패키지를 인식할 수 있도록 noop 스크립트만 가진 `package.json`을 배치해 두었다.

## 현재 상태 (Phase 0)

| 항목 | 상태 |
|---|---|
| 실행 서비스 | 아님 (compose 미포함) |
| 소스 코드 | 없음 |
| workspace 등록 | 됨 (`apps/*` 글롭) |
| scripts | 전부 noop (`build`/`dev`/`typecheck`/`lint`) |

## Phase 10 구현 계획 (개요)

MCP 서버는 외부 AI 클라이언트(예: Claude, 기타 MCP 호환 클라이언트)가
가족 기억 데이터에 **권한 경계 안에서** 접근할 수 있게 하는 도구(tool) 계층이다.

- 전송: stdio 및/또는 Streamable HTTP (구현 시 결정)
- 인증/권한: 가족 구성원 단위 스코프, `Visibility`(`private`/`household`/`summary_only`) 및
  `Sensitivity`(`normal`/`private`/`confidential`) 정책 준수 (`@family/shared` 공통 타입)
- 데이터 접근: `@family/database` 및 API 내부 서비스 계층 재사용 (직접 SQL 노출 금지)
- 로깅: 개인정보/Secret 로그 금지 원칙 동일 적용

## 예정 도구 후보 (확정 아님)

| 도구 이름(후보) | 설명 |
|---|---|
| `memory_search` | 자연어 질의로 가족 기억/기록을 하이브리드(벡터+키워드) 검색 |
| `memory_get` | 기억 항목 단건 조회 (권한/민감도 필터 적용) |
| `memory_timeline` | 기간/구성원 기준 타임라인 조회 |
| `expense_summary` | 기간별 지출 요약 (금액은 KRW 정수) |
| `schedule_lookup` | 가족 일정 조회 (Timezone `Asia/Seoul`) |
| `family_profile_get` | 가족 구성원 프로필 요약 조회 (summary_only 정책 준수) |

> 위 목록은 후보이며, 실제 도구 이름·시그니처는 Phase 10 설계 시 PRD와 함께 확정한다.

## 참고

- Phase 0 빌드 스펙: [`docs/phase0-build-spec.md`](../../docs/phase0-build-spec.md)
- 아키텍처 개요: [`docs/architecture/overview.md`](../../docs/architecture/overview.md)
- 모델 비종속 AI Provider 결정: [`docs/adr/0004-model-agnostic-ai-providers.md`](../../docs/adr/0004-model-agnostic-ai-providers.md)
