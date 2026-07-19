#!/bin/sh
set -eu

training_run_id="${TRAINING_RUN_ID:-}"
case "$training_run_id" in
  ????????-????-????-????-????????????) ;;
  *)
    echo "training configuration error: TRAINING_RUN_ID must be a UUID" >&2
    exit 64
    ;;
esac
case "$training_run_id" in
  *[!0-9a-fA-F-]*)
    echo "training configuration error: TRAINING_RUN_ID must be a UUID" >&2
    exit 64
    ;;
esac

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/../.." && pwd)"
cd "$repository_root"

docker compose \
  --env-file .env \
  --env-file .env.production \
  -f docker-compose.prod.yml \
  --profile training \
  run --rm \
  -e TRAINING_RUN_ID="$training_run_id" \
  trainer
