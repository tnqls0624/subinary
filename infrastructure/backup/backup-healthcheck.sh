#!/bin/sh
set -eu

interval_seconds="${BACKUP_INTERVAL_SECONDS:-86400}"
case "$interval_seconds" in
  ''|*[!0-9]*|0) exit 1 ;;
esac

[ -f /backups/.last-success ] || exit 1
last_success_epoch="$(cat /backups/.last-success)"
case "$last_success_epoch" in
  ''|*[!0-9]*) exit 1 ;;
esac

now_epoch="$(date +%s)"
maximum_age_seconds=$((interval_seconds + 3600))
age_seconds=$((now_epoch - last_success_epoch))
[ "$age_seconds" -ge 0 ] && [ "$age_seconds" -le "$maximum_age_seconds" ]
