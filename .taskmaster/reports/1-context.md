# 프로젝트 컨텍스트 - Task 1

**생성일**: 2026-07-19
**태스크**: 외부 운영 경보 수신 채널 연결

## 자동 감지 결과

| 항목 | 값 |
|------|-----|
| 주 언어 | TypeScript, 운영 스크립트는 POSIX shell/Node.js ESM 혼합 |
| 런타임 | Node.js 22 이상, Docker Desktop on macOS |
| 패키지 매니저 | pnpm 9.15.4 |
| 저장소 구조 | Turborepo 기반 pnpm workspace monorepo |
| 주요 프레임워크 | NestJS 11, Fastify 5, Drizzle ORM, Zod 4 |
| 테스트 프레임워크 | Vitest 4(패키지), Node.js 내장 test runner(운영 검증 스크립트) |
| 전체 테스트/검증 | 패키지별 `pnpm --filter <package> test`, `node --test scripts/lib/*.test.mjs` |
| 정적 분석 | `pnpm typecheck` 또는 패키지별 `tsc --noEmit` |
| 린트 | `pnpm lint`(현재 일부 패키지는 noop) |
| 빌드 | `pnpm build` 또는 패키지별 build |
| 주요 소스 | `apps/api/src`, `apps/worker/src`, `packages/*/src` |
| 운영 구성 | `docker-compose.prod.yml`, `scripts/ops`, `infrastructure`, `docs/operations` |
| 파일 확장자 | `.ts`, `.mjs`, `.sh`, `.yml`, `.md` |

## Task 1 관련 기존 기반

- `operational_alerts` DB outbox와 generic/Slack webhook dispatcher가 이미 존재한다.
- terminal pipeline failure, quarantine, canary rollback/suspension 알림 생성 경로가 구현되어 있다.
- `PIPELINE_ALERT_WEBHOOK_*` 환경변수와 격리 검증 스크립트가 존재한다.
- Docker 및 backup healthcheck는 존재하지만 host-down, disk-low, backup-stale 신호를 외부 장애 도메인에서 통합 감지하는 연결은 아직 확인이 필요하다.
- 외부 수신 URL·토큰은 저장소에 기록하지 않고 운영 secret으로만 주입해야 한다.

## 저장소 작업 제약

- 기존에 변경된 analytics, transaction, card parser, database migration 파일은 사용자 작업이므로 수정하지 않는다.
- 운영 데이터 삭제, Docker 재기동, Cloudflare 설정 변경은 이번 조사 단계에서 수행하지 않는다.
- 공개 API와 신규 타입은 명시적 타입 및 JSDoc을 사용하고 `any`는 금지한다.
- Happy path, 경계, 오류 시나리오 테스트를 함께 작성한다.

## 사용 가능한 학습 컨텍스트

프로젝트 Memory MCP가 현재 도구 목록에 없어 과거 convention graph는 로드하지 못했다. 대신 저장소의 ADR, 운영 문서, 기존 테스트 및 코드 패턴을 근거로 사용한다.
