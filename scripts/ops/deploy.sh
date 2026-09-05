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
#   DEPLOY_SKIP_MEMORY_CHECK=true sh scripts/ops/deploy.sh   # 메모리 가드 무시
#
# 종료 코드는 bootstrap의 것을 그대로 물려준다(0 = 성공).
# 메모리 가드에 걸리면 bootstrap을 **시작하지 않고** exit 3.
# =============================================================================
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_dir/../.." && pwd)"
cd "$repository_root"

# -----------------------------------------------------------------------------
# 메모리 가드 — 배포 빌드가 DB를 죽이는 것을 막는다
# -----------------------------------------------------------------------------
# ## 실제로 당한 일
#
# 2026-09-05 16:54, **배포 중에 postgres가 죽었다.** 컨테이너는 살아 있었는데 내부
# 프로세스가 비정상 종료했다:
#
#   16:46~16:54  autovacuum worker took too long to start   ← fork 지연 = 스래싱
#   16:54:45     server process exited with exit code 2
#   16:54:46     all server processes terminated; reinitializing
#   16:54:53     redo done                                   ← WAL 자동 복구
#
# 데이터는 WAL 복구로 온전했지만 운이 좋았던 것이다. 그때 스왑은 11.3GB/12.3GB,
# 여유 페이지는 90MB였다. postgres 자신은 92MB밖에 쓰지 않았다 — **호스트 전체가**
# 부족했고, 그 부족을 만든 것은 이 스크립트가 돌린 빌드다.
#
# 전날에도 같은 원인으로 빌드가 **59분간 로그 한 줄 없이** 멈춰 섰다(스왑 12.1/13.3GB).
# 스래싱은 실패로 끝나지 않고 멈춰 서기 때문에 증상이 "느리다"로만 보인다.
#
# ## 임계값의 근거 (전부 실측)
#
#   성공한 배포(13:08, 15:35)  스왑 used 3.9GB · 여유 페이지 36,411(570MB)
#   빌드가 멈춘 배포(전날)      스왑 used 12.1GB · 여유 페이지 4,330(69MB)
#   postgres가 죽은 배포        스왑 used 11.3GB · 여유 페이지 5,605(90MB)
#
# 스왑 8GB를 경계로 둔다. 성공 사례의 두 배이고 사고 사례보다 낮다.
#
# **스왑을 주 지표로 삼는 이유**: macOS는 여유 메모리를 공격적으로 캐시에 쓰므로
# `Pages free`가 낮은 것은 정상이다. 반면 스왑이 GB 단위로 차는 것은 실제 압박이고,
# 스왑 총량 자체가 늘어난 것(5GB→12GB)이 이미 시스템이 쫓기고 있다는 신호다.
#
# ## 왜 경고가 아니라 중단인가
#
# 경고는 사람의 주의력에 맡기는 것이고, 이 스크립트가 존재하는 이유가 바로 그것을
# 하지 않기 위해서다(위 머리주석의 `| tail` 사고). 위험을 알고도 진행해야 할 때는
# `DEPLOY_SKIP_MEMORY_CHECK=true`로 명시한다 — 그러면 기록에 의도가 남는다.
check_memory() {
  [ "${DEPLOY_SKIP_MEMORY_CHECK:-false}" = "true" ] && {
    echo "[deploy] 메모리 가드 건너뜀 (DEPLOY_SKIP_MEMORY_CHECK=true)"
    return 0
  }

  swap_used_mb=""
  if command -v sysctl >/dev/null 2>&1 && sysctl -n vm.swapusage >/dev/null 2>&1; then
    # macOS: "total = 12288.00M  used = 11297.12M  free = 990.88M"
    swap_used_mb="$(sysctl -n vm.swapusage 2>/dev/null \
      | sed -n 's/.*used = \([0-9.]*\)M.*/\1/p' | cut -d. -f1)"
  elif command -v free >/dev/null 2>&1; then
    # Linux: Swap 행의 used 열(MB)
    swap_used_mb="$(free -m 2>/dev/null | awk '/^Swap:/ {print $3}')"
  fi

  if [ -z "$swap_used_mb" ]; then
    # 못 재는 환경에서 배포를 막지 않는다 — 가드가 없던 것과 같은 상태일 뿐이고,
    # 여기서 중단하면 CI 같은 곳에서 배포 자체가 불가능해진다.
    echo "[deploy] 메모리를 측정할 수 없어 가드를 건너뜁니다(플랫폼 미지원)."
    return 0
  fi

  limit_mb="${DEPLOY_SWAP_LIMIT_MB:-8192}"
  echo "[deploy] 메모리 확인: 스왑 사용 ${swap_used_mb}MB (한계 ${limit_mb}MB)"
  if [ "$swap_used_mb" -lt "$limit_mb" ]; then
    return 0
  fi

  echo "" >&2
  echo "==========================================================================" >&2
  echo "[deploy] ✗ 중단 — 메모리 압박이 심해 지금 배포하면 위험합니다." >&2
  echo "" >&2
  echo "  스왑 사용 ${swap_used_mb}MB (한계 ${limit_mb}MB)" >&2
  echo "" >&2
  echo "  2026-09-05에 이 상태에서 배포하다 postgres가 죽었습니다(WAL로 복구됨)." >&2
  echo "  그 전날에는 빌드가 59분간 진행 없이 멈춰 섰습니다." >&2
  echo "" >&2
  echo "  할 일:" >&2
  echo "    1. 브라우저·에디터 등 큰 앱을 닫는다" >&2
  echo "    2. 그래도 높으면 Docker Desktop을 재시작한다(VM이 스왑을 잡고 있다)" >&2
  echo "    3. 다시 시도한다" >&2
  echo "" >&2
  echo "  위험을 알고 진행하려면:" >&2
  echo "    DEPLOY_SKIP_MEMORY_CHECK=true sh scripts/ops/deploy.sh" >&2
  echo "==========================================================================" >&2
  exit 3
}

