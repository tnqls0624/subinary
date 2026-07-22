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

  echo "[infra] building production application, backup, and ops sentinel images"
  compose build api backup ops-sentinel
fi

echo "[infra] starting production AI pipeline infrastructure"
compose up -d \
  postgres redis minio minio-setup migrate backup ops-sentinel \
  api worker web caddy cloudflared

sh scripts/ops/verify-ai-pipeline-infrastructure.sh
