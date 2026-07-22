# Task ID: 7

**Title:** 운영 Compose를 digest 기반 pull-only 배포로 전환

**Status:** pending

**Dependencies:** 5, 6

**Priority:** high

**Description:** 운영 Compose의 app과 Job 서비스에서 build를 제거하고 승인된 GHCR digest만 사용하도록 전환한다.

**Details:**

현재 production Compose profile과 Cloudflare tunnel 연결을 보존하면서 app, worker, web, backup, pipeline Job, Job Launcher 이미지를 release manifest의 digest로 치환한다. 로컬 build context 의존성을 제거하고 registry 인증·pull 정책·플랫폼 호환성을 문서화한다. 데이터 volume과 network 이름을 유지해 재생성 시 데이터가 보존되게 한다. 이전 manifest 보관 규칙을 추가한다. 관련 요구사항: FR-006, FR-009, FR-033, AC-001, AC-021.

**Test Strategy:**

Compose config 결과에 대상 서비스 build가 없고 image가 모두 @sha256 형식인지 정적 검사한다. 승인된 manifest pull/up, 동일 manifest 재배포, registry 인증 실패, arm64 불일치, 이전 manifest 재적용을 검증한다. PostgreSQL·MinIO volume 보존과 Cloudflare 공개 smoke를 확인한다.
