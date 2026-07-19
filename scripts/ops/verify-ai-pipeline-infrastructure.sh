#!/bin/sh
set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/../.." && pwd)"
cd "$repository_root"

fail() {
  echo "AI pipeline infrastructure verification failed: $*" >&2
  exit 1
}

compose() {
  docker compose \
    --env-file .env \
    --env-file .env.production \
    -f docker-compose.prod.yml \
    "$@"
}

container_id() {
  compose ps -a -q "$1"
}

container_state() {
  service_container_id="$(container_id "$1")"
  if [ -z "$service_container_id" ]; then
    echo "missing"
    return
  fi
  docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$service_container_id"
}

wait_for_state() {
  service_name="$1"
  expected_state="$2"
  timeout_seconds="${INFRA_HEALTH_TIMEOUT_SECONDS:-300}"
  elapsed_seconds=0

  while [ "$elapsed_seconds" -lt "$timeout_seconds" ]; do
    current_state="$(container_state "$service_name")"
    if [ "$current_state" = "$expected_state" ]; then
      echo "[infra] $service_name=$current_state"
      return
    fi
    case "$current_state" in
      exited|dead|unhealthy)
        fail "$service_name state is $current_state"
        ;;
    esac
    sleep 5
    elapsed_seconds=$((elapsed_seconds + 5))
  done

  fail "$service_name did not become $expected_state within ${timeout_seconds}s"
}

assert_completed_service() {
  service_name="$1"
  service_container_id="$(container_id "$service_name")"
  [ -n "$service_container_id" ] || fail "$service_name container is missing"
  completion="$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "$service_container_id")"
  [ "$completion" = "exited:0" ] || fail "$service_name completion is $completion"
  echo "[infra] $service_name=$completion"
}

env_configured() {
  awk -F= -v key="$1" '
    index($0, key "=") == 1 { value = substr($0, index($0, "=") + 1) }
    END { exit(length(value) > 0 ? 0 : 1) }
  ' .env .env.production
}

command -v docker >/dev/null 2>&1 || fail "docker command is unavailable"
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"
[ -f .env ] || fail ".env is missing"
[ -f .env.production ] || fail ".env.production is missing"
compose config --quiet || fail "production compose configuration is invalid"

for service_name in postgres redis api worker web backup; do
  wait_for_state "$service_name" healthy
done
for service_name in minio caddy cloudflared; do
  wait_for_state "$service_name" running
done
assert_completed_service minio-setup
assert_completed_service migrate

api_image="$(docker inspect --format '{{.Image}}' "$(container_id api)")"
worker_image="$(docker inspect --format '{{.Image}}' "$(container_id worker)")"
web_image="$(docker inspect --format '{{.Image}}' "$(container_id web)")"
[ "$api_image" = "$worker_image" ] || fail "api and worker images differ"
[ "$api_image" = "$web_image" ] || fail "api and web images differ"
echo "[infra] application_image=$api_image"

for service_name in postgres redis minio; do
  port_bindings="$(
    docker inspect \
      --format '{{json .HostConfig.PortBindings}}' \
      "$(container_id "$service_name")"
  )"
  [ "$port_bindings" = "{}" ] || fail "$service_name has published host ports: $port_bindings"
done
echo "[infra] stateful_ports=internal-only"

extension_count="$(
  compose exec -T postgres sh -lc \
    "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"select count(*) from pg_extension where extname in ('vector', 'pg_trgm', 'uuid-ossp')\""
)"
[ "$extension_count" = "3" ] || fail "required PostgreSQL extensions: $extension_count/3"

pipeline_table_count="$(
  compose exec -T postgres sh -lc \
    "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"select count(*) from (values ('pipeline_runs'), ('pipeline_step_runs'), ('ai_invocations'), ('feedback_events'), ('data_events'), ('lineage_edges'), ('dataset_snapshots'), ('evaluation_runs'), ('model_registry'), ('training_runs'), ('operational_alerts')) as expected(name) where to_regclass('public.' || expected.name) is not null\""
)"
[ "$pipeline_table_count" = "11" ] || fail "AI pipeline control tables: $pipeline_table_count/11"
echo "[infra] postgres_extensions=3/3 pipeline_tables=11/11"

redis_response="$(compose exec -T redis redis-cli ping)"
[ "$redis_response" = "PONG" ] || fail "Redis ping returned $redis_response"
echo "[infra] redis=PONG"

public_base_url="$(
  awk -F= '
    /^PUBLIC_BASE_URL=/ { value = substr($0, index($0, "=") + 1) }
    END { print value }
  ' .env .env.production
)"
[ -n "$public_base_url" ] || fail "PUBLIC_BASE_URL is missing"
curl -fsS -o /dev/null "$public_base_url/api/health" || fail "public web health failed"
curl -fsS -o /dev/null "$public_base_url/v1/health/ready" || fail "public API readiness failed"
echo "[infra] public_routes=healthy"

if env_configured PIPELINE_ALERT_WEBHOOK_URL; then
  echo "[infra] alert_webhook=configured"
else
  echo "[infra] alert_webhook=not-configured (optional external target)"
fi
if env_configured RESTIC_REPOSITORY && env_configured RESTIC_PASSWORD; then
  echo "[infra] offsite_backup=configured"
else
  echo "[infra] offsite_backup=not-configured (optional external repository)"
fi

sh scripts/ops/training-readiness.sh
echo "[infra] AI pipeline infrastructure verification completed"
