# Task ID: 12

**Title:** Job idempotency·자원 admission·run reconciler 구현

**Status:** pending

**Dependencies:** 3, 9, 11

**Priority:** high

**Description:** 중복 실행을 막고 자원 부족 시 Job을 차단하며 외부 상태와 pipeline_runs 불일치를 자동 조정한다.

**Details:**

동일 idempotency key의 active/succeeded Job을 재사용하고 새 container를 만들지 않는 원자적 잠금 또는 DB constraint를 설계한다. 전체 heavy Job 동시성 1을 강제하고 시작 전 memory headroom, Docker disk, backup freshness, 상충 작업 lock을 검사한다. orchestrator/Launcher 상태와 pipeline_runs를 주기적으로 대조해 orphan, lost update, stale running 상태를 조정한다. 취소 요청은 새 단계를 금지하고 실행 중 Job 종료로 전달한다. 관련 요구사항: FR-015~016, FR-021, FR-023~024, NFR-003, AC-007, AC-011.

**Test Strategy:**

동시 중복 trigger race, succeeded 재사용, failed 재시도, heavy Job 동시 실행, memory/disk/backup admission 거부, Launcher 응답 유실, orphan container, stale running run, cancel race를 테스트한다. 동일 key에서 실제 container가 하나인지와 reconciler 재실행의 멱등성을 확인한다.
