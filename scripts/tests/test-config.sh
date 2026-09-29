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
HC_TEMPLATE="$HC_ROOT/deploy/templates/backend.env.template"

# shellcheck disable=SC1090,SC1091
source "$HC_TEST_DIR/assert.sh"

if [[ ! -f "$HC_CONFIG" ]]; then
  printf 'EXPECTED RED: config library missing: %s\n' \
    "$HC_CONFIG" >&2
  exit 1
fi

# shellcheck disable=SC1090,SC1091
source "$HC_COMMON"

# shellcheck disable=SC1090,SC1091
source "$HC_CONFIG"

HC_CASE_ROOT=""

hc_config_setup() {
  HC_CASE_ROOT="$(mktemp -d)"

  export HC_TEST_MODE=1
  export HC_ROOT_PREFIX="$HC_CASE_ROOT"
  export HC_DOMAIN="api.example.com"
  export HC_ADMIN_ORIGIN="https://admin.example.com"
  export HC_RELEASE_ID="0123456789abcdef0123456789abcdef01234567"
  export HC_RELEASE_DIR="/opt/hoaxconnect/releases/$HC_RELEASE_ID"
  export HC_ENV_FILE="/etc/hoaxconnect/backend.env"
  export HC_TLS_MODE="required"

  mkdir -p "$HC_CASE_ROOT/etc/hoaxconnect"
}

hc_config_cleanup() {
  if [[ -n "${HC_CASE_ROOT:-}" &&
        "$HC_CASE_ROOT" == /tmp/* ]]; then
    rm -rf -- "$HC_CASE_ROOT"
  fi

  HC_CASE_ROOT=""
}

hc_expect_failure() {
  if "$@" >/dev/null 2>&1; then
    hc_test_fail "command unexpectedly succeeded: $*"
  fi
}

test_invalid_ip_domains() {
  hc_expect_failure hc_validate_domain "194.26.64.55"
  hc_expect_failure hc_validate_domain "2001:db8::1"
  hc_expect_failure hc_validate_domain "*.example.com"
  hc_validate_domain "api.example.com"
}

test_email_validation() {
  hc_expect_failure hc_validate_email "invalid"
  hc_expect_failure hc_validate_email "admin@"
  hc_validate_email "admin@example.com"
}

test_wildcard_cors_is_rejected() {
  hc_config_setup

  HC_ADMIN_ORIGIN="*"
  export HC_ADMIN_ORIGIN

  hc_expect_failure hc_load_install_config
  hc_config_cleanup
}

test_generated_secrets_are_strong() {
  local secret

  secret="$(hc_generate_secret 48)"

  if [[ "${#secret}" -lt 64 ]]; then
    hc_test_fail \
      "generated secret is shorter than 64 characters"
  fi

  if [[ "$secret" =~ [[:space:]] ]]; then
    hc_test_fail "generated secret contains whitespace"
  fi
}

test_reinstall_preserves_secrets_and_mode() {
  hc_config_setup

  hc_load_install_config
  hc_write_backend_env

  local target="$HC_CASE_ROOT/etc/hoaxconnect/backend.env"
  local first_password
  local first_jwt
  local first_pepper
  local first_recovery_key
  local first_hash
  local second_hash

  hc_assert_file_exists "$target"
  hc_assert_equal "600" "$(stat -c '%a' "$target")"

  first_password="$(
    sed -n 's/^POSTGRES_PASSWORD=//p' "$target"
  )"
  first_jwt="$(
    sed -n 's/^JWT_ACCESS_SECRET=//p' "$target"
  )"
  first_pepper="$(
    sed -n 's/^REFRESH_TOKEN_PEPPER=//p' "$target"
  )"
  first_recovery_key="$(
    sed -n 's/^REFRESH_RECOVERY_ENCRYPTION_KEY=//p' "$target"
  )"

  test "${#first_password}" -ge 64
  test "${#first_jwt}" -ge 64
  test "${#first_pepper}" -ge 64
  test "${#first_recovery_key}" -eq 44
  [[ "$first_recovery_key" =~ ^[A-Za-z0-9+/]{43}=$ ]]

  first_hash="$(sha256sum "$target" | awk '{print $1}')"

  hc_write_backend_env

  second_hash="$(sha256sum "$target" | awk '{print $1}')"
  hc_assert_equal "$first_hash" "$second_hash"

  hc_assert_equal \
    "$first_password" \
    "$(sed -n 's/^POSTGRES_PASSWORD=//p' "$target")"

  hc_assert_equal \
    "$first_jwt" \
    "$(sed -n 's/^JWT_ACCESS_SECRET=//p' "$target")"

  hc_assert_equal \
    "$first_pepper" \
    "$(sed -n 's/^REFRESH_TOKEN_PEPPER=//p' "$target")"

  hc_assert_equal \
    "$first_recovery_key" \
    "$(sed -n 's/^REFRESH_RECOVERY_ENCRYPTION_KEY=//p' "$target")"

  if grep -Fq -- "$first_password" "$HC_TEMPLATE"; then
    hc_test_fail "tracked template contains a generated secret"
  fi

  if grep -Fq -- "$first_recovery_key" "$HC_TEMPLATE"; then
    hc_test_fail "tracked template contains a generated recovery key"
  fi

  hc_config_cleanup
}

hc_run_config_test() {
  local test_name="$1"

  if "$test_name"; then
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
    test_invalid_ip_domains
    test_email_validation
    test_wildcard_cors_is_rejected
    test_generated_secrets_are_strong
    test_reinstall_preserves_secrets_and_mode
  )

  for test_name in "${tests[@]}"; do
    if ! hc_run_config_test "$test_name"; then
      failures=$((failures + 1))
    fi
  done

  if [[ "$failures" -ne 0 ]]; then
    printf 'FAILED CONFIG TESTS: %s\n' "$failures" >&2
    return 1
  fi

  printf 'ALL CONFIG TESTS PASSED\n'
}

trap hc_config_cleanup EXIT
main "$@"
