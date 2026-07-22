# Task ID: 6

**Title:** SBOM·provenance·release manifest 생성 체계 구축

**Status:** pending

**Dependencies:** 5

**Priority:** high

**Description:** 모든 운영 이미지의 SBOM과 build provenance를 검증하고 배포 입력이 되는 불변 release manifest를 생성한다.

**Details:**

GitHub Actions OIDC와 GHCR을 기준으로 image별 SBOM, provenance attestation, source commit, build workflow 정보를 생성한다. release manifest는 서비스별 image@sha256 digest, schema/version 호환 정보, 생성 시각, commit SHA를 포함하고 사람이 승인할 수 있는 단일 배포 입력이어야 한다. main 게시만으로 운영 배포를 시작하지 않는다. 취약점·license gate와 예외 승인 기록 형식을 정의한다. 관련 요구사항: FR-005~006, FR-033, NFR-012, NFR-015, AC-003, AC-021.

**Test Strategy:**

정상 image의 attestation과 SBOM 검증 성공, unsigned/변조 digest 거부, 취약점 또는 license 정책 위반 실패를 테스트한다. release manifest의 모든 digest가 GHCR manifest와 일치하는지와 운영자 승인 전 배포 트리거가 발생하지 않는지 확인한다.
