# Task ID: 15

**Title:** 첫 AI 배치 워크플로우 공존 전환

**Status:** pending

**Dependencies:** 14

**Priority:** medium

**Description:** POC 합격 후 첫 실제 배치 흐름을 수동 경로와 공존시키며 단계적으로 운영에 전환한다.

**Details:**

snapshot/validate/train/evaluate/approval 단계 중 위험이 낮은 첫 workflow를 선택해 shadow 또는 dry-run부터 시작한다. 기존 BullMQ 이벤트 처리와 수동 trainer 경로를 유지하고 결과를 pipeline_runs 및 artifact checksum으로 비교한다. 사람 라벨 게이트 미충족 시 production model 학습·승격은 계속 차단한다. 실제 schedule 활성화는 POC-001~010 전체 통과와 운영자 명시 승인 뒤에만 허용하며 모델 승인·alias·canary·rollback 정책을 재사용한다. 관련 요구사항: FR-014, FR-017, NFR-004, AC-005, AC-019~021.

**Test Strategy:**

synthetic/shadow 실행 결과와 기존 수동 결과를 비교한다. BullMQ 처리가 Prefect 중단 중에도 정상인지, 사람 라벨 부족 시 학습·승격이 거부되는지, 승인 없는 schedule enable이 차단되는지 확인한다. canary breach와 alias rollback을 15분 안에 수행하고 수동 경로 복귀를 검증한다.
