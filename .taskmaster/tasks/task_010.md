# Task ID: 10

**Title:** Job registry와 실행 보안 정책 설계·확정

**Status:** pending

**Dependencies:** 9

**Priority:** high

**Description:** 격리 Job이 실행할 수 있는 이미지·명령·mount·network·자원·tmpfs를 서버 allowlist로 정의하고 threat model을 확정한다.

**Details:**

trainer, snapshot, validate, evaluate 등 허용 Job별 versioned contract를 정의한다. 각 항목에는 digest image, 고정 command/args schema, non-root UID, read-only rootfs, 크기 제한 tmpfs, 허용 volume, 내부 data network, CPU/memory/PID/timeout 상한, 출력 제한을 포함한다. arbitrary image/command/mount, privileged, host network, public ingress network를 명시적으로 금지한다. 자체 allowlist API와 제한 Docker proxy 선택을 threat model 및 ADR로 확정한다. 관련 요구사항: FR-018~022, FR-034, NFR-012~013, AC-009~011, AC-022.

**Test Strategy:**

정책 schema 유효성, 허용 Job 정상 예시, unknown job/version, 임의 image/command/mount, privileged, host network, writable rootfs, tmpfs 초과, 자원 상한 초과 요청을 table-driven negative test로 정의한다. 위협 모델 리뷰와 Docker socket 보유 범위 검증 기준을 문서화한다.
