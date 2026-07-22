#!/bin/sh
set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/../.." && pwd)"
cd "$repository_root"

skip_build=false
case "${1:-}" in
  '') ;;
  --skip-build) skip_build=true ;;
  *)
    echo "usage: $0 [--skip-build]" >&2
    exit 64
    ;;
esac

command -v docker >/dev/null 2>&1 || {
  echo "AI pipeline infrastructure bootstrap failed: docker is unavailable" >&2
  exit 1
}
docker info >/dev/null 2>&1 || {
  echo "AI pipeline infrastructure bootstrap failed: Docker daemon is unavailable" >&2
  exit 1
}
[ -f .env ] || {
  echo "AI pipeline infrastructure bootstrap failed: .env is missing" >&2
  exit 1
}
[ -f .env.production ] || {
  echo "AI pipeline infrastructure bootstrap failed: .env.production is missing" >&2
  exit 1
}

compose() {
  docker compose \
    --env-file .env \
    --env-file .env.production \
    -f docker-compose.prod.yml \
    "$@"
}

compose config --quiet

if [ "$skip_build" = false ]; then
  minimum_free_disk_gb="${INFRA_MINIMUM_FREE_DISK_GB:-40}"
  case "$minimum_free_disk_gb" in
    ''|*[!0-9]*)
      echo "AI pipeline infrastructure bootstrap failed: INFRA_MINIMUM_FREE_DISK_GB must be a non-negative integer" >&2
      exit 64
      ;;
  esac

  available_disk_kb="$(df -Pk "$repository_root" | awk 'NR == 2 { print $4 }')"
  required_disk_kb=$((minimum_free_disk_gb * 1024 * 1024))
  if [ "$available_disk_kb" -lt "$required_disk_kb" ]; then
    available_disk_gb=$((available_disk_kb / 1024 / 1024))
    echo "AI pipeline infrastructure bootstrap failed: ${available_disk_gb}GB free, ${minimum_free_disk_gb}GB required for image build" >&2
    echo "Inspect with 'docker system df'; remove only confirmed unused build cache/images before retrying." >&2
    echo "Use --skip-build only when restoring the already verified image." >&2
    exit 1
  fi
  echo "[infra] build_disk_free=$((available_disk_kb / 1024 / 1024))GB minimum=${minimum_free_disk_gb}GB"

  # 배포 이미지를 git 커밋과 대응시켜 재현성을 확보한다. dirty tree는 어떤 커밋으로도 재현 불가한
  # 이미지를 만들므로 기본 차단하고, 의도적일 때만 INFRA_ALLOW_DIRTY_BUILD=true로 -dirty 태그 허용.
  git_sha="untracked"
  if git rev-parse --short=12 HEAD >/dev/null 2>&1; then
    git_sha="$(git rev-parse --short=12 HEAD)"
    if [ -n "$(git status --porcelain)" ]; then
      if [ "${INFRA_ALLOW_DIRTY_BUILD:-false}" = "true" ]; then
        git_sha="${git_sha}-dirty"
        echo "[infra] WARNING: dirty tree — ${git_sha} 로 빌드(INFRA_ALLOW_DIRTY_BUILD=true)" >&2
      else
        echo "AI pipeline infrastructure bootstrap failed: 커밋되지 않은 변경이 있어 재현 불가한 이미지가 만들어진다." >&2
        echo "커밋 후 다시 빌드하거나, 의도적이면 INFRA_ALLOW_DIRTY_BUILD=true로 재실행하라(태그에 -dirty 표기)." >&2
        exit 1
      fi
    fi
  else
    echo "[infra] WARNING: git 저장소가 아니라 커밋 태깅을 건너뛴다" >&2
  fi

  echo "[infra] building production application, backup, and ops sentinel images"
  compose build api backup ops-sentinel

  # 앱 이미지(api/worker/web 공유)에 git-sha 별칭 태그를 붙인다. 런타임 참조는 :local 유지(수동 compose 호환).
  # 롤백: docker tag family-memory-ai/prod:<이전sha> family-memory-ai/prod:local && bootstrap --skip-build
  if [ "$git_sha" != "untracked" ]; then
    docker tag family-memory-ai/prod:local "family-memory-ai/prod:${git_sha}"
    echo "[infra] tagged app image: family-memory-ai/prod:${git_sha}"
  fi
fi

echo "[infra] starting production AI pipeline infrastructure"
# 서비스를 명시 나열하지 않는다 — 프로필 없는 상시 서비스 전체(gatus·socket-proxy·dozzle 포함)를
# 자동 기동해 신규 서비스 추가 시 이 목록을 갱신하지 않아도 되게 한다. training/offsite-backup/ops 프로필은 제외됨.
compose up -d

sh scripts/ops/verify-ai-pipeline-infrastructure.sh
