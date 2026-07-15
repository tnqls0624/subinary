# ADR-0003: pnpm workspaces + Turborepo 모노레포 채택

## 제목

모노레포 구성 도구로 pnpm workspaces와 Turborepo 채택

## 상태

승인됨 (Accepted) — 2026-07-15

## 배경

프로젝트는 3개의 실행 앱(`api`/`worker`/`web`)과 1개의 자리표시자(`mcp`),
5개의 공유 패키지(`config`/`shared`/`contracts`/`ai-providers`/`database`)로 구성된다.
API 계약(zod 스키마), 큐 이름 상수, 환경변수 스키마를 앱 간에 **단일 소스**로 공유해야
하며, 프런트(Next.js)와 백엔드(NestJS)가 같은 타입을 참조해야 한다. 멀티레포로 나누면
버전 동기화와 계약 드리프트 문제가 생긴다. 또한 패키지 빌드(tsup)와 앱 빌드의
의존 순서(`^build`)를 관리할 태스크 러너가 필요하다.

## 결정

- **pnpm workspaces**(`pnpm@9.15.4`, `packageManager` 필드로 고정)를 패키지 매니저로 사용한다.
  workspace 글롭은 `apps/*`, `packages/*`.
- **Turborepo ^2.3.3**(schema 2.x, `tasks` 키)을 태스크 러너로 사용한다:
  - `build`: `dependsOn: ["^build"]`, outputs `dist/**`, `.next/**`
  - `dev`: `cache:false`, `persistent:true`
  - `typecheck`: `dependsOn: ["^build"]`
- 내부 패키지는 `@family/` scope + `workspace:*` 프로토콜로 참조한다.
- 공유 패키지는 tsup으로 esm+cjs+dts를 빌드해 CJS(NestJS+SWC)와 ESM(Next.js)을 모두 지원한다.
- Docker dev 이미지는 이미지 내에서 `pnpm install --frozen-lockfile` 후 패키지만 빌드하고,
  앱 소스(`apps/*/src`)만 바인드마운트해 node_modules 심링크 이슈를 피한다.

## 검토한 대안

1. **npm/yarn workspaces + 스크립트 직접 조합**: 도구가 단순하지만 태스크 의존 그래프·캐시가
   없어 `packages → apps` 빌드 순서를 수동 관리해야 한다.
2. **Nx**: 강력한 그래프/생성기 제공. 다만 학습 비용과 설정 침습성이 커서 이 규모에는 과하다.
3. **Lerna**: 퍼블리싱 중심 도구로, private 모노레포의 태스크 실행 요구와 초점이 다르다.
4. **멀티레포**: 계약 패키지 버전 배포/동기화 부담, 원자적 변경 불가로 기각.

## 장점

- 계약/상수/타입의 단일 소스 — API와 프런트 간 드리프트를 컴파일 타임에 차단.
- pnpm의 콘텐츠 주소 저장소로 설치가 빠르고 디스크 효율적. `packageManager`로 버전 재현성 확보.
- turbo 캐시·병렬 실행으로 `build`/`typecheck`가 빠르고, `^build`로 의존 순서가 선언적.
- 앱·패키지 추가 시 워크플로 변경 없이 글롭에 흡수됨(예: Phase 10의 `apps/mcp`).

## 단점

- 단일 레포가 커지면 CI 전체 시간이 늘 수 있다(turbo 필터/원격 캐시로 완화 필요).
- pnpm 심링크 기반 node_modules는 일부 도구와 마찰이 있을 수 있다
  (`.npmrc`의 `auto-install-peers=true`, Docker에서 소스만 마운트하는 방식으로 완화).
- Turborepo 설정(schema 2.x `tasks`)에 대한 팀 학습 비용.

## 변경조건

- 레포 규모가 커져 turbo 로컬 캐시로 CI가 감당되지 않으면 원격 캐시 도입을 검토한다.
- 외부 공개 패키지 배포 요구가 생기면 퍼블리싱 파이프라인(changesets 등) 추가를 검토한다.
- pnpm/Turborepo 메이저 업그레이드로 스키마가 바뀌면 본 ADR의 고정 버전을 갱신한다.
- 조직이 커져 레포 접근 권한 분리가 필요해지면 부분 멀티레포 전환을 재검토한다.
