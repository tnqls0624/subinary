# Task ID: 11

**Title:** Internal Job Launcher와 보안 negative test 구현

**Status:** pending

**Dependencies:** 5, 10

**Priority:** high

**Description:** Docker socket을 단독 보유하고 allowlist 계약만 실행하는 최소 권한 Internal Job Launcher를 구현한다.

**Details:**

Job Launcher는 외부 ingress 없이 내부 control network에서만 접근 가능하고 인증된 Pipeline Control 요청만 수락한다. 서버 registry에서 실행 spec을 조립하며 클라이언트 제공 image, raw command, mount, capability를 신뢰하지 않는다. Job container에 read-only rootfs, non-root, 제한 tmpfs, PID/CPU/memory/timeout, data network만 적용한다. exit code, 제한·redacted stdout/stderr, 시각, artifact checksum을 canonical 단계 실행에 연결한다. Docker socket은 Launcher 하나에만 mount한다. 관련 요구사항: FR-018~022, FR-034, AC-009~011, AC-022.

**Test Strategy:**

허용 Job end-to-end 실행과 registry 결과 correlation을 검증한다. 임의 image/command/mount, privileged, socket mount, public network, path traversal, oversized output/tmpfs, timeout, launcher 재시작을 negative/integration test로 수행한다. docker inspect로 non-root, read-only, 자원 제한, network, socket 단독 mount를 확인한다.
