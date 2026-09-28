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
HC_INSTALLER="$HC_ROOT/scripts/install.sh"

# shellcheck disable=SC1090,SC1091
source "$HC_TEST_DIR/assert.sh"

if [[ ! -x "$HC_INSTALLER" ]]; then
  printf 'EXPECTED RED: installer unavailable: %s\n' \
    "$HC_INSTALLER" >&2
  exit 1
fi

HC_ORIGINAL_PATH="$PATH"
HC_CASE_TEMP=""
HC_CASE_ROOT=""
HC_FAKE_BIN=""
HC_COMMAND_LOG=""
HC_RELEASE_ID=""
HC_WORKTREE_SECRET=""

hc_transaction_setup() {
  hc_transaction_cleanup

  HC_CASE_TEMP="$(mktemp -d)"
  HC_CASE_ROOT="$HC_CASE_TEMP/root"
  HC_FAKE_BIN="$HC_CASE_TEMP/fake-bin"
  HC_COMMAND_LOG="$HC_CASE_TEMP/commands.log"
  HC_RELEASE_ID="$(git -C "$HC_ROOT" rev-parse HEAD)"
  HC_WORKTREE_SECRET="$HC_ROOT/.env.task4-transaction-test"

  mkdir -p \
    "$HC_FAKE_BIN" \
    "$HC_CASE_ROOT/etc" \
    "$HC_CASE_ROOT/etc/hoaxconnect" \
    "$HC_CASE_ROOT/etc/nginx/sites-available" \
    "$HC_CASE_ROOT/etc/nginx/sites-enabled" \
    "$HC_CASE_ROOT/etc/letsencrypt/live/api.example.com" \
    "$HC_CASE_ROOT/opt/hoaxconnect/releases" \
    "$HC_CASE_ROOT/var/lib/hoaxconnect/acme" \
    "$HC_CASE_ROOT/var/lib/hoaxconnect/updates" \
    "$HC_CASE_ROOT/var/log/hoaxconnect"

  cat > "$HC_CASE_ROOT/etc/os-release" <<'OS_RELEASE'
ID=ubuntu
VERSION_ID="24.04"
OS_RELEASE

  : > "$HC_COMMAND_LOG"

  cat > "$HC_FAKE_BIN/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail

printf 'docker %s\n' "$*" >> "${HC_COMMAND_LOG:?}"

if [[ -n "${HC_FAKE_DOCKER_FAIL_PATTERN:-}" &&
      " $* " == *"${HC_FAKE_DOCKER_FAIL_PATTERN}"* ]]; then
  exit 41
fi

if [[ "${1:-}" == "inspect" ]]; then
  printf '%s\n' healthy
  exit 0
fi

if [[ "${1:-}" != "compose" ]]; then
  exit 0
fi

case " $* " in
  *" version "*)
    printf '%s\n' "Docker Compose version v2.test"
    ;;
  *" config --format json "*)
    cat <<JSON
{
  "name": "hoaxconnect",
  "services": {
    "postgres": {
      "ports": null,
      "mem_limit": 536870912,
      "cpus": 1.5
    },
    "api": {
      "build": {
        "context": "${HC_RELEASE_DIR}/backend"
      },
      "image": "hoaxconnect-api:${HC_RELEASE_ID}",
      "ports": [
        {
          "target": 3100,
          "published": "3100",
          "host_ip": "127.0.0.1"
        }
      ],
      "mem_limit": 268435456,
      "cpus": 1.0
    }
  },
  "networks": {
    "backend": {
      "internal": true
    }
  },
  "volumes": {
    "hoaxconnect_pgdata": {
      "name": "hoaxconnect_pgdata"
    }
  }
}
JSON
    ;;
  *" ps -q postgres "*)
    printf '%s\n' fake-postgres-container
    ;;
  *" ps -q api "*)
    printf '%s\n' fake-api-container
    ;;
esac
FAKE_DOCKER

  cat > "$HC_FAKE_BIN/nginx" <<'FAKE_NGINX'
#!/usr/bin/env bash
printf 'nginx %s\n' "$*" >> "${HC_COMMAND_LOG:?}"
exit "${HC_FAKE_NGINX_RESULT:-0}"
FAKE_NGINX

  cat > "$HC_FAKE_BIN/systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "${HC_COMMAND_LOG:?}"
