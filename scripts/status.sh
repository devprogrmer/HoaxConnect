#!/usr/bin/env bash
set -Eeuo pipefail

HC_MODE="text"
HC_INSTALL_ENV="/etc/hoaxconnect/install.env"
HC_CURRENT_LINK="/opt/hoaxconnect/current"
HC_API_ADDRESS="127.0.0.1:3100"
HC_VOLUME_NAME="hoaxconnect_pgdata"

hc_usage() {
  cat <<'EOF'
Usage:
  scripts/status.sh [--json]

Options:
  --json  Print machine-readable JSON.
  --help  Show this help.
EOF
}

hc_die() {
  printf '[ERROR] %s\n' "$*" >&2
  return 1
}

hc_path() {
  local path="$1"

  if [[ -n "${HC_ROOT_PREFIX:-}" ]]; then
    [[ "${HC_TEST_MODE:-0}" == "1" ]] ||
      hc_die "HC_ROOT_PREFIX requires HC_TEST_MODE=1."

    printf '%s%s\n' "${HC_ROOT_PREFIX%/}" "$path"
  else
    printf '%s\n' "$path"
  fi
}

hc_parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --json)
        HC_MODE="json"
        ;;
      --help|-h)
        hc_usage
        exit 0
        ;;
      *)
        hc_die "Unknown option: $1"
        ;;
    esac

    shift
  done
}

hc_read_metadata() {
  local file
  local key
  local value

  HC_DOMAIN="unavailable"
  HC_RELEASE="unavailable"
  HC_TLS_MODE="unavailable"

  file="$(hc_path "$HC_INSTALL_ENV")"
  [[ -r "$file" ]] || return 0

  while IFS='=' read -r key value; do
    case "$key" in
      DOMAIN) HC_DOMAIN="$value" ;;
      RELEASE_ID) HC_RELEASE="$value" ;;
      TLS_MODE) HC_TLS_MODE="$value" ;;

      # Secret values are intentionally ignored and redacted.
      POSTGRES_PASSWORD|JWT_ACCESS_SECRET|REFRESH_TOKEN_PEPPER) : ;;
    esac
  done < "$file"
}

hc_read_release() {
  local current
  local target

  current="$(hc_path "$HC_CURRENT_LINK")"

  if [[ -L "$current" ]]; then
    target="$(readlink -- "$current" || true)"
    [[ -z "$target" ]] || HC_RELEASE="${target##*/}"
  fi
}

hc_read_health() {
  HC_HEALTH="unavailable"

  command -v curl >/dev/null 2>&1 || return 0

  if curl --fail --silent --show-error --max-time 5 \
    "http://$HC_API_ADDRESS/api/v1/health/ready" \
    >/dev/null 2>&1
  then
    HC_HEALTH="ready"
  else
    HC_HEALTH="unhealthy"
  fi
}

hc_read_containers() {
  HC_CONTAINERS="unavailable"

  command -v docker >/dev/null 2>&1 || return 0

  HC_CONTAINERS="$(
    docker ps -a \
      --filter label=com.docker.compose.project=hoaxconnect \
      --format '{{.Names}}={{.Status}}' \
      2>/dev/null |
      paste -sd ';' -
  )"

  [[ -n "$HC_CONTAINERS" ]] || HC_CONTAINERS="unavailable"
}

hc_read_volume() {
  HC_VOLUME="unavailable"

  command -v docker >/dev/null 2>&1 || return 0

  HC_VOLUME="$(
    docker volume inspect "$HC_VOLUME_NAME" \
      --format '{{.Name}}:{{.Driver}}' \
      2>/dev/null ||
      true
  )"

  [[ -n "$HC_VOLUME" ]] || HC_VOLUME="unavailable"
}

hc_read_network() {
  local listeners

  HC_API_BINDING="unavailable"
  HC_POSTGRES_BINDING="not-published"

  command -v ss >/dev/null 2>&1 || return 0
  listeners="$(ss -ltnH 2>/dev/null || true)"

  if grep -Fq "$HC_API_ADDRESS" <<< "$listeners"; then
    HC_API_BINDING="$HC_API_ADDRESS"
  elif grep -Eq '(^|[[:space:]])[^[:space:]]*:3100([[:space:]]|$)' \
    <<< "$listeners"; then
    HC_API_BINDING="unsafe-non-loopback"
  else
    HC_API_BINDING="not-listening"
  fi

  if grep -Eq \
    '(^|[[:space:]])(0\.0\.0\.0|\[::\]|127\.0\.0\.1):5432([[:space:]]|$)' \
    <<< "$listeners"; then
    HC_POSTGRES_BINDING="published"
  fi
}

hc_read_certificate() {
  local certificate

  HC_CERTIFICATE="unavailable"

  [[ "$HC_DOMAIN" != "unavailable" ]] || return 0
  command -v openssl >/dev/null 2>&1 || return 0

  certificate="$(
    hc_path "/etc/letsencrypt/live/$HC_DOMAIN/fullchain.pem"
  )"

  [[ -r "$certificate" ]] || return 0

  HC_CERTIFICATE="$(
    openssl x509 -in "$certificate" -noout -enddate \
      2>/dev/null |
      sed 's/^notAfter=//' ||
      true
  )"

  [[ -n "$HC_CERTIFICATE" ]] ||
    HC_CERTIFICATE="unavailable"
}

hc_print_text() {
  cat <<EOF
HoaxConnect status
release: $HC_RELEASE
domain: $HC_DOMAIN
tls_mode: $HC_TLS_MODE
health: $HC_HEALTH
containers: $HC_CONTAINERS
certificate_expiry: $HC_CERTIFICATE
api_binding: $HC_API_BINDING
postgres_binding: $HC_POSTGRES_BINDING
database_volume: $HC_VOLUME
EOF
}

hc_print_json() {
  export \
    HC_RELEASE HC_DOMAIN HC_TLS_MODE HC_HEALTH \
    HC_CONTAINERS HC_CERTIFICATE HC_API_BINDING \
    HC_POSTGRES_BINDING HC_VOLUME

  python3 <<'PY'
import json
import os

keys = (
    "release",
    "domain",
    "tls_mode",
    "health",
    "containers",
    "certificate",
    "api_binding",
    "postgres_binding",
    "volume",
)

env = {
    "release": "HC_RELEASE",
    "domain": "HC_DOMAIN",
    "tls_mode": "HC_TLS_MODE",
    "health": "HC_HEALTH",
    "containers": "HC_CONTAINERS",
    "certificate": "HC_CERTIFICATE",
    "api_binding": "HC_API_BINDING",
    "postgres_binding": "HC_POSTGRES_BINDING",
    "volume": "HC_VOLUME",
}

print(json.dumps(
    {key: os.environ[env[key]] for key in keys},
    separators=(",", ":"),
    sort_keys=True,
))
PY
}

main() {
  hc_parse_args "$@"
  hc_read_metadata
  hc_read_release
  hc_read_health
  hc_read_containers
  hc_read_volume
  hc_read_network
  hc_read_certificate

  if [[ "$HC_MODE" == "json" ]]; then
    hc_print_json
  else
    hc_print_text
  fi
}

main "$@"
