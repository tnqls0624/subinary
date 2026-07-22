#!/bin/sh
set -eu

is_positive_integer() {
  case "${1:-}" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}

run_daemon() {
  interval_seconds="${BACKUP_INTERVAL_SECONDS:-86400}"
  retry_seconds="${BACKUP_RETRY_SECONDS:-300}"

  if ! is_positive_integer "$interval_seconds"; then
    echo "backup configuration error: BACKUP_INTERVAL_SECONDS must be a positive integer" >&2
    exit 64
  fi
  if ! is_positive_integer "$retry_seconds"; then
    echo "backup configuration error: BACKUP_RETRY_SECONDS must be a positive integer" >&2
    exit 64
  fi

  while true; do
    if [ -f /backups/.last-success ]; then
      now_epoch="$(date +%s)"
      last_success_epoch="$(cat /backups/.last-success 2>/dev/null || true)"
      case "$last_success_epoch" in
        ''|*[!0-9]*) wait_seconds=0 ;;
        *)
          elapsed_seconds=$((now_epoch - last_success_epoch))
          if [ "$elapsed_seconds" -lt "$interval_seconds" ]; then
            wait_seconds=$((interval_seconds - elapsed_seconds))
          else
            wait_seconds=0
          fi
          ;;
      esac
      if [ "$wait_seconds" -gt 0 ]; then
        echo "backup schedule: next run in ${wait_seconds}s"
        sleep "$wait_seconds"
      fi
    fi

    if /usr/local/bin/backup-once.sh; then
      sleep "$interval_seconds"
    else
      # 실패/성공 핑은 backup-once.sh가 on_exit trap으로 대칭 처리한다(once 모드도 동일). 여기선 재시도만.
      echo "backup failed: retrying in ${retry_seconds}s" >&2
      sleep "$retry_seconds"
    fi
  done
}

case "${1:-daemon}" in
  daemon) run_daemon ;;
  once) exec /usr/local/bin/backup-once.sh ;;
  verify) exec /usr/local/bin/verify-backup.sh ;;
  replica-daemon) exec /usr/local/bin/backup-replica.sh daemon ;;
  replica-init) exec /usr/local/bin/backup-replica.sh init ;;
  replica-once) exec /usr/local/bin/backup-replica.sh once ;;
  replica-verify) exec /usr/local/bin/backup-replica.sh verify ;;
  *)
    echo "usage: backup-entrypoint.sh [daemon|once|verify|replica-daemon|replica-init|replica-once|replica-verify]" >&2
    exit 64
    ;;
esac