exit 0
FAKE_SYSTEMCTL

  cat > "$HC_FAKE_BIN/certbot" <<'FAKE_CERTBOT'
#!/usr/bin/env bash
printf 'certbot %s\n' "$*" >> "${HC_COMMAND_LOG:?}"
exit "${HC_FAKE_CERTBOT_RESULT:-0}"
FAKE_CERTBOT

  cat > "$HC_FAKE_BIN/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "${HC_COMMAND_LOG:?}"
printf '%s\n' \
  '{"status":"ready","service":"hoaxconnect-backend","database":"ready"}'
exit "${HC_FAKE_CURL_RESULT:-0}"
FAKE_CURL

  chmod 0700 \
    "$HC_FAKE_BIN/docker" \
    "$HC_FAKE_BIN/nginx" \
    "$HC_FAKE_BIN/systemctl" \
    "$HC_FAKE_BIN/certbot" \
    "$HC_FAKE_BIN/curl"

  export PATH="$HC_FAKE_BIN:$HC_ORIGINAL_PATH"
  export HC_TEST_MODE=1
  export HC_ROOT_PREFIX="$HC_CASE_ROOT"
  export HC_LOCK_FILE="$HC_CASE_TEMP/deploy.lock"
  export HC_INSTALL_EUID_OVERRIDE=0
  export HC_INSTALL_OS_RELEASE="/etc/os-release"
  export HC_SKIP_DNS_CHECK=1
  export HC_SKIP_PORT_CHECK=1
  export HC_SKIP_RESOURCE_CHECKS=1
  export HC_NGINX_BIN="$HC_FAKE_BIN/nginx"
  export HC_SYSTEMCTL_BIN="$HC_FAKE_BIN/systemctl"
  export HC_CERTBOT_BIN="$HC_FAKE_BIN/certbot"
  export HC_COMMAND_LOG
  export HC_FAKE_DOCKER_FAIL_PATTERN=""
  export HC_FAKE_NGINX_RESULT=0
  export HC_FAKE_CERTBOT_RESULT=0
  export HC_FAKE_CURL_RESULT=0
}

