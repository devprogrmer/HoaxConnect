#!/usr/bin/env bash

# HoaxConnect Docker Compose helpers.

HC_COMPOSE_ROOT="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." &&
  pwd -P
)"
HC_COMPOSE_FILE="$HC_COMPOSE_ROOT/deploy/compose/compose.source.yml"
HC_COMPOSE_PROJECT="hoaxconnect"

hc_compose() {
  local actual_env

  hc_load_install_config || return 1
  hc_require_command docker || return 1

  if ! docker compose version >/dev/null 2>&1; then
    hc_die "Docker Compose v2 is required."
    return 1
  fi

  if [[ ! -f "$HC_COMPOSE_FILE" ]]; then
    hc_die "Compose file is unavailable: $HC_COMPOSE_FILE"
    return 1
  fi

  actual_env="$(hc_path "$HC_ENV_FILE")" || return 1

  if [[ ! -f "$actual_env" ]]; then
    hc_die "Backend environment file is unavailable."
    return 1
  fi

  HC_ENV_FILE="$actual_env" \
    docker compose \
      --project-name "$HC_COMPOSE_PROJECT" \
      --env-file "$actual_env" \
      --file "$HC_COMPOSE_FILE" \
      "$@"
}

hc_wait_service() {
  local service="${1:-}"
  local timeout_seconds="${2:-}"
  local started_at
  local container_id
  local state

  if [[ -z "$service" ||
        ! "$timeout_seconds" =~ ^[0-9]+$ ||
        "$timeout_seconds" -lt 1 ]]; then
    hc_die "Service name and positive timeout are required."
    return 1
  fi

  started_at="$SECONDS"

  while (( SECONDS - started_at < timeout_seconds )); do
    container_id="$(
      hc_compose ps -q "$service" 2>/dev/null |
        head -n 1
    )"

    if [[ -n "$container_id" ]]; then
      state="$(
        docker inspect \
          --format \
          '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
          "$container_id" 2>/dev/null ||
        true
      )"

      case "$state" in
        healthy|running)
          return 0
          ;;
        unhealthy|exited|dead)
          hc_die "Service failed readiness: $service ($state)"
          return 1
          ;;
      esac
    fi

    sleep 1
  done

  hc_die "Timed out waiting for service: $service"
  return 1
}

hc_verify_network_boundaries() {
  local temporary
  local result=0

  hc_require_command python3 || return 1

  temporary="$(mktemp)"

  if ! hc_compose config --format json > "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi

  python3 - "$temporary" <<'PY_VERIFY_NETWORK_JSON' || result=$?
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

services = data.get("services", {})
postgres = services.get("postgres", {})
api = services.get("api", {})

if postgres.get("ports"):
    raise SystemExit("PostgreSQL must not publish a host port")

ports = api.get("ports", [])

if len(ports) != 1:
    raise SystemExit("API must publish exactly one port")

port = ports[0]

if (
    str(port.get("target")) != "3100"
    or str(port.get("published")) != "3100"
    or port.get("host_ip") != "127.0.0.1"
):
    raise SystemExit("API must publish only 127.0.0.1:3100:3100")

networks = data.get("networks", {})
backend = networks.get("backend", {})

if backend.get("internal") is not True:
    raise SystemExit("Backend network must be internal")

volumes = data.get("volumes", {})
volume = volumes.get("hoaxconnect_pgdata", {})

if volume.get("name") != "hoaxconnect_pgdata":
    raise SystemExit("Persistent database volume name is invalid")
PY_VERIFY_NETWORK_JSON

  rm -f -- "$temporary"

  if [[ "$result" -ne 0 ]]; then
    hc_die "Compose network boundary verification failed."
    return "$result"
  fi
}
