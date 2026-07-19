# AI Training Runner 운영 절차

> 적용 환경: 로컬 맥의 `docker-compose.prod.yml` 단일 운영 서버
> 관련 결정: [ADR-0022](../adr/0022-isolated-training-runner-and-local-model-artifact.md)

Training Runner는 승인된 가맹점 카테고리 dataset 한 건을 일회성 컨테이너에서 학습한다. API/Worker와
별도 profile이며 기본 production 기동에는 포함되지 않는다. 사람 라벨 진입 게이트를 우회하지 않는다.

## 1. 사전 확인

```bash
pnpm ops:training-readiness
```

모든 scope가 `READY`이고 다음 조건을 만족해야 한다.

- 사람 확정 라벨 100개 이상, 카테고리 3개 이상, 카테고리별 10개 이상
- feedback 계보 누락 0건
- 승인된 `merchant-category` dataset의 `group_time` leakage audit 통과
- train/validation/test가 모두 비어 있지 않고 모든 클래스가 train에 포함

`COLLECT_LABELS`이면 dataset 생성이나 학습 실행을 하지 않고 카테고리 검토 UI에서 사람 확인을 계속한다.

## 2. 실행 순서

1. owner/admin 토큰으로 `POST /v1/learning/datasets/merchant-category`를 호출한다.
2. 생성된 snapshot을 `POST /v1/learning/datasets/{id}/approve`로 승인한다.
3. `POST /v1/learning/training-runs`에 `datasetSnapshotId`를 보내 queued run을 만든다. 같은
   dataset/trainer의 queued·running·succeeded run은 멱등 재사용된다.
4. 반환된 run UUID로 다음 명령을 실행한다.

```bash
TRAINING_RUN_ID=<training-run-uuid> pnpm ops:training:run
```

명령은 `training` profile의 일회성 컨테이너를 사용한다. `TRAINING_RUN_ID`가 UUID가 아니거나 run이
queued 상태가 아니면 실행하지 않는다. API가 학습 프로세스를 직접 시작하지 않으므로 의도하지 않은
원격 자원 실행이 없다.

5. `GET /v1/learning/training-runs?householdId={id}`에서 상태, artifact checksum, 환경 지문과
   train/validation/test 지표를 확인한다. object key와 원문은 반환되지 않는다.
6. 생성된 candidate는 기존 offline evaluation→model approve→production alias promote→canary 절차를
   따른다. 첫 production alias 전환 전에도 평가 통과가 필수다.

## 3. 실패와 재시도

- `blocked`: dataset 상태·checksum·동의·split·계보가 실행 시점에 바뀌었거나 진입 gate를 통과하지 못했다.
- `failed`: 스토리지, DB 또는 학습 실행 오류다. `errorCode`만 저장하고 원문 exception은 저장하지 않는다.
- `revoked`: dataset 삭제, 동의 철회 또는 source 변경이 파생 실행까지 전파됐다.

실패·차단 run은 그대로 감사 이력으로 유지한다. 원인을 해결한 뒤 API로 새 run을 요청한다. 성공으로
표시된 run을 임의로 재실행하지 않는다.

## 4. 개인정보 철회와 폐기

owner/admin은 다음 API로 승인 dataset과 파생 artifact를 즉시 폐기할 수 있다.

```http
POST /v1/learning/datasets/{datasetSnapshotId}/revoke
Content-Type: application/json

{ "reason": "privacy_request" }
```

응답 전에 dataset/manifest와 파생 모델 객체 삭제를 시도한다. 저장소 삭제가 끝나지 않으면 API는
`503`을 반환하므로 같은 요청을 재시도한다. DB의 revoke 상태는 먼저 보존되며 해당 모델은 더 이상
서빙되지 않는다.

## 5. 격리 통합 검증

```bash
pnpm verify:training-runner:isolated
```

이 명령은 운영 PostgreSQL 서버 안에 고유한 일회성 DB를 만들고 최신 migration을 적용한 뒤 다음을
검증하고 DB를 폐기한다.

- 실제 MinIO Gold artifact로 120개 사람 라벨 학습 2회
- 동일 artifact/model checksum 재현
- dataset→training run→model registry 계보
- 승인 production alias의 Worker 로컬 분류와 원문 없는 `classification` trace
- dataset revoke 후 모델 retirement와 private artifact 실제 삭제

검증 DB 이름·`NODE_ENV=test`·명시적 쓰기 허용 중 하나라도 맞지 않으면 fail-closed한다.
