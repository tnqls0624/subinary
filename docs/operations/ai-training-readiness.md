# AI 학습 준비도 운영 기준

가맹점 카테고리 분류기는 사람 확정 라벨과 계보가 충분할 때만 학습한다. 데이터가 부족한 동안에는
현재의 사람 규칙과 승인된 외부 모델/프롬프트 경로를 유지하며, AI prediction을 정답으로 재사용하지 않는다.

## 진입 게이트

초기 보수 기준은 다음과 같다. 실제 데이터가 늘면 offline baseline 결과를 근거로 조정한다.

- 사람 확정 가맹점 라벨 100개 이상
- 서로 다른 카테고리 3개 이상
- 각 학습 대상 카테고리에 라벨 10개 이상
- 현재 사람 규칙에서 append-only feedback 계보 누락 0건
- 학습 전에 `group_time` snapshot을 생성하고 train/validation/test target overlap 0건 확인

준비도는 원문과 가맹점명을 출력하지 않는 다음 명령으로 확인한다.

```bash
pnpm ops:training-readiness

# 기준을 일시적으로 바꿔 분석만 수행할 때
TRAINING_MIN_LABELS=50 TRAINING_MIN_CLASSES=3 \
TRAINING_MIN_LABELS_PER_CLASS=5 pnpm ops:training-readiness
```

`training_status=COLLECT_LABELS`이면 Training Runner를 실행하거나 모델을 승격하지 않는다. 사용자는
`카테고리 → 가맹점 분류 검토`에서 카테고리를 선택하고 확인한다. 이 명시적 확인 또는 거래 수정 화면의
가맹점 규칙 적용을 통해서만 `human_confirmed` 라벨이 누적된다. AI 추천은 선택을 돕지만 확인 전에는
학습 라벨이 아니다.

검토 화면은 같은 진입 게이트의 라벨·클래스·클래스별 최소 수·계보 상태를 진행률로 보여준다. 후보는
AI 추천이 있는 항목을 먼저, 그 안에서는 확인 가능한 거래가 많은 순서로 제시한다. 한 번에 한 가맹점만
확정하고 즉시 다음 항목으로 넘어가며, 판단하기 어려운 항목은 현재 batch 안에서 `나중에`로 미룰 수 있다.

기준을 통과한 뒤의 snapshot 생성, queued run 요청과 일회성 실행 순서는
[AI Training Runner 운영 절차](./ai-training-runner.md)를 따른다. API와 Runner가 같은 조건을 각각
재검증하므로 준비도 SQL 출력만 조작해 학습을 우회할 수 없다.

검토 큐는 금액·메모·문자 원문을 반환하지 않는다. 일반 구성원은 본인 거래만 검토하며 owner/admin도
타인의 `private`·`summary_only` 가맹점 원문은 볼 수 없다. 확인 후에는 준비도 명령으로 라벨 수와
클래스 분포를 다시 측정한다.

## 2026-07-19 기준선

- 현재 사람 확정 라벨: 1개, 카테고리: 1개
- 확인 가능한 서로 다른 가맹점: 7개, 거래: 11개
- 사람 규칙: 1개, 모델 prediction 규칙: 1개, 규칙 없는 가맹점: 5개
- legacy 사람 규칙의 feedback 계보 누락을 `0027_backfill_merchant_feedback`으로 1건 보강한 뒤 누락 0건 확인
- 판단: Training Runner·artifact·서빙·폐기 제어 평면은 운영 배포됐지만 실제 모델 학습은 보류하고
  명시적 사람 라벨을 계속 수집
