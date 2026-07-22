# Task ID: 9

**Title:** 오케스트레이터 중립 Pipeline Control 계약 구현

**Status:** pending

**Dependencies:** 4

**Priority:** high

**Description:** 수동·schedule·dataset-ready·backfill 트리거를 기존 pipeline_runs 중심의 공통 실행 계약으로 통합한다.

**Details:**

현재 pipeline_runs schema와 서비스 계층을 조사하고 canonical run 생성, trigger type, input version, code SHA, config hash, image digest, idempotency key, 외부 orchestrator run ID correlation 계약을 타입 안전하게 정의한다. pipeline_runs를 외부 호출보다 먼저 기록하고 부분 실패를 복구한다. retryable/terminal 오류, 승인 대기, 취소, backfill 상태 전이를 명시한다. 공개 API는 docstring/JSDoc과 명확한 오류 메시지를 제공한다. 관련 요구사항: FR-010~017, NFR-004, NFR-012, AC-005~008.

**Test Strategy:**

각 trigger type의 run 생성 Happy path, 중복 idempotency key, DB 기록 후 외부 호출 실패, 잘못된 상태 전이, 취소 중 race, backfill 범위 오류를 단위·통합 테스트한다. canonical pipelineRunId와 외부 run ID correlation, terminal alert outbox 생성, 오케스트레이터 비활성 수동 실행을 검증한다.
