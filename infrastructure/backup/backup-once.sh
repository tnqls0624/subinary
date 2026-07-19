#!/bin/sh
set -eu

umask 077

require_env() {
  variable_name="$1"
  eval "variable_value=\${$variable_name:-}"
  if [ -z "$variable_value" ]; then
    echo "backup configuration error: ${variable_name} is required" >&2
    exit 64
  fi
}

is_non_negative_integer() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

for variable_name in \
  POSTGRES_HOST POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB \
  STORAGE_ENDPOINT STORAGE_ACCESS_KEY STORAGE_SECRET_KEY STORAGE_BUCKET
do
  require_env "$variable_name"
done

case "$POSTGRES_PORT" in
  *[!0-9]*|'')
    echo "backup configuration error: POSTGRES_PORT must be an integer" >&2
    exit 64
    ;;
esac

case "$STORAGE_BUCKET" in
  *[!a-z0-9.-]*|'')
    echo "backup configuration error: STORAGE_BUCKET contains invalid characters" >&2
    exit 64
    ;;
esac

retention_days="${BACKUP_RETENTION_DAYS:-30}"
if ! is_non_negative_integer "$retention_days"; then
  echo "backup configuration error: BACKUP_RETENTION_DAYS must be a non-negative integer" >&2
  exit 64
fi

backup_root=/backups
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot_name="$timestamp"
temporary_snapshot="${backup_root}/.incomplete-${timestamp}-$$"
final_snapshot="${backup_root}/${snapshot_name}"

cleanup() {
  if [ -d "$temporary_snapshot" ]; then
    find "$temporary_snapshot" -depth -delete
  fi
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$backup_root"
if [ -e "$final_snapshot" ]; then
  echo "backup error: snapshot already exists: ${snapshot_name}" >&2
  exit 73
fi
mkdir -p "$temporary_snapshot/postgres" "$temporary_snapshot/minio/$STORAGE_BUCKET"

echo "backup started: snapshot=${snapshot_name}"
export PGPASSWORD="$POSTGRES_PASSWORD"
pg_dump \
  --host="$POSTGRES_HOST" \
  --port="$POSTGRES_PORT" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --file="$temporary_snapshot/postgres/database.dump"
pg_restore --list "$temporary_snapshot/postgres/database.dump" \
  > "$temporary_snapshot/postgres/database.contents"

mc alias set backup-source "$STORAGE_ENDPOINT" "$STORAGE_ACCESS_KEY" "$STORAGE_SECRET_KEY" >/dev/null
mc mirror --quiet --overwrite \
  "backup-source/$STORAGE_BUCKET" \
  "$temporary_snapshot/minio/$STORAGE_BUCKET" \
  >/dev/null

database_bytes="$(wc -c < "$temporary_snapshot/postgres/database.dump" | tr -d ' ')"
object_count="$(find "$temporary_snapshot/minio/$STORAGE_BUCKET" -type f | wc -l | tr -d ' ')"
object_bytes="$(find "$temporary_snapshot/minio/$STORAGE_BUCKET" -type f -exec wc -c {} \; | awk '{ total += $1 } END { print total + 0 }')"

cat > "$temporary_snapshot/metadata.json" <<EOF
{"formatVersion":1,"createdAt":"${timestamp}","postgresDatabase":"${POSTGRES_DB}","postgresBytes":${database_bytes},"storageBucket":"${STORAGE_BUCKET}","objectCount":${object_count},"objectBytes":${object_bytes}}
EOF

(
  cd "$temporary_snapshot"
  find . -type f ! -name SHA256SUMS -exec sha256sum {} \; \
    | LC_ALL=C sort -k2 > SHA256SUMS
)

mv "$temporary_snapshot" "$final_snapshot"
trap - EXIT HUP INT TERM
printf '%s\n' "$snapshot_name" > "$backup_root/.latest.tmp"
mv "$backup_root/.latest.tmp" "$backup_root/latest"
date +%s > "$backup_root/.last-success.tmp"
mv "$backup_root/.last-success.tmp" "$backup_root/.last-success"

# 최신 성공 스냅샷을 만든 뒤에만 보존 기간이 지난 정확한 스냅샷 디렉터리를 제거한다.
if [ "$retention_days" -gt 0 ]; then
  for candidate in "$backup_root"/20??????T??????Z; do
    [ -d "$candidate" ] || continue
    [ "$candidate" != "$final_snapshot" ] || continue
    case "$candidate" in
      /backups/20??????T??????Z)
        if find "$candidate" -maxdepth 0 -mtime "+$retention_days" | grep -q .; then
          echo "backup retention: pruning $(basename "$candidate")"
          find "$candidate" -depth -delete
        fi
        ;;
    esac
  done
fi

echo "backup completed: snapshot=${snapshot_name} postgresBytes=${database_bytes} objectCount=${object_count} objectBytes=${object_bytes}"
