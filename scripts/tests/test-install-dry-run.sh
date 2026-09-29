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

if [[ ! -f "$HC_INSTALLER" ]]; then
  printf 'EXPECTED RED: installer missing: %s\n' \
    "$HC_INSTALLER" >&2
  exit 1
fi

HC_CASE_TEMP=""
HC_CASE_ROOT=""
HC_CASE_LOG=""

hc_install_test_setup() {
  HC_CASE_TEMP="$(mktemp -d)"
  HC_CASE_ROOT="$HC_CASE_TEMP/root"
  HC_CASE_LOG="$HC_CASE_TEMP/install.log"

  mkdir -p \
    "$HC_CASE_ROOT/etc" \
    "$HC_CASE_ROOT/etc/hoaxconnect" \
    "$HC_CASE_ROOT/opt/hoaxconnect/releases" \
    "$HC_CASE_ROOT/var/lib/hoaxconnect/updates" \
    "$HC_CASE_ROOT/var/log/hoaxconnect"

  cat > "$HC_CASE_ROOT/etc/os-release" <<'OS_RELEASE'
ID=ubuntu
VERSION_ID="24.04"
OS_RELEASE

  : > "$HC_CASE_LOG"
}

hc_install_test_cleanup() {
  if [[ -n "${HC_CASE_TEMP:-}" &&
        "$HC_CASE_TEMP" == /tmp/* ]]; then
    rm -rf -- "$HC_CASE_TEMP"
  fi

  HC_CASE_TEMP=""
  HC_CASE_ROOT=""
  HC_CASE_LOG=""
}

hc_install_base_command() {
  printf '%s\0' \
    "$HC_INSTALLER" \
    --domain api.example.com \
    --email admin@example.com \
    --source-ref HEAD \
    --admin-origin https://admin.example.com \
    --dry-run
}

hc_run_installer() {
  local -a command=()

  while IFS= read -r -d '' argument; do
    command+=("$argument")
  done < <(hc_install_base_command)

  env \
    HC_TEST_MODE=1 \
    HC_ROOT_PREFIX="$HC_CASE_ROOT" \
    HC_LOCK_FILE="$HC_CASE_TEMP/deploy.lock" \
    HC_INSTALL_EUID_OVERRIDE="${HC_INSTALL_EUID_OVERRIDE:-0}" \
    HC_INSTALL_OS_RELEASE="/etc/os-release" \
    HC_SKIP_DNS_CHECK=1 \
    HC_SKIP_PORT_CHECK=1 \
    HC_SKIP_RESOURCE_CHECKS=1 \
    "${command[@]}" \
    "$@"
}

hc_tree_fingerprint() {
  local root="$1"

  (
    cd -- "$root"

    find . -mindepth 1 -printf '%y %m %p %l\n' |
      sort

    find . -type f -print0 |
      sort -z |
      xargs -0 -r sha256sum
  ) |
    sha256sum |
    awk '{print $1}'
}

hc_expect_install_failure() {
  local output
  local status

  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    printf 'Expected installer failure but command passed:\n%s\n' \
      "$output" >&2
    return 1
  fi

  printf '%s\n' "$output"
}

test_non_root_is_rejected() {
  hc_install_test_setup

  local output

  export HC_INSTALL_EUID_OVERRIDE=1000
  output="$(hc_expect_install_failure hc_run_installer)"
  unset HC_INSTALL_EUID_OVERRIDE

  hc_assert_contains \
    "$output" \
    "must be run as root"

  hc_install_test_cleanup
}

test_unsupported_os_is_rejected() {
  hc_install_test_setup

  cat > "$HC_CASE_ROOT/etc/os-release" <<'OS_RELEASE'
ID=centos
VERSION_ID="7"
OS_RELEASE

  local output
  output="$(hc_expect_install_failure hc_run_installer)"

  hc_assert_contains \
    "$output" \
    "Unsupported operating system"

  hc_install_test_cleanup
}

test_required_production_inputs() {
  hc_install_test_setup

  local output

  output="$(
    hc_expect_install_failure \
      env \
        HC_TEST_MODE=1 \
        HC_ROOT_PREFIX="$HC_CASE_ROOT" \
        HC_LOCK_FILE="$HC_CASE_TEMP/deploy.lock" \
        HC_INSTALL_EUID_OVERRIDE=0 \
        "$HC_INSTALLER" \
        --dry-run
  )"

  hc_assert_contains "$output" "--domain"
  hc_assert_contains "$output" "--email"
  hc_assert_contains "$output" "--source-ref"

  hc_install_test_cleanup
}

test_dry_run_makes_no_filesystem_changes() {
  hc_install_test_setup

  local before
  local after
  local output

  before="$(hc_tree_fingerprint "$HC_CASE_ROOT")"
  output="$(hc_run_installer 2>&1)"
  after="$(hc_tree_fingerprint "$HC_CASE_ROOT")"

  hc_assert_equal "$before" "$after"
  hc_assert_contains "$output" "DRY-RUN"
  hc_assert_file_absent \
    "$HC_CASE_ROOT/opt/hoaxconnect/current"
  hc_assert_file_absent \
    "$HC_CASE_ROOT/etc/hoaxconnect/install.env"

  hc_install_test_cleanup
}

test_http_staging_requires_explicit_flag() {
  hc_install_test_setup

  local production_output
  local staging_output

  production_output="$(hc_run_installer 2>&1)"
  staging_output="$(hc_run_installer --staging-http 2>&1)"

  hc_assert_contains \
    "$production_output" \
    "TLS mode: required"

  hc_assert_contains \
    "$staging_output" \
    "TLS mode: staging"

  hc_install_test_cleanup
}

test_admin_origin_defaults_to_domain_https() {
  hc_install_test_setup

  local output

  output="$(
    env \
      HC_TEST_MODE=1 \
      HC_ROOT_PREFIX="$HC_CASE_ROOT" \
      HC_LOCK_FILE="$HC_CASE_TEMP/deploy.lock" \
      HC_INSTALL_EUID_OVERRIDE=0 \
      HC_INSTALL_OS_RELEASE="/etc/os-release" \
      HC_SKIP_DNS_CHECK=1 \
      HC_SKIP_PORT_CHECK=1 \
      HC_SKIP_RESOURCE_CHECKS=1 \
      "$HC_INSTALLER" \
      --domain api.example.com \
      --email admin@example.com \
      --source-ref HEAD \
      --dry-run \
      2>&1
  )"

  hc_assert_contains \
    "$output" \
    "Admin origin: https://api.example.com"

  hc_install_test_cleanup
}

test_existing_secrets_are_not_changed_or_logged() {
  hc_install_test_setup

  local env_file="$HC_CASE_ROOT/etc/hoaxconnect/backend.env"
  local secret="existing-secret-value-that-must-remain-private-0123456789"
  local before
  local after
  local output

  cat > "$env_file" <<EOF
POSTGRES_PASSWORD=$secret
JWT_ACCESS_SECRET=${secret}jwt
REFRESH_TOKEN_PEPPER=${secret}refresh
REFRESH_RECOVERY_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
REFRESH_RECOVERY_TTL_SECONDS=120
EOF
  chmod 0600 "$env_file"

  before="$(sha256sum "$env_file" | awk '{print $1}')"
  output="$(hc_run_installer 2>&1)"
  after="$(sha256sum "$env_file" | awk '{print $1}')"

  hc_assert_equal "$before" "$after"
  hc_assert_not_contains "$output" "$secret"
  hc_assert_equal "600" "$(stat -c '%a' "$env_file")"

  hc_install_test_cleanup
}

test_source_export_uses_git_archive_contract() {
  grep -Eq \
    'git[[:space:]]+archive([[:space:]]|\\)' \
    "$HC_INSTALLER" ||
    hc_test_fail "installer does not use git archive"

  if grep -Eq \
    '(^|[[:space:]])cp[[:space:]].*[[:space:]]\.[[:space:]]' \
    "$HC_INSTALLER"; then
    hc_test_fail "installer copies the working tree"
  fi

  if grep -Eq \
    '(^|[[:space:]])rsync[[:space:]].*[[:space:]]\./' \
    "$HC_INSTALLER"; then
    hc_test_fail "installer rsyncs the working tree"
  fi

  grep -Fq \
    '/opt/hoaxconnect/releases/' \
    "$HC_INSTALLER" ||
    hc_test_fail "installer does not use immutable release paths"
}

test_unavailable_components_are_reported() {
  hc_install_test_setup

  local output
  output="$(hc_run_installer 2>&1)"

  hc_assert_contains \
    "$output" \
    "Admin panel: unavailable"

  hc_assert_contains \
    "$output" \
    "Website: unavailable"

  hc_assert_contains \
    "$output" \
    "Desktop artifacts: unavailable"

  hc_install_test_cleanup
}

test_test_overrides_require_test_mode() {
  hc_install_test_setup

  local output

  output="$(
    hc_expect_install_failure \
      env \
        HC_ROOT_PREFIX="$HC_CASE_ROOT" \
        HC_INSTALL_EUID_OVERRIDE=0 \
        "$HC_INSTALLER" \
        --domain api.example.com \
        --email admin@example.com \
        --source-ref HEAD \
        --admin-origin https://admin.example.com \
        --dry-run
  )"

  hc_assert_contains \
    "$output" \
    "test mode"

  hc_install_test_cleanup
}

hc_run_install_test() {
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
    test_non_root_is_rejected
    test_unsupported_os_is_rejected
    test_required_production_inputs
    test_dry_run_makes_no_filesystem_changes
    test_http_staging_requires_explicit_flag
    test_admin_origin_defaults_to_domain_https
    test_existing_secrets_are_not_changed_or_logged
    test_source_export_uses_git_archive_contract
    test_unavailable_components_are_reported
    test_test_overrides_require_test_mode
  )

  for test_name in "${tests[@]}"; do
    if ! hc_run_install_test "$test_name"; then
      failures=$((failures + 1))
    fi
  done

  if [[ "$failures" -ne 0 ]]; then
    printf 'FAILED INSTALL TESTS: %s\n' "$failures" >&2
    return 1
  fi

  printf 'ALL INSTALL TESTS PASSED\n'
}

trap hc_install_test_cleanup EXIT
main "$@"
