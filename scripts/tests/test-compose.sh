#!/usr/bin/env bash
set -Eeuo pipefail

HC_TEST_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
  pwd -P
)"
HC_ROOT="$(
  cd -- "$HC_TEST_DIR/../.." &&
  pwd -P
)"
HC_COMMON="$HC_ROOT/scripts/lib/common.sh"
HC_CONFIG="$HC_ROOT/scripts/lib/config.sh"
HC_COMPOSE_LIBRARY="$HC_ROOT/scripts/lib/compose.sh"
HC_COMPOSE_TEMPLATE="$HC_ROOT/deploy/compose/compose.source.yml"

# shellcheck disable=SC1090,SC1091
source "$HC_TEST_DIR/assert.sh"

if [[ ! -f "$HC_COMPOSE_LIBRARY" ]]; then
  printf 'EXPECTED RED: compose library missing: %s\n' \
    "$HC_COMPOSE_LIBRARY" >&2
  exit 1
fi

if [[ ! -f "$HC_COMPOSE_TEMPLATE" ]]; then
  printf 'EXPECTED RED: compose template missing: %s\n' \
    "$HC_COMPOSE_TEMPLATE" >&2
  exit 1
fi

# shellcheck disable=SC1090,SC1091
source "$HC_COMMON"

# shellcheck disable=SC1090,SC1091
source "$HC_CONFIG"

# shellcheck disable=SC1090,SC1091
source "$HC_COMPOSE_LIBRARY"

HC_CASE_ROOT=""

hc_compose_setup() {
  HC_CASE_ROOT="$(mktemp -d)"

  export HC_TEST_MODE=1
  export HC_ROOT_PREFIX="$HC_CASE_ROOT"
  export HC_DOMAIN="api.example.com"
  export HC_ADMIN_ORIGIN="https://admin.example.com"
  export HC_RELEASE_ID="0123456789abcdef0123456789abcdef01234567"
  export HC_RELEASE_DIR="/opt/hoaxconnect/releases/$HC_RELEASE_ID"
  export HC_ENV_FILE="/etc/hoaxconnect/backend.env"
  export HC_TLS_MODE="required"

  mkdir -p \
    "$HC_CASE_ROOT/etc/hoaxconnect" \
    "$HC_CASE_ROOT$HC_RELEASE_DIR/backend"

  hc_load_install_config
  hc_write_backend_env
}

hc_compose_cleanup() {
  if [[ -n "${HC_CASE_ROOT:-}" &&
        "$HC_CASE_ROOT" == /tmp/* ]]; then
    rm -rf -- "$HC_CASE_ROOT"
  fi

  HC_CASE_ROOT=""
}

test_compose_contract() {
  hc_compose_setup

  local json_file="$HC_CASE_ROOT/compose.json"

  hc_compose config --format json > "$json_file"

  python3 \
    - "$json_file" "$HC_RELEASE_DIR" "$HC_RELEASE_ID" \
    <<'PY_VALIDATE_COMPOSE_JSON'
import json
import sys

path, release_dir, release_id = sys.argv[1:]

with open(path, encoding="utf-8") as handle:
    data = json.load(handle)

assert data.get("name") == "hoaxconnect", data.get("name")

services = data["services"]
postgres = services["postgres"]
api = services["api"]

assert not postgres.get("ports"), postgres.get("ports")

ports = api.get("ports", [])
assert len(ports) == 1, ports

port = ports[0]
assert str(port.get("target")) == "3100", port
assert str(port.get("published")) == "3100", port
assert port.get("host_ip") == "127.0.0.1", port

build = api.get("build", {})
expected_context = f"{release_dir}/backend"

assert build.get("context") == expected_context, build
assert api.get("image") == (
    f"hoaxconnect-api:{release_id}"
), api.get("image")

assert int(postgres.get("mem_limit")) == 536870912, (
    postgres.get("mem_limit")
)
assert int(api.get("mem_limit")) == 268435456, (
    api.get("mem_limit")
)

assert float(postgres.get("cpus")) == 1.5, (
    postgres.get("cpus")
)
assert float(api.get("cpus")) == 1.0, api.get("cpus")

volumes = data.get("volumes", {})
assert "hoaxconnect_pgdata" in volumes, volumes
assert volumes["hoaxconnect_pgdata"].get("name") == (
    "hoaxconnect_pgdata"
), volumes

networks = data.get("networks", {})
backend = networks.get("backend", {})
assert backend.get("internal") is True, backend

edge = networks.get("edge", {})
assert edge.get("internal") is not True, edge

postgres_networks = set(postgres.get("networks", {}))
api_networks = set(api.get("networks", {}))

assert postgres_networks == {"backend"}, postgres_networks
assert api_networks == {"backend", "edge"}, api_networks
PY_VALIDATE_COMPOSE_JSON

  hc_verify_network_boundaries
  hc_compose_cleanup
}

main() {
  test_compose_contract
  printf 'PASS: test_compose_contract\n'
  printf 'ALL COMPOSE TESTS PASSED\n'
}

trap hc_compose_cleanup EXIT
main "$@"
