# AI 파이프라인 운영 경보

운영 경보는 장애 도메인에 따라 세 경로로 분리한다.

| 신호 | 감지·보존 | 외부 전달 |
|------|-----------|-----------|
| pipeline 최종 실패, data outbox 격리, canary rollback/suspension | PostgreSQL `operational_alerts` outbox | API dispatcher |
| backup stale, host disk low와 recovery | `ops-sentinel` + `ops-sentinel-state` volume | ops sentinel |
| Mac 종료, Docker 중단, cloudflared tunnel down | Cloudflare edge | Tunnel Health notification |

애플리케이션 outbox 경로는 원래 상태 변경과 경보 의도를 같은 DB transaction에 저장한다. 외부 웹훅 장애가
제품 transaction에 영향을 주지 않으며 dispatcher가 성공할 때까지 재시도한다. host-local sentinel은 DB와
Docker socket 없이 backup marker와 같은 filesystem의 여유 공간만 읽고 상태 전이와 미전달 event를 전용
volume에 보존한다.

## 1. 외부 receiver 설정

`.env.production`에 다음 값을 추가한다. URL과 bearer token은 Git에 기록하지 않는다.

```bash
PIPELINE_ALERT_WEBHOOK_URL=https://hooks.example.com/...
# generic receiver가 bearer 인증을 요구할 때만 설정
PIPELINE_ALERT_WEBHOOK_BEARER_TOKEN=
# generic 또는 slack
PIPELINE_ALERT_WEBHOOK_FORMAT=generic
PIPELINE_ALERT_POLL_INTERVAL_MS=30000
PIPELINE_ALERT_BATCH_SIZE=20
PIPELINE_ALERT_REQUEST_TIMEOUT_MS=5000
PIPELINE_ALERT_MAX_ATTEMPTS=8

# local ops sentinel
OPS_SENTINEL_INTERVAL_MS=60000
OPS_SENTINEL_REQUEST_TIMEOUT_MS=5000
OPS_SENTINEL_BACKUP_MAX_AGE_SECONDS=90000
OPS_SENTINEL_DISK_MIN_FREE_BYTES=42949672960
OPS_SENTINEL_DISK_MIN_FREE_PERCENT=10
```

- `generic` payload의 `schemaVersion`은 `operational-alert-v1`이다.
- 수신기는 `alert.id`를 멱등 키로 사용한다. 문서의 `alertId`라는 별도 top-level 필드는 없다.
- Slack 형식은 고정 제목과 안전한 집계만 text로 전달하고 markup·mention 문자를 escape한다.
- URL에는 credential을 포함하지 않고 HTTPS만 사용한다.

설정 반영은 stateful service를 재기동하지 않고 발송자 두 개만 갱신한다.

```bash
docker compose --env-file .env --env-file .env.production \
  -f docker-compose.prod.yml up -d --build api ops-sentinel
```

## 2. Synthetic receiver 검증

실제 receiver에 `receiver_test` 한 건을 보내므로 운영자가 수신 채널을 보고 있을 때 명시적으로 실행한다.
운영 DB에는 검증 row를 만들지 않는다.

```bash
pnpm ops:alert:verify
```

합격 조건:

1. 명령이 0으로 종료한다.
2. receiver가 5초 timeout 안에 2xx로 응답한다.
3. 수신 payload에 `kind=receiver_test`, `details.test=true`, `alert.id`가 있다.
4. URL, token, 응답 본문, 사용자·가구·원문·MinIO object key가 로그와 payload에 없다.
5. 수신 시각을 기록해 5분 경보 SLO의 기준 증거로 남긴다.

URL이 없으면 exit 64로 fail-closed한다. 4xx/5xx/timeout은 status family 또는 Error name만 출력하고 응답
본문은 읽지 않는다.

## 3. Local ops sentinel

`ops-sentinel`은 다음 조건의 상태 전이에서만 경보한다.

- `backup_stale`: `.last-success` age가 `OPS_SENTINEL_BACKUP_MAX_AGE_SECONDS`를 초과하거나 marker가
  누락·손상·미래 시각이다.
