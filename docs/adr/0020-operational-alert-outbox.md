# ADR-0020: 운영 경보를 트랜잭션 아웃박스로 전달

## 상태

승인됨 (Accepted) — 2026-07-19

## 배경

파이프라인 실행, 데이터 이벤트 발행, 모델 카나리는 데이터베이스에 상태를 남기지만 운영자가 로그를
계속 확인하지 않으면 최종 실패를 늦게 발견할 수 있었다. 단일 맥 Docker 운영 환경에서는 별도 경보
플랫폼을 먼저 도입하는 것보다 기존 PostgreSQL 제어 평면과 API 프로세스를 재사용하는 편이 운영 복잡도와
장애 지점을 줄인다. 반면 실패 트랜잭션에서 웹훅을 직접 호출하면 외부 네트워크 장애 때문에 원래 상태
변경까지 롤백되거나 경보가 유실될 수 있다.

## 결정

1. `operational_alerts`를 영속 경보 아웃박스로 사용한다. 파이프라인 최종 실패, outbox 격리,
   canary rollback/suspension 상태 변경과 경보 생성을 같은 DB 트랜잭션에서 커밋한다.
2. 파이프라인 재시도 가능 실패는 경보하지 않고 BullMQ 최대 시도에 도달한 실패만 기록한다.
3. API의 dispatcher가 `FOR UPDATE SKIP LOCKED` lease로 pending 경보를 claim하고 generic JSON 또는
   Slack Incoming Webhook으로 전달한다. 전달은 at-least-once이며 지수 backoff와 최대 시도를 적용한다.
4. 웹훅이 설정되지 않아도 경보 레코드는 pending으로 보존한다. URL, bearer token, 응답 본문은 로그에
   남기지 않는다.
5. 외부 payload에는 원문, 사용자·가구·workspace 식별자, raw exception을 넣지 않는다. 경보 종류,
   severity, 안전한 집계와 오류 코드만 전달한다.

## 결과

- 상태 변경과 경보 의도가 원자적으로 보존되어 외부 웹훅 장애에도 경보를 다시 보낼 수 있다.
- 여러 dispatcher가 실행돼도 서로 다른 레코드를 claim하며, 수신 측은 `alertId`로 중복을 제거할 수 있다.
- 실제 외부 통지는 운영자가 `PIPELINE_ALERT_WEBHOOK_URL`을 설정해야 시작된다. 설정 전 pending 경보는
  데이터베이스에 쌓이므로 운영 지표에서 backlog를 감시한다.
