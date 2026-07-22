# Task ID: 1

**Title:** 외부 운영 경보 수신 채널 연결

**Status:** done

**Dependencies:** None

**Priority:** high

**Description:** pipeline terminal failure, host-down, backup stale, disk low 등 핵심 운영 경보를 동일 Mac 밖의 수신 채널로 전달한다.

**Details:**

기존 alert outbox와 현재 health 신호를 조사하고 외부 receiver 계약을 정의한다. host-down은 로컬 프로세스가 아닌 외부 synthetic monitor가 판정해야 한다. 경보에는 PII, secret, MinIO object key를 포함하지 않으며 severity, 발생 시각, 대상, canonical pipelineRunId, runbook 링크만 허용한다. terminal 오류와 retryable 오류를 구분하고, 중복 경보 억제 및 복구 알림 정책을 문서화한다. 구현 결정은 ADR로 남긴다. 관련 요구사항: FR-013, FR-027, FR-028, NFR-007, AC-016.

**Test Strategy:**

synthetic terminal failure, host-down, backup stale, disk low 이벤트를 각각 주입한다. 외부 수신 시각이 상태 확정 후 5분 이내인지, 중복 억제가 동작하는지, payload의 PII·secret 검사 결과가 0건인지 확인한다. Happy path, receiver timeout/retry, 잘못된 설정 오류를 검증한다.
