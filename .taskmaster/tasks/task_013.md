# Task ID: 13

**Title:** Self-hosted Prefect 3 오케스트레이터 POC 구축

**Status:** pending

**Dependencies:** 2, 3, 8, 11, 12, 16

**Priority:** high

**Description:** 교체 가능한 어댑터 뒤에 Prefect 3 server와 worker를 배치해 synthetic AI batch 흐름을 검증한다.

**Details:**

Prefect 공식 문서로 현재 지원 버전과 self-host 구성을 확인하고 image digest와 Python lockfile을 고정한다. server/worker는 별도 control network와 Cloudflare Access로 보호된 운영 UI를 사용하며 Docker socket을 mount하지 않는다. 오케스트레이터 어댑터는 Pipeline Control 계약만 구현하고 pipeline_runs를 canonical로 유지한다. synthetic snapshot→validate→train-dry-run→evaluate→approval-wait flow에 retry, timeout, cancel, backfill을 구현한다. 동시 flow 1, heavy Job 1을 적용하고 Prefect 제거/수동 경로를 보존한다. 관련 요구사항: POC-001~010, NFR-004, NFR-006, NFR-014.

**Test Strategy:**

synthetic flow Happy path와 retry/timeout/cancel/backfill/approval wait를 UI와 API에서 검증한다. duplicate trigger가 Job을 두 번 만들지 않는지, idle 30분 메모리 합계가 1.25GiB 이하인지, flow/heavy 동시성 1인지 측정한다. Prefect와 ingress에 Docker socket이 없고 Access 없이 UI 접근이 차단되는지 확인한다.
