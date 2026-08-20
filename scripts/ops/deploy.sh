#!/bin/sh
# =============================================================================
# deploy.sh — 운영 배포 래퍼 (bootstrap + 검증 요약)
# -----------------------------------------------------------------------------
# ## 왜 래퍼가 필요한가 — 실제로 당한 함정
#
# 2026-08-20, 배포가 디스크 부족으로 **시작조차 못 했는데** 호출자는 성공으로 읽었다.
# bootstrap 스크립트는 잘못이 없었다. `exit 1`을 정확히 냈다. 문제는 호출 방식이었다:
#
#     sh scripts/ops/bootstrap-ai-pipeline-infrastructure.sh 2>&1 | tail -50
#
# POSIX sh에는 `pipefail`이 없다. 그래서 파이프라인의 exit code는 **마지막 명령**인
# `tail`의 것이고, `tail`은 입력이 무엇이든 0으로 끝난다. 배포 실패가 "exit code 0"으로
# 보고됐고, 로그 마지막 줄을 눈으로 읽어야만 실패를 알 수 있었다.
#
# 그 실수를 사람의 주의력에 맡기지 않는다. 이 래퍼는:
#   1. 출력을 **파일로** 받고(파이프를 쓰지 않는다) 종료 코드를 그대로 보존한다,
#   2. 실패하면 마지막 줄을 눌러서 보여주고 **비영 코드로 끝난다**,
#   3. 성공해도 검증 요약 줄만 뽑아 보여준다.
#
# ## 사용
#
#   sh scripts/ops/deploy.sh                 # 빌드 + 마이그레이션 + 기동 + 검증
#   sh scripts/ops/deploy.sh --skip-build    # 검증된 이미지 그대로 복구·재검증
#
# 종료 코드는 bootstrap의 것을 그대로 물려준다(0 = 성공).
# =============================================================================
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_dir/../.." && pwd)"
cd "$repository_root"

log_dir="${INFRA_DEPLOY_LOG_DIR:-$repository_root/.deploy-logs}"
mkdir -p "$log_dir"
# 타임스탬프를 파일명에 넣어 직전 배포 로그를 덮어쓰지 않는다 — 실패 원인은 대개
# "이번 로그"가 아니라 "지난번과 무엇이 달라졌나"에 있다.
log_file="$log_dir/deploy-$(date '+%Y%m%d-%H%M%S').log"

echo "[deploy] 로그: $log_file"
echo "[deploy] bootstrap 시작 (출력은 로그 파일과 화면에 함께 남는다)"

# `set -e`가 걸려 있으므로 실패를 직접 붙잡아야 뒤처리를 할 수 있다.
# tee는 파이프지만 **bootstrap의 종료 코드를 잃지 않도록** 서브셸에서 상태를 꺼낸다.
status=0
if command -v bash >/dev/null 2>&1; then
  # bash가 있으면 pipefail로 정확하게 잡는다.
  bash -o pipefail -c \
    "sh '$script_dir/bootstrap-ai-pipeline-infrastructure.sh' \"\$@\" 2>&1 | tee '$log_file'" \
    -- "$@" || status=$?
else
  # bash가 없으면 파이프를 아예 쓰지 않는다(리다이렉트 후 나중에 읽는다).
  sh "$script_dir/bootstrap-ai-pipeline-infrastructure.sh" "$@" >"$log_file" 2>&1 || status=$?
  cat "$log_file"
fi

echo ""
if [ "$status" -ne 0 ]; then
  echo "=========================================================================="
  echo "[deploy] ✗ 실패 (exit $status) — 마지막 15줄:"
  echo "=========================================================================="
  tail -15 "$log_file"
  echo "=========================================================================="
  echo "[deploy] 전체 로그: $log_file"
  # 자주 나오는 원인은 사전에 잡아 안내한다(디스크는 실제로 배포를 두 번 막았다).
  if grep -q 'required for image build' "$log_file"; then
    echo ""
    echo "[deploy] 디스크 부족입니다. docs/production-deploy.md §5.1 절차:"
    echo "  docker builder prune --all --force --reserved-space 10GB"
    echo "  docker image prune --force"
    echo "  ⛔ docker system prune -a 와 volume prune 은 쓰지 마십시오"
    echo "     (운영 데이터·롤백 이미지를 지웁니다)"
  fi
  exit "$status"
fi

echo "=========================================================================="
echo "[deploy] ✓ 성공 — 검증 요약:"
echo "=========================================================================="
# `[infra] key=value` 줄만 뽑는다. 이것이 bootstrap이 스스로 내는 검증 결과다.
grep '^\[infra\]' "$log_file" || echo "(검증 줄을 찾지 못했습니다 — 전체 로그를 확인하십시오)"
echo "=========================================================================="
echo "[deploy] 전체 로그: $log_file"
