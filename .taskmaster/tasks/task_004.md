# Task ID: 4

**Title:** PR 임시 통합 테스트 CI 구축

**Status:** pending

**Dependencies:** None

**Priority:** high

**Description:** 별도 개발 서버 없이 GitHub-hosted runner에서 운영 secret과 endpoint를 사용하지 않는 PR 검증 환경을 구축한다.

**Details:**

저장소의 package manager, lint, typecheck, unit/integration 명령을 기준으로 GitHub Actions workflow를 설계한다. 통합 테스트는 임시 PostgreSQL, Redis, MinIO service container와 synthetic fixture만 사용한다. 운영 hostname, Cloudflare tunnel, 운영 credential, 실제 PII 데이터 접근을 네트워크·설정 양쪽에서 차단한다. 의존성 lockfile, cache key, timeout, 실패 artifact 보존 범위를 명시한다. 관련 요구사항: FR-001~002, NFR-013, NFR-015, AC-002.

**Test Strategy:**

PR workflow에서 lint/typecheck/unit/integration을 실행한다. 운영 secret이 없는 정상 성공, 임시 서비스 장애, migration 실패, 운영 endpoint가 주입된 경우의 차단을 검증한다. artifact와 로그를 secret/PII 패턴으로 스캔해 0건인지 확인한다.
