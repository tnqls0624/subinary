# ADR-0022: 운영 경보 감지를 장애 도메인별로 분리한다

## 상태

승인됨 (Accepted) — 2026-07-19

## 배경

ADR-0020은 pipeline 최종 실패처럼 제품 transaction과 함께 발생하는 경보를 PostgreSQL outbox에 보존하도록
결정했다. 그러나 backup freshness와 host disk는 DB transaction이 아니며, Mac 전원이나 Docker 전체가
중단되면 같은 Mac의 프로세스는 경보를 보낼 수 없다. 기존 generic payload의 `details`도 구조상 임의의 중첩
값을 허용해 미래 producer가 PII나 secret을 외부로 보낼 위험이 있었다.

## 결정

1. 제품 상태 변경에서 발생하는 경보는 기존 `operational_alerts` outbox와 API dispatcher가 담당한다.
2. backup stale과 disk low는 DB·Docker socket·제품 credential이 없는 `ops-sentinel`이 filesystem만 읽어
   동일 receiver로 전달한다. 상태 전이와 pending event는 전용 volume에 보존한다.
3. Mac, Docker, cloudflared 전체 중단은 동일 장애 도메인에서 감지하지 않는다. 모든 Zero Trust plan에 포함된
   Cloudflare Tunnel Health notification을 Mac 밖의 email 또는 webhook destination에 연결한다.
4. tunnel health는 application route health를 보장하지 않는다. 외부 application synthetic monitor와 SLO는
   별도 Task에서 선택한다.
5. 외부 webhook payload는 kind별 allowlist에 있는 scalar만 허용한다. unknown key, 중첩 객체, 제어문자,
   원문, 사용자 식별자, secret은 발송 전에 제거한다.
6. actual receiver URL과 Cloudflare destination은 운영 secret/계정 설정이며 저장소에 기록하지 않는다.

## 결과

- pipeline 경보의 transaction durability는 유지된다.
- host-local 신호를 감시하기 위해 Docker socket이나 DB 권한을 새로 노출하지 않는다.
- Mac 전체 장애를 외부 장애 도메인에서 감지할 수 있다.
- 동일 receiver가 at-least-once event를 받을 수 있으므로 `alert.id` 멱등 처리가 필요하다.
- local sentinel은 condition이 지속되는 동안 재시도하지만 DB outbox와 동일한 transaction 보장을 제공하지 않는다.
- 실제 receiver와 Cloudflare notification이 설정되기 전에는 Task 1을 운영 완료로 간주하지 않는다.

## 대안

- GitHub Actions scheduled monitor: 고부하 시 지연 또는 drop될 수 있어 5분 host-down SLO의 주 감시자로
  사용하지 않는다.
- sentinel에 Docker socket mount: 권한이 과도하고 host 침해 반경이 커서 거부한다.
- backup/disk event를 기존 DB enum에 추가: 가능하지만 현재 사용자 schema/migration 변경과 충돌하며
  host-local monitor에 DB credential을 요구하므로 이번 단계에서는 채택하지 않는다.
