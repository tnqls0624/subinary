# Task ID: 8

**Title:** 배포 preflight·migration·smoke·rollback 자동화

**Status:** pending

**Dependencies:** 2, 3, 7

**Priority:** high

**Description:** 운영자 승인 후 안전한 순서로 배포하고 실패 시 이전 release로 복구하는 배포 절차를 구축한다.

**Details:**

배포 전 disk headroom, backup freshness, GHCR 접근, image attestation, release manifest 완전성을 검사한다. 순서는 pull→호환성 확인/migration→service recreate→internal health→Cloudflare public smoke로 고정한다. migration은 forward/backward 호환 범위와 실패 복구를 명시하고 이전 release manifest를 보존한다. 배포 actor/action/reason/result와 계획된 유지보수 시간을 감사기록에 연결한다. 관련 요구사항: FR-007~009, FR-033, FR-035, NFR-009, AC-004, AC-013, AC-021, AC-023.

**Test Strategy:**

정상 배포, disk 부족, stale backup, attestation 실패, pull 실패, migration 실패, internal health 실패, public smoke 실패를 각각 재현한다. 데이터 보존을 확인하며 이전 manifest로 15분 안에 rollback하는 훈련을 수행한다. 승인 없는 실행이 거부되고 감사기록이 남는지 확인한다.
