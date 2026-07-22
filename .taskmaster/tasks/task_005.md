# Task ID: 5

**Title:** GHCR arm64·multi-platform 이미지 공급망 구축

**Status:** pending

**Dependencies:** 4

**Priority:** high

**Description:** 운영 Mac에서 image build를 제거하고 GitHub Actions가 앱, backup, pipeline Job, Job Launcher 이미지를 digest로 게시하게 한다.

**Details:**

각 Dockerfile과 build context를 조사해 linux/arm64 또는 필요한 multi-platform matrix를 정의한다. main 승인 후 GitHub Actions에서 이미지를 빌드하고 GHCR에 commit SHA tag와 OCI metadata를 게시한다. 운영 secret은 build arg나 layer에 포함하지 않는다. 이미지별 immutable digest를 수집하고 실패 시 불완전 release가 생성되지 않게 한다. 관련 요구사항: FR-003~004, NFR-012~015.

**Test Strategy:**

arm64 manifest와 image architecture를 확인하고 Mac에서 pull/run smoke test를 수행한다. commit SHA와 OCI source/revision label, digest immutability를 검증한다. secret fixture가 image history/layer에 포함되지 않는지, 한 이미지 build 실패 시 release가 중단되는지 테스트한다.
