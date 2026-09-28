#!/usr/bin/env bash
set -Eeuo pipefail

HC_TEST_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
  pwd -P
)"

tests=(
  "$HC_TEST_DIR/test-common.sh"
  "$HC_TEST_DIR/test-config.sh"
  "$HC_TEST_DIR/test-compose.sh"
  "$HC_TEST_DIR/test-nginx.sh"
  "$HC_TEST_DIR/test-install-dry-run.sh"
  "$HC_TEST_DIR/test-install-transaction.sh"
  "$HC_TEST_DIR/test-backup-restore.sh"
  "$HC_TEST_DIR/test-update.sh"
)

failures=0

for test_file in "${tests[@]}"; do
  printf 'RUN: %s\n' "${test_file##*/}"

  if ! bash "$test_file"; then
    failures=$((failures + 1))
  fi
done

if [[ "$failures" -ne 0 ]]; then
  printf 'FAILED TEST FILES: %s\n' "$failures" >&2
  exit 1
fi

printf 'ALL TEST FILES PASSED\n'