hc_transaction_cleanup() {
  PATH="$HC_ORIGINAL_PATH"
  export PATH

  if [[ -n "${HC_WORKTREE_SECRET:-}" &&
        -f "$HC_WORKTREE_SECRET" ]]; then
    if [[ "$(cat "$HC_WORKTREE_SECRET")" == "task4-transaction-test-secret" ]]; then
      rm -f -- "$HC_WORKTREE_SECRET"
    else
      printf 'FAIL: refusing to remove unknown test secret file\n' >&2
      return 1
    fi
  fi

  if [[ -n "${HC_CASE_TEMP:-}" &&
        "$HC_CASE_TEMP" == /tmp/* ]]; then
    rm -rf -- "$HC_CASE_TEMP"
  fi

  HC_CASE_TEMP=""
  HC_CASE_ROOT=""
  HC_FAKE_BIN=""
  HC_COMMAND_LOG=""
  HC_RELEASE_ID=""
  HC_WORKTREE_SECRET=""

  unset \
    HC_TEST_MODE \
    HC_ROOT_PREFIX \
    HC_LOCK_FILE \
    HC_INSTALL_EUID_OVERRIDE \
    HC_INSTALL_OS_RELEASE \
    HC_SKIP_DNS_CHECK \
    HC_SKIP_PORT_CHECK \
    HC_SKIP_RESOURCE_CHECKS \
    HC_NGINX_BIN \
    HC_SYSTEMCTL_BIN \
    HC_CERTBOT_BIN \
    HC_FAKE_DOCKER_FAIL_PATTERN \
    HC_FAKE_NGINX_RESULT \
    HC_FAKE_CERTBOT_RESULT \
    HC_FAKE_CURL_RESULT || true
}

hc_run_apply() {
  "$HC_INSTALLER" \
    --domain api.example.com \
    --email admin@example.com \
    --source-ref HEAD \
    --admin-origin https://admin.example.com \
    "$@"
}

hc_expect_apply_failure() {
  local output
  local status

  set +e
  output="$(hc_run_apply "$@" 2>&1)"
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    printf 'FAIL: expected installer transaction failure\n' >&2
    return 1
  fi

  printf '%s\n' "$output"
}

hc_assert_symlink_target() {
  local path="$1"
  local expected="$2"

  if [[ ! -L "$path" ]]; then
    hc_test_fail "expected symlink is absent: $path"
    return 1
  fi

  hc_assert_equal "$expected" "$(readlink -- "$path")"
}

test_successful_transaction_activates_release() {
  hc_transaction_setup

  local output
  local release="$HC_CASE_ROOT/opt/hoaxconnect/releases/$HC_RELEASE_ID"

  output="$(hc_run_apply 2>&1)" || return 1

  hc_assert_contains "$output" "Installation completed"
  hc_assert_file_exists "$release/backend/package.json"
  hc_assert_file_exists \
    "$HC_CASE_ROOT/etc/hoaxconnect/backend.env"
  hc_assert_file_exists \
    "$HC_CASE_ROOT/etc/hoaxconnect/install.env"

  hc_assert_equal \
    "600" \
    "$(stat -c '%a' "$HC_CASE_ROOT/etc/hoaxconnect/backend.env")"

  hc_assert_equal \
    "600" \
    "$(stat -c '%a' "$HC_CASE_ROOT/etc/hoaxconnect/install.env")"

  hc_assert_symlink_target \
    "$HC_CASE_ROOT/opt/hoaxconnect/current" \
    "/opt/hoaxconnect/releases/$HC_RELEASE_ID"

  hc_transaction_cleanup
}

test_release_export_contains_no_private_material() {
  hc_transaction_setup

  local release="$HC_CASE_ROOT/opt/hoaxconnect/releases/$HC_RELEASE_ID"

  printf '%s\n' \
    'task4-transaction-test-secret' \
    > "$HC_WORKTREE_SECRET"

  hc_run_apply >/dev/null 2>&1 || return 1

  rm -f "$HC_WORKTREE_SECRET"
  HC_WORKTREE_SECRET=""

  if find "$release" \
      \( \
        -name .git -o \
        -name '.env' -o \
        -name '*.pem' -o \
        -name '*.key' -o \
        -name node_modules -o \
        -name dist -o \
        -name release \
      \) -print -quit |
      grep -q .; then
    hc_test_fail "release contains forbidden private material"
    return 1
  fi

  hc_transaction_cleanup
}

test_reinstall_preserves_backend_secrets() {
  hc_transaction_setup

  local env_file="$HC_CASE_ROOT/etc/hoaxconnect/backend.env"
  local password_before
  local jwt_before
  local refresh_before

  hc_run_apply >/dev/null 2>&1 || return 1

  password_before="$(
    sed -n 's/^POSTGRES_PASSWORD=//p' "$env_file"
  )"
  jwt_before="$(
    sed -n 's/^JWT_ACCESS_SECRET=//p' "$env_file"
  )"
  refresh_before="$(
    sed -n 's/^REFRESH_TOKEN_PEPPER=//p' "$env_file"
  )"

  hc_run_apply >/dev/null 2>&1 || return 1

  hc_assert_equal \
    "$password_before" \
    "$(sed -n 's/^POSTGRES_PASSWORD=//p' "$env_file")"

  hc_assert_equal \
    "$jwt_before" \
    "$(sed -n 's/^JWT_ACCESS_SECRET=//p' "$env_file")"

  hc_assert_equal \
    "$refresh_before" \
    "$(sed -n 's/^REFRESH_TOKEN_PEPPER=//p' "$env_file")"

  hc_transaction_cleanup
}

test_api_failure_preserves_previous_current_release() {
  hc_transaction_setup

  local old_release_id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  local old_release="$HC_CASE_ROOT/opt/hoaxconnect/releases/$old_release_id"
  local current="$HC_CASE_ROOT/opt/hoaxconnect/current"
  local output

  mkdir -p "$old_release"
  ln -s \
    "/opt/hoaxconnect/releases/$old_release_id" \
    "$current"

  export HC_FAKE_DOCKER_FAIL_PATTERN=" up -d api "

  output="$(hc_expect_apply_failure)"

  hc_assert_contains "$output" "failed"
  hc_assert_symlink_target \
    "$current" \
    "/opt/hoaxconnect/releases/$old_release_id"

  hc_assert_file_absent \
    "$HC_CASE_ROOT/etc/hoaxconnect/install.env"

  hc_transaction_cleanup
}

test_transaction_order_is_health_gated() {
  hc_transaction_setup

  hc_run_apply >/dev/null 2>&1 || return 1

  python3 - "$HC_COMMAND_LOG" <<'PY_ORDER' || return 1
from pathlib import Path
import sys

lines = Path(sys.argv[1]).read_text(
    encoding="utf-8"
).splitlines()

def position(fragment: str) -> int:
    for index, line in enumerate(lines):
        if fragment in line:
            return index
    raise AssertionError(f"missing command: {fragment}")

build = position(" build api")
postgres = position(" up -d postgres")
api = position(" up -d api")
nginx = position("nginx -t")
reload_nginx = position("systemctl reload nginx")

assert build < postgres < api < nginx < reload_nginx, lines
PY_ORDER

  hc_transaction_cleanup
}

test_staging_http_skips_certificate_and_https() {
  hc_transaction_setup

  hc_run_apply --staging-http >/dev/null 2>&1 ||
    return 1

  if grep -Fq \
      'certbot ' \
      "$HC_COMMAND_LOG"; then
    hc_test_fail \
      "HTTP staging unexpectedly invoked Certbot"
  fi

  if grep -Fq \
      'https://api.example.com/api/v1/health/ready' \
      "$HC_COMMAND_LOG"; then
    hc_test_fail \
      "HTTP staging unexpectedly probed HTTPS"
  fi

  grep -Fq \
    'http://api.example.com/api/v1/health/ready' \
    "$HC_COMMAND_LOG" ||
    hc_test_fail \
      "HTTP staging public health probe is missing"

  hc_transaction_cleanup
}

test_source_ref_uses_end_of_options_guard() {
  grep -Fq \
    -- '--end-of-options' \
    "$HC_INSTALLER" ||
    hc_test_fail \
      "source ref resolution lacks end-of-options protection"
}

test_existing_release_integrity_is_verified() {
  hc_transaction_setup

  local release="$HC_CASE_ROOT/opt/hoaxconnect/releases/$HC_RELEASE_ID"
  local marker="$release/.hoaxconnect-release"
  local output

  hc_run_apply >/dev/null 2>&1 ||
    return 1

  hc_assert_file_exists "$marker" ||
    return 1

  printf '%s\n' \
    '{"tampered":true}' \
    > "$release/backend/package.json"

  output="$(hc_expect_apply_failure)" ||
    return 1

  hc_assert_contains \
    "$output" \
    "integrity" ||
    return 1

  hc_transaction_cleanup
}

hc_run_transaction_test() {
  local test_name="$1"
  local output
  local status

  set +e
  output="$("$test_name" 2>&1)"
  status=$?
  set -e

  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi

  if [[ "$status" -eq 0 &&
        "$output" != *"FAIL:"* ]]; then
    printf 'PASS: %s\n' "$test_name"
    return 0
  fi

  printf 'FAIL: %s\n' "$test_name" >&2
  return 1
}

main() {
  local failures=0
  local test_name
  local tests=(
    test_successful_transaction_activates_release
    test_release_export_contains_no_private_material
    test_reinstall_preserves_backend_secrets
    test_api_failure_preserves_previous_current_release
    test_transaction_order_is_health_gated
    test_staging_http_skips_certificate_and_https
    test_source_ref_uses_end_of_options_guard
    test_existing_release_integrity_is_verified
  )

  for test_name in "${tests[@]}"; do
    if ! hc_run_transaction_test "$test_name"; then
      failures=$((failures + 1))
    fi
  done

  if [[ "$failures" -ne 0 ]]; then
    printf 'FAILED TRANSACTION TESTS: %s\n' \
      "$failures" >&2
    return 1
  fi

  printf 'ALL INSTALL TRANSACTION TESTS PASSED\n'
}

trap hc_transaction_cleanup EXIT
main "$@"
