#!/bin/sh
set -eu

interval_seconds="${BACKUP_REPLICA_INTERVAL_SECONDS:-86400}"
retry_seconds="${BACKUP_REPLICA_RETRY_SECONDS:-300}"
last_success="$(cat /state/last-success 2>/dev/null || true)"
case "$interval_seconds" in ''|*[!0-9]*|0) exit 1 ;; esac
case "$retry_seconds" in ''|*[!0-9]*|0) exit 1 ;; esac
case "$last_success" in ''|*[!0-9]*) exit 1 ;; esac
now_epoch="$(date +%s)"
maximum_age=$((interval_seconds + retry_seconds * 3 + 900))
[ $((now_epoch - last_success)) -le "$maximum_age" ]
