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
HC_UPDATER="$HC_ROOT/scripts/update.sh"

# The source path is resolved from BASH_SOURCE at runtime.
# shellcheck disable=SC1090,SC1091
source "$HC_TEST_DIR/assert.sh"

required_update_tests=(
  test_backup_happens_before_candidate_start
  test_activation_occurs_only_after_health
  test_build_failure_preserves_previous_release
  test_readiness_failure_rolls_back_release
  test_readiness_failure_rolls_back_nginx
  test_update_never_removes_volumes
  test_post_migration_failure_reports_warning
  test_database_volume_identity_remains_stable
)

test_behavioral_contract_is_registered() {
  local test_name

  for test_name in "${required_update_tests[@]}"; do
    if ! declare -F "$test_name" >/dev/null 2>&1; then
      hc_test_fail \
        "missing update behavior test: $test_name"
      return 1
    fi
  done
}

test_cli_contract() {
  local output

  output="$("$HC_UPDATER" --help)"

  hc_assert_contains "$output" "--source-ref" ||
    return 1

  hc_assert_not_contains "$output" "--volumes" ||
    return 1
}

HC_ORIGINAL_PATH="$PATH"
HC_CASE_TEMP=""
HC_CASE_ROOT=""
HC_FAKE_BIN=""
HC_COMMAND_LOG=""
HC_OLD_RELEASE="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HC_CANDIDATE_RELEASE=""
HC_UPDATE_OUTPUT=""
HC_TEST_SECRET=""

