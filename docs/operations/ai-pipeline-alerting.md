# AI 파이프라인 운영 경보

파이프라인 최종 실패, data outbox 격리, 모델 canary 자동 rollback·suspension은
`operational_alerts`에 먼저 저장된다. 외부 웹훅 장애가 원래 처리 트랜잭션에 영향을 주지 않으며,
dispatcher가 성공할 때까지 재시도한다.

## 운영 설정

`.env.production`에 다음 값을 추가한 뒤 API를 재기동한다.

```bash
PIPELINE_ALERT_WEBHOOK_URL=https://hooks.example.com/...
# 수신기가 bearer 인증을 요구할 때만 설정
PIPELINE_ALERT_WEBHOOK_BEARER_TOKEN=
# generic 또는 slack
PIPELINE_ALERT_WEBHOOK_FORMAT=generic
PIPELINE_ALERT_POLL_INTERVAL_MS=30000
PIPELINE_ALERT_BATCH_SIZE=20
PIPELINE_ALERT_REQUEST_TIMEOUT_MS=5000
PIPELINE_ALERT_MAX_ATTEMPTS=8
```

`generic` payload의 `schemaVersion`은 `operational-alert-v1`이다. 수신기는 `alertId`를 멱등 키로 사용한다.
Slack 형식은 원문이 없는 제목과 안전한 집계만 block으로 전달하며 특수 문자를 escape한다.

설정 반영:

```bash
docker compose --env-file .env --env-file .env.production \
  -f docker-compose.prod.yml up -d api
```

## 점검

상태별 건수와 가장 오래된 pending 경보만 확인한다. 경보 상세에는 사용자 데이터가 없지만 운영 출력에서
개별 ID를 불필요하게 노출하지 않는다.

```bash
docker compose --env-file .env --env-file .env.production \
  -f docker-compose.prod.yml exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select status, count(*), min(created_at) from operational_alerts group by status order by status;"'

docker compose --env-file .env --env-file .env.production \
  -f docker-compose.prod.yml logs --tail=100 api
```

- 웹훅 미설정: pending을 유지하고 시작 로그에 한 번 경고한다.
- 4xx: 구성 또는 계약 오류로 간주하지만 최대 시도까지 재시도한다.
- 5xx/timeout: 지수 backoff 후 재시도한다.
- 최대 시도 초과: `failed`로 전환한다. URL이나 응답 본문은 로그에 출력하지 않는다.

격리 통합 검증은 일회성 DB와 로컬 mock 웹훅만 사용하며 운영 검증 데이터를 만들지 않는다.

```bash
pnpm verify:ai-pipeline:isolated
```
