#!/bin/sh
set -eu

umask 077

require_env() {
  variable_name="$1"
  eval "variable_value=\${$variable_name:-}"
  if [ -z "$variable_value" ]; then
    echo "backup replica configuration error: ${variable_name} is required" >&2
    exit 64
  fi
}

is_positive_integer() {
  case "${1:-}" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}

require_restic_configuration() {
  require_env RESTIC_REPOSITORY
  if [ -z "${RESTIC_PASSWORD:-}" ] && [ -z "${RESTIC_PASSWORD_FILE:-}" ]; then
    echo "backup replica configuration error: RESTIC_PASSWORD or RESTIC_PASSWORD_FILE is required" >&2
    exit 64
  fi
}

read_latest_snapshot() {
  if [ ! -f /backups/latest ]; then
    echo "backup replica error: local latest pointer is missing" >&2
    exit 66
  fi
  snapshot_name="$(cat /backups/latest)"
  case "$snapshot_name" in
    20??????T??????Z) ;;
    *) echo "backup replica error: invalid local snapshot name" >&2; exit 65 ;;
  esac
  snapshot_path="/backups/$snapshot_name"
  if [ ! -d "$snapshot_path" ] || [ ! -f "$snapshot_path/SHA256SUMS" ]; then
    echo "backup replica error: local snapshot is incomplete" >&2
    exit 66
  fi
  (
    cd "$snapshot_path"
    sha256sum --quiet --check SHA256SUMS
  )
}

require_repository() {
  if ! restic cat config >/dev/null 2>&1; then
    echo "backup replica error: repository is unavailable, uninitialized, or the password is incorrect" >&2
    exit 69
  fi
}

initialize_repository() {
  require_restic_configuration
  if restic cat config >/dev/null 2>&1; then
    echo "backup replica init: repository already initialized"
    return
  fi
  restic init >/dev/null
  echo "backup replica init: encrypted repository initialized"
}

run_check_if_due() {
  check_interval_days="${BACKUP_REPLICA_CHECK_INTERVAL_DAYS:-30}"
  if ! is_positive_integer "$check_interval_days"; then
    echo "backup replica configuration error: BACKUP_REPLICA_CHECK_INTERVAL_DAYS must be positive" >&2
    exit 64
  fi
  now_epoch="$(date +%s)"
  last_check_epoch="$(cat /state/last-check 2>/dev/null || true)"
  case "$last_check_epoch" in
    ''|*[!0-9]*) check_due=true ;;
    *)
      check_interval_seconds=$((check_interval_days * 86400))
      if [ $((now_epoch - last_check_epoch)) -ge "$check_interval_seconds" ]; then
        check_due=true
      else
        check_due=false
      fi
      ;;
  esac
  if [ "$check_due" = true ]; then
    restic check
    printf '%s\n' "$now_epoch" > /state/last-check.tmp
    mv /state/last-check.tmp /state/last-check
  fi
}

replicate_once() {
  require_restic_configuration
  require_repository
  read_latest_snapshot

  keep_daily="${BACKUP_REPLICA_KEEP_DAILY:-30}"
  keep_weekly="${BACKUP_REPLICA_KEEP_WEEKLY:-12}"
  keep_monthly="${BACKUP_REPLICA_KEEP_MONTHLY:-12}"
  for retention_value in "$keep_daily" "$keep_weekly" "$keep_monthly"; do
    if ! is_positive_integer "$retention_value"; then
      echo "backup replica configuration error: retention values must be positive" >&2
      exit 64
    fi
  done

  last_snapshot="$(cat /state/last-snapshot 2>/dev/null || true)"
  if [ "$last_snapshot" != "$snapshot_name" ]; then
    echo "backup replica started: snapshot=${snapshot_name}"
    # Docker Desktop의 macOS bind mount를 restic이 직접 순회하면 일부 VirtioFS
    # 조합에서 read EIO가 발생한다. checksum을 먼저 확인한 immutable 디렉터리를
    # tar stream으로 전달해 filesystem metadata 의존성을 제거한다.
    archive_pipe="/state/replica-${snapshot_name}-$$.pipe"
    mkfifo "$archive_pipe"
    tar -C /backups -cf - "$snapshot_name" > "$archive_pipe" &
    archive_pid=$!
    replica_status=0
    restic backup \
      --host subinary-production \
      --tag subinary-backup \
      --tag "snapshot-${snapshot_name}" \
      --stdin \
      --stdin-filename "/subinary/${snapshot_name}.tar" \
      < "$archive_pipe" || replica_status=$?
    wait "$archive_pid" || replica_status=$?
    rm -f "$archive_pipe"
    if [ "$replica_status" -ne 0 ]; then
      echo "backup replica error: snapshot archive upload failed" >&2
      exit "$replica_status"
    fi
    restic forget \
      --host subinary-production \
      --tag subinary-backup \
      --keep-daily "$keep_daily" \
      --keep-weekly "$keep_weekly" \
      --keep-monthly "$keep_monthly" \
      --prune
    printf '%s\n' "$snapshot_name" > /state/last-snapshot.tmp
    mv /state/last-snapshot.tmp /state/last-snapshot
  else
    echo "backup replica skipped: snapshot=${snapshot_name} already replicated"
  fi

  run_check_if_due
  date +%s > /state/last-success.tmp
  mv /state/last-success.tmp /state/last-success
  echo "backup replica completed: snapshot=${snapshot_name}"
}

verify_repository() {
  require_restic_configuration
  require_repository
  restic check
  find /restore -mindepth 1 -depth -delete
  restic restore latest --host subinary-production --tag subinary-backup --target /restore
  restored_archive="$(find /restore -type f -path '*/subinary/20??????T??????Z.tar' -print | head -n 1)"
  if [ -z "$restored_archive" ]; then
    echo "backup replica verification error: restored snapshot archive is missing" >&2
    exit 66
  fi
  restored_name="$(basename "$restored_archive" .tar)"
  case "$restored_name" in
    20??????T??????Z) ;;
    *) echo "backup replica verification error: restored snapshot name is invalid" >&2; exit 65 ;;
  esac
  mkdir -p /restore/unpacked
  tar -C /restore/unpacked -xf "$restored_archive"
  restored_snapshot="/restore/unpacked/$restored_name"
  if [ ! -f "$restored_snapshot/SHA256SUMS" ]; then
    echo "backup replica verification error: restored checksum manifest is missing" >&2
    exit 66
  fi
  (
    cd "$restored_snapshot"
    sha256sum --quiet --check SHA256SUMS
  )
  pg_restore --list "$restored_snapshot/postgres/database.dump" >/dev/null
  echo "backup replica verification completed: snapshot=${restored_name}"
}

run_daemon() {
  interval_seconds="${BACKUP_REPLICA_INTERVAL_SECONDS:-86400}"
  retry_seconds="${BACKUP_REPLICA_RETRY_SECONDS:-300}"
  if ! is_positive_integer "$interval_seconds" || ! is_positive_integer "$retry_seconds"; then
    echo "backup replica configuration error: interval and retry must be positive" >&2
    exit 64
  fi
  while true; do
    if replicate_once; then
      sleep "$interval_seconds"
    else
      echo "backup replica failed: retrying later" >&2
      sleep "$retry_seconds"
    fi
  done
}

mkdir -p /state
case "${1:-once}" in
  init) initialize_repository ;;
  once) replicate_once ;;
  verify) verify_repository ;;
  daemon) run_daemon ;;
  *) echo "usage: backup-replica.sh [init|once|verify|daemon]" >&2; exit 64 ;;
esac
