# ADR-0022: 격리 Training Runner와 로컬 모델 artifact 수명주기

## 상태

승인됨 (Accepted) — 2026-07-19

## 배경

가맹점 카테고리 Gold dataset, offline 평가, 모델 registry와 alias 제어 평면은 준비됐지만 실제 학습
실행 경계가 없었다. 운영 환경은 별도 개발 서버나 학습 클러스터가 없는 단일 맥 Docker 서버다. 학습을
상시 API/Worker 프로세스에서 수행하면 CPU·메모리 경합, 재시작 시 중복 실행, 코드·의존성 drift와
개인정보 철회 후 파생 artifact 잔존 위험이 생긴다.

현재 운영 데이터는 사람 확정 라벨이 적으므로, 실행기 구현과 실제 운영 모델 학습을 분리해야 한다.
사람 라벨 기준을 낮추거나 AI prediction을 정답으로 재사용해서는 안 된다.

## 결정

1. 첫 학습기는 외부 GPU나 추가 플랫폼 없이 문자 2~4-gram multinomial Naive Bayes 가맹점 분류기를
   사용한다. 정렬된 입력과 고정 알고리즘으로 같은 dataset·코드·lockfile에서 동일 artifact SHA-256을
   생성한다.
2. 학습 요청은 API가 `training_runs`에 `queued`로 기록하되 실행하지 않는다. 운영자는 `training`
   Compose profile의 일회성 `trainer` 컨테이너로 한 run만 실행한다. 컨테이너는 CPU 1개, 메모리 1GiB,
   PID 256 상한을 가지며 재시작하지 않는다.
3. API와 Runner는 승인된 `merchant-category`, `group_time` split, leakage audit 통과, 사람 라벨 100개,
   클래스 3개, 클래스별 10개, 모든 클래스의 train 포함과 세 split 비어 있지 않음을 각각 재검증한다.
4. Runner는 Gold artifact와 manifest checksum을 다시 계산한다. 모델 artifact에는 dataset checksum,
   trainer/code/lockfile hash, Node·OS·architecture, train/validation/test accuracy와 macro-F1을 넣고 private
   MinIO key에 저장한다. object key는 API로 노출하지 않는다.
5. 성공 시 dataset→training run→model registry 계보를 원자적으로 기록한다. 모델은
   `subinary-local/merchant-char-ngram-nb` 후보로 등록되며 기존 offline 평가·승인·alias·canary 절차를
   통과해야 production 서빙된다.
6. Worker는 승인되고 suspend되지 않은 production alias만 읽고 artifact checksum과 metadata를 검증한
   뒤 로컬 추론한다. alias가 없을 때만 기존 외부 LLM 경로를 사용한다. alias가 있는데 artifact가
   손상되거나 읽히지 않으면 외부 모델로 조용히 우회하지 않고 fail-closed한다.
7. dataset 삭제·동의 철회·source tombstone은 training run을 `revoked`, 승인 모델을 `retired`로 바꾸고
   alias/canary를 중단한다. private 모델 artifact를 실제 삭제한 후에만 `artifactPurgedAt`을 기록한다.

## 결과

- 별도 개발 환경이 없어도 운영 서비스와 자원을 분리한 재현 가능한 소형 모델 학습이 가능하다.
- 학습 실행, artifact, 모델 registry와 serving trace를 dataset까지 역추적할 수 있다.
- 실제 운영 학습은 사람 라벨 진입 게이트를 통과하기 전까지 차단된다.
- 데이터셋 품질과 서비스 규모가 문자 n-gram 모델의 한계를 넘으면 같은 `training_runs`·artifact·계보
  계약을 유지한 채 학습 구현만 교체한다.
