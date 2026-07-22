# Task ID: 17

**Title:** 월간 restore·reconciliation 운영 훈련 자동화

**Status:** pending

**Dependencies:** 2, 14, 16

**Priority:** medium

**Description:** 백업 복원과 DB↔MinIO·오케스트레이터 상태 조정을 매월 반복 가능한 운영 훈련으로 정착시킨다.

**Details:**

격리 복원 환경 준비, offsite snapshot 선택, PostgreSQL/MinIO 복원, checksum 검증, DB object reference 검사, pipeline_runs와 orchestrator 상태 reconciliation, 수동 fallback 확인을 하나의 runbook 또는 자동 workflow로 연결한다. 결과에는 snapshot 시각, 실제 RPO/RTO, 누락/고아 artifact, 조정한 run, 담당자, 개선 action을 기록한다. 운영 데이터나 현재 production volume을 덮어쓰지 않도록 안전 장치를 둔다. 관련 요구사항: FR-031~032, NFR-009~011, AC-013, AC-017~019.

**Test Strategy:**

운영 volume과 분리된 임시 복원 대상으로 전체 훈련을 실행한다. offsite RPO 24시간, RTO 4시간, checksum, 대표 DB↔MinIO 참조 무결성, orphan/missing 상태 탐지를 검증한다. 잘못된 대상 경로와 운영 volume 지정이 거부되는지, 결과 기록과 개선 action이 감사 가능하게 남는지 확인한다.
