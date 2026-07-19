#!/bin/sh
set -eu

is_positive_integer() {
  case "${1:-}" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}

minimum_labels="${TRAINING_MIN_LABELS:-100}"
minimum_classes="${TRAINING_MIN_CLASSES:-3}"
minimum_labels_per_class="${TRAINING_MIN_LABELS_PER_CLASS:-10}"

for threshold in "$minimum_labels" "$minimum_classes" "$minimum_labels_per_class"; do
  if ! is_positive_integer "$threshold"; then
    echo "training readiness configuration error: thresholds must be positive integers" >&2
    exit 64
  fi
done

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/../.." && pwd)"
cd "$repository_root"

docker compose \
  --env-file .env \
  --env-file .env.production \
  -f docker-compose.prod.yml \
  exec -T postgres sh -lc \
  "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql \
    -U \"\$POSTGRES_USER\" \
    -d \"\$POSTGRES_DB\" \
    -v ON_ERROR_STOP=1 \
    -v minimum_labels=$minimum_labels \
    -v minimum_classes=$minimum_classes \
    -v minimum_labels_per_class=$minimum_labels_per_class \
    -P pager=off" \
  < scripts/ops/training-readiness.sql
