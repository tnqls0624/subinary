#!/bin/sh
set -eu

umask 077

backup_root=/backups
requested_snapshot="${BACKUP_SNAPSHOT:-latest}"
if [ "$requested_snapshot" = latest ]; then
  if [ ! -f "$backup_root/latest" ]; then
    echo "backup verification error: latest pointer is missing" >&2
    exit 66
  fi
  requested_snapshot="$(cat "$backup_root/latest")"
fi

case "$requested_snapshot" in
  20??????T??????Z) ;;
  *)
    echo "backup verification error: invalid snapshot name" >&2
    exit 64
    ;;
esac

snapshot_path="$backup_root/$requested_snapshot"
database_dump="$snapshot_path/postgres/database.dump"
storage_bucket="${STORAGE_BUCKET:-family-memory}"
storage_snapshot="$snapshot_path/minio/$storage_bucket"

if [ ! -f "$database_dump" ] || [ ! -f "$snapshot_path/SHA256SUMS" ]; then
  echo "backup verification error: required database dump or checksum manifest is missing" >&2
  exit 66
fi
if [ ! -d "$storage_snapshot" ]; then
  echo "backup verification error: MinIO snapshot is missing" >&2
  exit 66
fi

echo "backup verification started: snapshot=${requested_snapshot}"
(
  cd "$snapshot_path"
  sha256sum --quiet --check SHA256SUMS
)
pg_restore --list "$database_dump" >/dev/null

verify_root=/var/lib/postgresql/verify
socket_directory=/run/postgresql
verify_database=backup_restore_verification

find "$verify_root" -mindepth 1 -depth -delete
chown postgres:postgres "$verify_root" "$socket_directory"
gosu postgres initdb --pgdata="$verify_root" --auth=trust --no-locale >/dev/null

stop_postgres() {
  if [ -s "$verify_root/postmaster.pid" ]; then
    gosu postgres pg_ctl --pgdata="$verify_root" --mode=fast stop >/dev/null 2>&1 || true
  fi
}
trap stop_postgres EXIT HUP INT TERM

gosu postgres pg_ctl \
  --pgdata="$verify_root" \
  --options="-c listen_addresses='' -c unix_socket_directories='$socket_directory' -p 55432" \
  --wait start >/dev/null
createdb --host="$socket_directory" --port=55432 --username=postgres "$verify_database"
pg_restore \
  --host="$socket_directory" \
  --port=55432 \
  --username=postgres \
  --dbname="$verify_database" \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  "$database_dump"

table_count="$(psql \
  --host="$socket_directory" \
  --port=55432 \
  --username=postgres \
  --dbname="$verify_database" \
  --tuples-only \
  --no-align \
  --command="SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema');")"
case "$table_count" in
  ''|*[!0-9]*)
    echo "backup verification error: restored table count is invalid" >&2
    exit 65
    ;;
esac
if [ "$table_count" -eq 0 ]; then
  echo "backup verification error: restored database has no application tables" >&2
  exit 65
fi

object_count="$(find "$storage_snapshot" -type f | wc -l | tr -d ' ')"
echo "backup verification completed: snapshot=${requested_snapshot} restoredTables=${table_count} verifiedObjects=${object_count}"
