#!/bin/sh
# 자동 조사 poller (A′안). launchd가 주기 실행하거나 수동 호출한다.
#   AUTO_INVESTIGATE_ENABLED=true sh scripts/ops/auto-investigate.sh
#
# 경보 → HolmesGPT 자동 조사 → webhook 보고. 인바운드 0(신규 네트워크 없음), 소켓 회피(호스트 docker CLI),
# 프롬프트 인젝션 방어(경보의 자유 텍스트 summary/details는 절대 프롬프트에 넣지 않고 scalar만 사용).
#
# 신뢰 경계: operational_alerts를 postgres 컨테이너 내부에서 read-only SELECT로만 읽는다
# (verify 스크립트와 동일 경계 — 앱 코드·dispatcher 락킹과 무간섭). 조사는 config-automated.yaml(bash 비활성).
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cd "$repo_root"

# --- kill switch: 명시적으로 켜야만 동작(LLM 비용·무인 실행이라 기본 off) ---
if [ "${AUTO_INVESTIGATE_ENABLED:-false}" != "true" ]; then
  echo "auto-investigate: disabled (AUTO_INVESTIGATE_ENABLED != true)"; exit 0
fi

dry_run="${AUTO_INVESTIGATE_DRY_RUN:-false}"   # true면 holmes/webhook 호출 없이 대상 선별까지만
max_per_run="${AUTO_INVESTIGATE_MAX_PER_RUN:-2}"        # 1회 실행 처리 상한(비용 캡)
max_per_hour="${AUTO_INVESTIGATE_MAX_PER_HOUR:-3}"      # 시간당 조사 상한(flapping 폭주 방지)

state_dir="${AUTO_INVESTIGATE_STATE_DIR:-$HOME/.subinary-auto-investigate}"
mkdir -p "$state_dir"
checkpoint_file="$state_dir/checkpoint"      # 마지막 처리 occurred_at(UTC ISO)
runlog_file="$state_dir/runlog"              # 조사 실행 epoch 이력(시간당 상한 계산)

compose() {
  docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml "$@"
}

# 마지막 체크포인트(없으면 epoch 0). 최초 실행은 과거 경보를 소급 조사하지 않도록 '지금'으로 초기화.
if [ -f "$checkpoint_file" ]; then
  checkpoint=$(cat "$checkpoint_file")
else
  checkpoint=$(compose exec -T postgres sh -lc "date -u +%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "1970-01-01T00:00:00Z")
  printf '%s\n' "$checkpoint" > "$checkpoint_file"
  echo "auto-investigate: 최초 실행 — 체크포인트를 현재로 설정($checkpoint), 이번 회차는 조사 없음"; exit 0
fi

# 시간당 상한 확인(runlog에서 최근 3600초 내 실행 수).
now_epoch=$(date +%s)
recent_count=0
if [ -f "$runlog_file" ]; then
  recent_count=$(awk -v now="$now_epoch" '($1+3600) > now' "$runlog_file" | wc -l | tr -d ' ')
fi

# --- 읽기 전용 조회: severity=critical, occurred_at > checkpoint 인 경보의 allowlist scalar만 ---
# summary/details(자유 텍스트, 인젝션 벡터)는 SELECT 하지 않는다. 구분자 '|'로 파싱.
rows=$(compose exec -T postgres sh -lc "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -F '|' -c \"select id, kind, source_type, source_id, to_char(occurred_at at time zone 'UTC','YYYY-MM-DD\\\"T\\\"HH24:MI:SS\\\"Z\\\"') from operational_alerts where severity='critical' and occurred_at > '${checkpoint}'::timestamptz order by occurred_at asc limit ${max_per_run}\"" 2>/dev/null || true)

if [ -z "$rows" ]; then
  echo "auto-investigate: 신규 critical 경보 없음(checkpoint=$checkpoint)"; exit 0
fi

webhook_url="${AUTO_INVESTIGATE_WEBHOOK_URL:-${PIPELINE_ALERT_WEBHOOK_URL:-}}"
processed=0

# IFS 개행으로 행 순회
OLDIFS=$IFS; IFS='
'
for row in $rows; do
  IFS='|'; set -- $row; IFS=$OLDIFS
  alert_id="$1"; kind="$2"; source_type="$3"; source_id="$4"; occurred_at="$5"

  # 시간당 상한 초과면 이번 행은 건너뛰되 체크포인트는 전진(재폭주 방지). 다음 회차에 재조사하지 않음.
  if [ "$((recent_count + processed))" -ge "$max_per_hour" ]; then
    echo "auto-investigate: 시간당 상한(${max_per_hour}) 도달 — $alert_id 조사 생략, 체크포인트만 전진"
    printf '%s\n' "$occurred_at" > "$checkpoint_file"
    continue
  fi

  echo "auto-investigate: 조사 대상 kind=$kind source=$source_type/$source_id at=$occurred_at"

  # 질문 템플릿: scalar만 삽입. 경보 원문(summary/details)은 넣지 않는다(인젝션 방어).
  question="컨테이너 스택에서 운영 경보가 발생했다. kind=${kind}, sourceType=${source_type}, sourceId=${source_id}, occurredAt=${occurred_at}. 관련 컨테이너의 상태와 최근 로그를 읽기 전용으로 조사해 가능한 원인과 근거를 한국어로 간단히 정리하라. 상태를 변경하는 조치는 제안만 하고 실행하지 마라."

  if [ "$dry_run" = "true" ]; then
    echo "  [dry-run] 조사/발송 생략. question=[$question]"
  else
    # 자동 전용 config(bash 비활성)로 조사. 타임아웃은 investigate.sh가 처리.
    result=$(INVESTIGATE_CONFIG=config-automated.yaml sh "$repo_root/infrastructure/holmesgpt/investigate.sh" "$question" 2>&1) || result="(조사 실패 또는 타임아웃)"
    date +%s >> "$runlog_file"

    if [ -n "$webhook_url" ]; then
      # Slack 호환 {"text":...}. 결과는 신뢰 불가(자동 생성)임을 명시. 제어문자·길이 방어.
      safe=$(printf '%s' "$result" | tr -d '\000-\010\013\014\016-\037' | head -c 3500 | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')
      body="{\"text\":\"[subinary][AI 조사 — 신뢰불가 자동생성] ${kind} ${source_type}/${source_id} @ ${occurred_at}\\n${safe}\"}"
      printf '%s' "$body" | curl -fsS -m 15 --retry 2 --retry-all-errors \
        -H 'Content-Type: application/json' -X POST -d @- "$webhook_url" >/dev/null 2>&1 \
        && echo "  보고 발송됨" || echo "  경고: 보고 발송 실패(non-fatal)"
    else
      echo "  webhook 미설정 — 조사 결과 콘솔 출력만"; printf '%s\n' "$result"
    fi
  fi

  printf '%s\n' "$occurred_at" > "$checkpoint_file"   # 처리분까지 체크포인트 전진
  processed=$((processed + 1))
done
IFS=$OLDIFS

# runlog 정리(24h 초과 제거)
if [ -f "$runlog_file" ]; then
  awk -v now="$now_epoch" '($1+86400) > now' "$runlog_file" > "$runlog_file.tmp" && mv "$runlog_file.tmp" "$runlog_file"
fi
echo "auto-investigate: 완료 — ${processed}건 처리"
