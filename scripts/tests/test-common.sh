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
HC_LIBRARY="$HC_ROOT/scripts/lib/common.sh"

# This is the intentional RED gate for Task 1.
if [[ ! -f "$HC_LIBRARY" ]]; then
  printf 'EXPECTED RED: common library missing: %s\n' \
    "$HC_LIBRARY" >&2
  exit 1
fi

# The source path is resolved from BASH_SOURCE at runtime.
# shellcheck disable=SC1090,SC1091
source "$HC_TEST_DIR/assert.sh"

# The source path is resolved from BASH_SOURCE at runtime.
# shellcheck disable=SC1090,SC1091
source "$HC_LIBRARY"

HC_CASE_ROOT=""

hc_case_setup() {
  HC_CASE_ROOT="$(mktemp -d)"
}

hc_case_cleanup() {
  if [[ -n "${HC_CASE_ROOT:-}" &&
        "$HC_CASE_ROOT" == /tmp/* ]]; then
    rm -rf -- "$HC_CASE_ROOT"
  fi
  HC_CASE_ROOT=""
}

test_dry_run_does_not_execute() {
  hc_case_setup
  local marker="$HC_CASE_ROOT/should-not-exist"
  local output

  output="$(
    HC_EXEC_MODE=dry-run \
      hc_run touch "$marker" 2>&1
  )"

  hc_assert_file_absent \
    "$marker" \
    "dry-run executed the command"

  hc_assert_contains "$output" "touch"
  hc_assert_contains "$output" "$marker"

  hc_case_cleanup
}

test_atomic_write_sets_mode() {
  hc_case_setup
  local target="$HC_CASE_ROOT/config/backend.env"
  local actual_mode
  local actual_content

  mkdir -p -- "$(dirname -- "$target")"

  printf '%s\n' 'value=real' |
    hc_atomic_write "$target" 0640

  hc_assert_file_exists "$target"

  actual_mode="$(stat -c '%a' "$target")"
  actual_content="$(cat -- "$target")"

  hc_assert_equal "640" "$actual_mode"
  hc_assert_equal "value=real" "$actual_content"

  hc_case_cleanup
}

test_root_prefix_requires_test_mode() {
  hc_case_setup
  local output
  local status
  local expected="$HC_CASE_ROOT/etc/hoaxconnect/backend.env"

  set +e
  output="$(
    HC_TEST_MODE=0 \
    HC_ROOT_PREFIX="$HC_CASE_ROOT" \
      hc_path /etc/hoaxconnect/backend.env 2>&1
  )"
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    hc_test_fail \
      "root prefix was accepted outside test mode"
  fi

  output="$(
    HC_TEST_MODE=1 \
    HC_ROOT_PREFIX="$HC_CASE_ROOT" \
      hc_path /etc/hoaxconnect/backend.env
  )"

  hc_assert_equal "$expected" "$output"

  hc_case_cleanup
}

test_lock_rejects_second_writer() {
  hc_case_setup
  local lock_file="$HC_CASE_ROOT/deploy.lock"
  local ready_file="$HC_CASE_ROOT/ready"
  local holder_pid
  local status

  (
    # Variables intentionally belong to this subshell.
    # shellcheck disable=SC2030
    export HC_TEST_MODE=1 HC_LOCK_FILE="$lock_file"

    # The source path is resolved from BASH_SOURCE at runtime.
    # shellcheck disable=SC1090,SC1091
    source "$HC_LIBRARY"

    hc_acquire_lock
    : > "$ready_file"
    sleep 4
  ) &
  holder_pid=$!

  for _ in {1..40}; do
    [[ -f "$ready_file" ]] && break
    sleep 0.1
  done

  if [[ ! -f "$ready_file" ]]; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
    hc_test_fail "first lock holder did not become ready"
  fi

  set +e
  (
    # Variables intentionally belong to this subshell.
    # shellcheck disable=SC2031
    export HC_TEST_MODE=1 HC_LOCK_FILE="$lock_file"

    # The source path is resolved from BASH_SOURCE at runtime.
    # shellcheck disable=SC1090,SC1091
    source "$HC_LIBRARY"

    hc_acquire_lock
  ) >/dev/null 2>&1
  status=$?
  set -e

  wait "$holder_pid"

  if [[ "$status" -eq 0 ]]; then
    hc_test_fail "second writer acquired an active lock"
  fi

  hc_case_cleanup
}

test_logs_do_not_echo_secret_values() {
  local secret="task1-secret-value-that-must-not-leak"
  local output

  # The sourced logger consumes this array.
  # shellcheck disable=SC2034
  HC_SECRET_VALUES=("$secret")

  output="$(
    hc_log INFO "credential=$secret" 2>&1
  )"

  hc_assert_not_contains \
    "$output" \
    "$secret" \
    "log output exposed a registered secret"

  hc_assert_contains "$output" "[REDACTED]"
}

hc_run_test() {
  local name="$1"

  if "$name"; then
    printf 'PASS: %s\n' "$name"
    return 0
  fi

  printf 'FAIL: %s\n' "$name" >&2
  return 1
}

main() {
  local failures=0
  local test_name

  local tests=(
    test_dry_run_does_not_execute
    test_atomic_write_sets_mode
    test_root_prefix_requires_test_mode
    test_lock_rejects_second_writer
    test_logs_do_not_echo_secret_values
  )

  for test_name in "${tests[@]}"; do
    if ! hc_run_test "$test_name"; then
      failures=$((failures + 1))
    fi
  done

  if [[ "$failures" -ne 0 ]]; then
    printf 'FAILED TESTS: %s\n' "$failures" >&2
    return 1
  fi

  printf 'ALL COMMON TESTS PASSED\n'
}

trap hc_case_cleanup EXIT
main "$@"
