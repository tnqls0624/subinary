# ADR-0021: 운영 이미지 고정과 restic 오프호스트 암호화 복제

## 상태

승인됨 (Accepted) — 2026-07-19

## 배경

단일 맥 Docker 운영에서 `latest` 태그는 같은 배포 명령이 다른 바이너리를 실행하게 만들 수 있다.
로컬 PostgreSQL/MinIO 논리 백업과 격리 복구 검증은 디스크 논리 오류에는 대응하지만 백업 원본도 같은
맥에 있으면 디스크 분실·고장이라는 장애 도메인을 공유한다.

## 결정

1. production Compose의 PostgreSQL, Redis, MinIO, MinIO Client, Caddy, cloudflared와 앱 Node base를
   운영 검증한 OCI manifest digest로 고정한다. 갱신은 새 digest 빌드·격리 검증·운영 health 확인을 거친
   명시적 변경으로만 수행한다.
2. 검증된 로컬 snapshot을 restic 0.19.1 repository에 암호화 복제하는 opt-in profile을 제공한다.
   restic 바이너리는 공식 release SHA-256을 빌드 시 검증한다.
3. macOS Docker bind mount 호환성을 위해 checksum이 확인된 snapshot 디렉터리를 tar stream 하나로
   restic에 전달한다. 원격 복구 검증은 repository check, 최신 archive 복원, 내부 SHA256SUMS와
   `pg_restore --list`까지 수행한다.
4. repository와 password가 없으면 fail-closed한다. profile은 기본 production 기동에 포함하지 않으며,
   실제로 맥과 다른 장애 도메인의 저장소를 준비한 뒤에만 활성화한다.

## 결과

- upstream 태그 변경으로 인한 예고 없는 운영 drift를 제거한다.
- 원격 저장소가 S3 호환, REST 또는 SFTP 중 무엇이든 restic의 동일 암호화·보존·검증 절차를 사용한다.
- repository password를 잃으면 복구할 수 없으므로 앱 시크릿과 별도 안전한 위치에 보관해야 한다.
- 외부 저장소 endpoint와 credential은 운영자가 제공해야 하며 저장소 비용·가용성은 이 저장소가 결정하지
  않는다.
