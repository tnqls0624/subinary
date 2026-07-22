# Task ID: 3

**Title:** Docker Desktop 자원·디스크 운영 기준선 확정

**Status:** pending

**Dependencies:** None

**Priority:** high

**Description:** 18GB Mac에서 제품 서비스, 제어면, heavy Job이 공존할 수 있도록 Docker 자원 예산과 admission 기준을 실측해 고정한다.

**Details:**

Docker Desktop 메모리 상한 12GiB, macOS 최소 6GiB 확보, 상시 서비스 제한 합계 10GiB 이하, 정상 사용 8GiB 이하, heavy Job 전 headroom 3GiB 이상을 기준으로 현재 컨테이너별 CPU/memory/disk 사용량을 측정한다. Docker log rotation, image/container/volume 디스크 예산, 안전한 정리 임계치와 runbook을 정의한다. 운영 데이터 volume을 자동 정리 대상에서 제외한다. 관련 요구사항: FR-024, NFR-001~003, AC-011.

**Test Strategy:**

idle 30분, 정상 부하, backup, trainer dry-run에서 메모리·CPU·disk를 기록한다. headroom 부족, disk low, stale backup 조건에서 heavy Job admission이 거부되는지 확인한다. 재부팅 후 설정 유지와 log rotation 상한도 검증한다.