check_memory

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

# --- OTA 번들 (네이티브 앱의 웹 자산) -----------------------------------------
#
# Docker 배포는 **브라우저로 접속하는 웹**만 갱신한다. 앱 안의 웹 자산은 별도 볼륨에
# 있어서 그대로 남는다 — 이 둘을 헷갈리면 "배포했는데 앱은 그대로"가 된다.
#
# 그래서 여기서 함께 올린다. 두 명령을 기억하게 두면 정확히 잊어버리기 좋은 모양이라,
# 잊을 수 있는 것을 구조로 없앤다(배포 래퍼를 만든 이유와 같다).
#
# 건너뛰려면 `DEPLOY_SKIP_OTA=true`. API·워커만 고쳤다면 웹 번들이 같으니 건너뛰어도
# 되지만, 기본은 **올리는 쪽**이다 — 빠뜨렸을 때의 대가(앱이 조용히 옛 화면)가
# 불필요한 번들 하나보다 크다.
if [ "${DEPLOY_SKIP_OTA:-false}" = "true" ]; then
  echo ""
  echo "[deploy] OTA 번들 건너뜀 (DEPLOY_SKIP_OTA=true)"
else
  echo ""
  echo "=========================================================================="
  echo "[deploy] OTA 웹 번들 배포 (앱용)"
  echo "=========================================================================="
  if sh "$script_dir/deploy-ota-bundle.sh"; then
    :
  else
    ota_status=$?
    echo "[deploy] ⚠ OTA 번들 배포 실패(exit $ota_status)." >&2
    echo "[deploy]   **서버 배포는 성공했다** — 브라우저 웹은 최신이고 앱만 옛 번들이다." >&2
    echo "[deploy]   고친 뒤 \`pnpm ota:deploy\` 로 번들만 다시 올리면 된다." >&2
    exit "$ota_status"
  fi
fi