hc_update_cleanup() {
  PATH="$HC_ORIGINAL_PATH"
  export PATH

  if [[ -n "${HC_CASE_TEMP:-}" &&
        "$HC_CASE_TEMP" == /tmp/* ]]; then
    rm -rf -- "$HC_CASE_TEMP"
  fi

  HC_CASE_TEMP=""
  HC_CASE_ROOT=""
  HC_FAKE_BIN=""
  HC_COMMAND_LOG=""
  HC_CANDIDATE_RELEASE=""
  HC_UPDATE_OUTPUT=""
  HC_TEST_SECRET=""

  unset \
    HC_TEST_MODE \
    HC_ROOT_PREFIX \
    HC_LOCK_FILE \
    HC_UPDATE_EUID_OVERRIDE \
    HC_UPDATE_OS_RELEASE \
    HC_SKIP_DNS_CHECK \
    HC_SKIP_PORT_CHECK \
    HC_SKIP_RESOURCE_CHECKS \
    HC_NGINX_BIN \
    HC_SYSTEMCTL_BIN \
    HC_CERTBOT_BIN \
    HC_COMMAND_LOG \
    HC_FAKE_DOCKER_FAIL_PATTERN \
    HC_FAKE_CURL_RESULT \
    HC_ASSERT_OLD_DURING_HEALTH \
    HC_TEST_CURRENT_LINK \
    HC_TEST_OLD_RELEASE || true
}

hc_update_setup() {
  hc_update_cleanup

  HC_CASE_TEMP="$(mktemp -d)"
  HC_CASE_ROOT="$HC_CASE_TEMP/root"
  HC_FAKE_BIN="$HC_CASE_TEMP/fake-bin"
  HC_COMMAND_LOG="$HC_CASE_TEMP/commands.log"
  HC_CANDIDATE_RELEASE="$(
    git -C "$HC_ROOT" rev-parse HEAD
  )"
  HC_TEST_SECRET="$(
    printf 'u%.0s' {1..64}
  )"

  mkdir -p \
    "$HC_FAKE_BIN" \
    "$HC_CASE_ROOT/etc/hoaxconnect" \
    "$HC_CASE_ROOT/etc/nginx/sites-available" \
    "$HC_CASE_ROOT/etc/nginx/sites-enabled" \
    "$HC_CASE_ROOT/opt/hoaxconnect/releases/$HC_OLD_RELEASE/deploy/compose" \
    "$HC_CASE_ROOT/var/backups/hoaxconnect" \
    "$HC_CASE_ROOT/var/lib/hoaxconnect/acme" \
    "$HC_CASE_ROOT/var/lib/hoaxconnect/updates" \
    "$HC_CASE_ROOT/var/log/hoaxconnect"

  cat >"$HC_CASE_ROOT/etc/os-release" <<'EOF_OS'
ID=ubuntu
VERSION_ID="24.04"
EOF_OS

  cat >"$HC_CASE_ROOT/etc/hoaxconnect/install.env" <<EOF_INSTALL
DOMAIN=api.example.com
ADMIN_ORIGIN=https://admin.example.com
ACME_EMAIL=admin@example.com
SOURCE_REF=$HC_OLD_RELEASE
RELEASE_ID=$HC_OLD_RELEASE
RELEASE_DIR=/opt/hoaxconnect/releases/$HC_OLD_RELEASE
TLS_MODE=required
INSTALLED_AT=2026-09-28T00:00:00Z
EOF_INSTALL

  cat >"$HC_CASE_ROOT/etc/hoaxconnect/backend.env" <<EOF_BACKEND
NODE_ENV=production
HOST=0.0.0.0
PORT=3100
POSTGRES_DB=hoaxconnect
POSTGRES_USER=hoaxconnect
POSTGRES_PASSWORD=$HC_TEST_SECRET
DATABASE_URL=postgresql://hoaxconnect:$HC_TEST_SECRET@postgres:5432/hoaxconnect
JWT_ACCESS_SECRET=$HC_TEST_SECRET
REFRESH_TOKEN_PEPPER=$HC_TEST_SECRET
CORS_ALLOWED_ORIGINS=https://admin.example.com
EOF_BACKEND

  chmod 0600 \
    "$HC_CASE_ROOT/etc/hoaxconnect/install.env" \
    "$HC_CASE_ROOT/etc/hoaxconnect/backend.env"

  printf '%s\n' "old-release" \
    >"$HC_CASE_ROOT/opt/hoaxconnect/releases/$HC_OLD_RELEASE/release.txt"

  cp \
    "$HC_ROOT/deploy/compose/compose.source.yml" \
    "$HC_CASE_ROOT/opt/hoaxconnect/releases/$HC_OLD_RELEASE/deploy/compose/compose.source.yml"

  ln -s \
    "/opt/hoaxconnect/releases/$HC_OLD_RELEASE" \
    "$HC_CASE_ROOT/opt/hoaxconnect/current"

  printf '%s\n' "previous-nginx-config" \
    >"$HC_CASE_ROOT/etc/nginx/sites-available/hoaxconnect-control-plane.conf"

  ln -s \
    /etc/nginx/sites-available/hoaxconnect-control-plane.conf \
    "$HC_CASE_ROOT/etc/nginx/sites-enabled/hoaxconnect-control-plane.conf"

  : >"$HC_COMMAND_LOG"

  cat >"$HC_FAKE_BIN/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail

printf 'docker %s\n' "$*" >>"${HC_COMMAND_LOG:?}"

if [[ -n "${HC_FAKE_DOCKER_FAIL_PATTERN:-}" &&
      " $* " == *"${HC_FAKE_DOCKER_FAIL_PATTERN}"* ]]; then
  exit 41
fi

if [[ "${1:-}" == "inspect" ]]; then
  printf '%s\n' "healthy"
  exit 0
fi

if [[ "${1:-}" == "volume" &&
      "${2:-}" == "inspect" ]]; then
  printf '%s\n' "hoaxconnect_pgdata|local|stable-volume"
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
  "services": {
    "postgres": {"ports": null},
    "api": {
      "ports": [{
        "target": 3100,
        "published": "3100",
        "host_ip": "127.0.0.1"
      }]
    }
  },
  "networks": {"backend": {"internal": true}},
  "volumes": {
    "hoaxconnect_pgdata": {
      "name": "hoaxconnect_pgdata"
    }
  }
}
JSON
    ;;
  *" ps -q postgres "*)
    printf '%s\n' "fake-postgres"
    ;;
  *" ps -q api "*)
    printf '%s\n' "fake-api"
    ;;
  *" pg_dump "*)
    printf '%s\n' "PGDMP-UPDATE-TEST"
    ;;
  *"schema_migrations"*)
    printf '%s\n' \
      "001_initial.sql|update-test-checksum"
    ;;
esac
FAKE_DOCKER

  cat >"$HC_FAKE_BIN/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail

printf 'curl %s\n' "$*" >>"${HC_COMMAND_LOG:?}"

if [[ "${HC_ASSERT_OLD_DURING_HEALTH:-0}" == "1" ]]; then
  current="${HC_TEST_CURRENT_LINK:?}"
  expected="/opt/hoaxconnect/releases/${HC_TEST_OLD_RELEASE:?}"

  if [[ ! -L "$current" ||
        "$(readlink -- "$current")" != "$expected" ]]; then
    printf '%s\n' \
      "candidate activated before health gate" >&2
    exit 72
  fi
fi

exit "${HC_FAKE_CURL_RESULT:-0}"
FAKE_CURL

  cat >"$HC_FAKE_BIN/nginx" <<'FAKE_NGINX'
#!/usr/bin/env bash
printf 'nginx %s\n' "$*" >>"${HC_COMMAND_LOG:?}"
exit 0
FAKE_NGINX

  cat >"$HC_FAKE_BIN/systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"${HC_COMMAND_LOG:?}"
exit 0
FAKE_SYSTEMCTL

  cat >"$HC_FAKE_BIN/certbot" <<'FAKE_CERTBOT'
#!/usr/bin/env bash
printf 'certbot %s\n' "$*" >>"${HC_COMMAND_LOG:?}"
exit 0
FAKE_CERTBOT

  chmod 0700 "$HC_FAKE_BIN"/*

  export PATH="$HC_FAKE_BIN:$HC_ORIGINAL_PATH"
  export HC_TEST_MODE=1
  export HC_ROOT_PREFIX="$HC_CASE_ROOT"
  export HC_LOCK_FILE="$HC_CASE_TEMP/update.lock"
  export HC_UPDATE_EUID_OVERRIDE=0
  export HC_UPDATE_OS_RELEASE="/etc/os-release"
  export HC_SKIP_DNS_CHECK=1
  export HC_SKIP_PORT_CHECK=1
  export HC_SKIP_RESOURCE_CHECKS=1
  export HC_NGINX_BIN="$HC_FAKE_BIN/nginx"
  export HC_SYSTEMCTL_BIN="$HC_FAKE_BIN/systemctl"
  export HC_CERTBOT_BIN="$HC_FAKE_BIN/certbot"
  export HC_COMMAND_LOG
  export HC_FAKE_DOCKER_FAIL_PATTERN=""
  export HC_FAKE_CURL_RESULT=0
  export HC_ASSERT_OLD_DURING_HEALTH=0
  export HC_TEST_CURRENT_LINK="$HC_CASE_ROOT/opt/hoaxconnect/current"
  export HC_TEST_OLD_RELEASE="$HC_OLD_RELEASE"
}

hc_run_update() {
  local status

  set +e
  HC_UPDATE_OUTPUT="$(
    "$HC_UPDATER" \
      --source-ref HEAD \
      2>&1
  )"
  status=$?
  set -e

  return "$status"
}

hc_assert_old_release_active() {
  local current="$HC_CASE_ROOT/opt/hoaxconnect/current"

  [[ -L "$current" ]] || {
    hc_test_fail "current release symlink is absent"
    return 1
  }

  hc_assert_equal \
    "/opt/hoaxconnect/releases/$HC_OLD_RELEASE" \
    "$(readlink -- "$current")"
}

hc_command_position() {
  local fragment="$1"

  grep -nF -- "$fragment" "$HC_COMMAND_LOG" |
    head -n 1 |
    cut -d: -f1
}

test_backup_happens_before_candidate_start() {
  hc_update_setup
  hc_run_update || return 1

  local backup_position
  local build_position

  backup_position="$(hc_command_position " pg_dump ")"
  build_position="$(hc_command_position " build api")"

  [[ "$backup_position" =~ ^[0-9]+$ ]] || return 1
  [[ "$build_position" =~ ^[0-9]+$ ]] || return 1
  [[ "$backup_position" -lt "$build_position" ]] || {
    hc_test_fail "candidate build occurred before backup"
    return 1
  }

  hc_update_cleanup
}

test_activation_occurs_only_after_health() {
  hc_update_setup
  export HC_ASSERT_OLD_DURING_HEALTH=1

  hc_run_update || return 1

  hc_assert_equal \
    "/opt/hoaxconnect/releases/$HC_CANDIDATE_RELEASE" \
    "$(readlink -- "$HC_CASE_ROOT/opt/hoaxconnect/current")"

  hc_update_cleanup
}

test_build_failure_preserves_previous_release() {
  hc_update_setup
  export HC_FAKE_DOCKER_FAIL_PATTERN=" build api "

  if hc_run_update; then
    hc_test_fail "update succeeded after build failure"
    return 1
  fi

  hc_assert_old_release_active || return 1

  hc_assert_equal \
    "previous-nginx-config" \
    "$(cat "$HC_CASE_ROOT/etc/nginx/sites-available/hoaxconnect-control-plane.conf")"

  hc_update_cleanup
}

test_readiness_failure_rolls_back_release() {
  hc_update_setup
  export HC_FAKE_CURL_RESULT=22

  if hc_run_update; then
    hc_test_fail "update succeeded after readiness failure"
    return 1
  fi

  hc_assert_old_release_active || return 1

  hc_update_cleanup
}

test_readiness_failure_rolls_back_nginx() {
  hc_update_setup
  export HC_FAKE_CURL_RESULT=22

  if hc_run_update; then
    hc_test_fail "update succeeded after public health failure"
    return 1
  fi

  hc_assert_equal \
    "previous-nginx-config" \
    "$(cat "$HC_CASE_ROOT/etc/nginx/sites-available/hoaxconnect-control-plane.conf")"

  hc_update_cleanup
}

test_update_never_removes_volumes() {
  hc_update_setup
  export HC_FAKE_DOCKER_FAIL_PATTERN=" build api "

  hc_run_update || true

  if grep -E \
      'down[[:space:]]+-v|--volumes|volume[[:space:]]+rm' \
      "$HC_COMMAND_LOG"
  then
    hc_test_fail "update attempted to remove a volume"
    return 1
  fi

  hc_update_cleanup
}

test_post_migration_failure_reports_warning() {
  hc_update_setup
  export HC_FAKE_CURL_RESULT=22

  hc_run_update || true

  hc_assert_contains \
    "${HC_UPDATE_OUTPUT,,}" \
    "migration" ||
    return 1

  hc_assert_contains \
    "${HC_UPDATE_OUTPUT,,}" \
    "backup" ||
    return 1

  hc_update_cleanup
}

test_database_volume_identity_remains_stable() {
  hc_update_setup

  local before="hoaxconnect_pgdata|local|stable-volume"
  local after

  hc_run_update || return 1

  after="$(
    docker volume inspect hoaxconnect_pgdata
  )"

  hc_assert_equal "$before" "$after" || return 1

  if grep -E \
      'down[[:space:]]+-v|--volumes|volume[[:space:]]+rm' \
      "$HC_COMMAND_LOG"
  then
    hc_test_fail "database volume identity was endangered"
    return 1
  fi

  hc_update_cleanup
}

hc_run_update_test() {
  local test_name="$1"
  local output
  local status

  set +e
  output="$("$test_name" 2>&1)"
  status=$?
  set -e

  [[ -z "$output" ]] || printf '%s\n' "$output"

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

  if [[ ! -x "$HC_UPDATER" ]]; then
    printf 'EXPECTED RED: updater missing: %s\n' \
      "$HC_UPDATER" >&2
    return 1
  fi

  test_behavioral_contract_is_registered ||
    return 1
  test_cli_contract ||
    return 1

  for test_name in "${required_update_tests[@]}"; do
    if ! hc_run_update_test "$test_name"; then
      failures=$((failures + 1))
    fi
  done

  if [[ "$failures" -ne 0 ]]; then
    printf 'FAILED UPDATE TESTS: %s\n' \
      "$failures" >&2
    return 1
  fi

  printf 'ALL UPDATE TESTS PASSED\n'
}

trap hc_update_cleanup EXIT
main "$@"