- `disk_low`: backup mount의 available bytes 또는 available percent 중 하나라도 설정 하한 미만이다.
- 조건 시작은 `transition=firing`, 회복은 `transition=recovered`다.
- 같은 상태를 계속 관측하는 동안에는 중복 event를 만들지 않는다.
- receiver 장애 시 pending event를 state volume에 유지하고 다음 cycle에 순서대로 재시도한다.
- receiver 장애 중 같은 조건이 반복 flap하면 state가 무한히 커지지 않도록 조건별 첫 event와 최신 상태만
  보존한다.

보안 경계:

- non-root, read-only root filesystem, all capabilities drop, `no-new-privileges`
- 0.1 CPU, 64MiB, PID 64 제한
- backup bind는 read-only, `/state`만 writable
- DB/Redis/MinIO credential, 제품 `.env`, Docker socket을 전달하지 않음
- public ingress나 제품 service network와 분리된 outbound network만 사용

상태 확인:

```bash
docker compose --env-file .env --env-file .env.production \
  -f docker-compose.prod.yml ps ops-sentinel

docker compose --env-file .env --env-file .env.production \
  -f docker-compose.prod.yml logs --tail=100 ops-sentinel
```

로그에는 `enabled`, condition boolean, pending count, error code만 기록한다. URL, backup path, token, 응답
본문은 출력하지 않는다.

## 4. Cloudflare host-down 경보

같은 Mac의 sentinel은 Mac 전원·Docker·네트워크가 모두 중단된 상황을 알릴 수 없다. Cloudflare Zero Trust
대시보드에서 Tunnel Health Alert를 생성한다.

1. Cloudflare dashboard → Notifications → Add
2. Tunnel → Tunnel Health Alert 선택
3. 현재 production tunnel 선택
4. Mac 밖에서 확인 가능한 email 또는 webhook destination 지정
5. down/degraded와 recovered 양쪽을 수신하도록 설정
6. notification 이름, destination, 생성 시각을 운영 기록에 남김

Cloudflare 문서상 Tunnel Health Alert는 모든 Zero Trust plan에 포함되고 email, webhook, third-party 전달을
지원한다. 다만 tunnel이 Healthy여도 내부 application route가 실패할 수 있으므로 이것은 application synthetic
monitor의 대체가 아니다. `/api/health`와 `/v1/health/ready`를 외부에서 점검하는 application monitor와 SLO는
Task 16에서 추가한다.

- 공식 문서: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/notifications/
- tunnel 상태 의미: https://developers.cloudflare.com/tunnel/monitoring/

Tunnel 중단 시험은 실제 공개 장애를 만들므로 별도 유지보수 승인 없이 실행하지 않는다.

## 5. 애플리케이션 alert 점검

상태별 건수와 가장 오래된 pending 경보만 확인한다. 개별 ID와 detail을 운영 출력에 불필요하게 노출하지 않는다.

```bash
docker compose --env-file .env --env-file .env.production \
  -f docker-compose.prod.yml exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select status, count(*), min(created_at) from operational_alerts group by status order by status;"'

docker compose --env-file .env --env-file .env.production \
  -f docker-compose.prod.yml logs --tail=100 api
```

- 웹훅 미설정: pending을 유지하고 시작 로그에 한 번 경고한다.
- 4xx: 구성 또는 계약 오류지만 최대 시도까지 재시도한다.
- 5xx/timeout: 지수 backoff 후 재시도한다.
- 최대 시도 초과: `failed`로 전환한다.
- 외부 payload builder는 kind별 허용 scalar key만 보존한다. unknown key, 중첩 객체, 원문, 사용자 식별자,
  secret은 제거한다.

격리 통합 검증은 일회성 DB와 로컬 mock webhook만 사용한다.

```bash
pnpm verify:ai-pipeline:isolated
```

## 6. Task 1 운영 완료 체크리스트

- [ ] `PIPELINE_ALERT_WEBHOOK_URL`을 운영 secret으로 설정
- [ ] `api`와 `ops-sentinel` 갱신 후 healthy 확인
- [ ] `pnpm ops:alert:verify` 실제 수신 확인
- [ ] application terminal alert 격리 검증 통과
- [ ] Cloudflare Tunnel Health notification 활성화
- [ ] receiver timeout/retry와 recovered 수신 기록
- [ ] 외부 payload PII·secret 검사 0건
