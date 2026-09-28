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

# The assertion path is resolved from BASH_SOURCE at runtime.
# shellcheck disable=SC1090,SC1091
source "$HC_TEST_DIR/assert.sh"

HC_BACKUP_LIBRARY="$HC_ROOT/scripts/lib/backup.sh"
HC_BACKUP_COMMAND="$HC_ROOT/scripts/backup.sh"
HC_RESTORE_COMMAND="$HC_ROOT/scripts/restore.sh"

required_files=(
  "$HC_BACKUP_LIBRARY"
  "$HC_BACKUP_COMMAND"
  "$HC_RESTORE_COMMAND"
)

# This contract is consumed by the behavioral RED tests added next.
# shellcheck disable=SC2034
required_archive_members=(
  "database.dump"
  "config/"
  "nginx/"
  "manifest.env"
  "SHA256SUMS"
)

required_contract_tests=(
  "test_backup_archive_is_mode_0600"
  "test_backup_contains_required_members"
  "test_manifest_contains_release_and_schema_metadata"
  "test_backup_output_redacts_secrets"
  "test_restore_requires_explicit_confirmation"
  "test_restore_rejects_checksum_mismatch"
  "test_restore_creates_pre_restore_backup"
  "test_failed_restore_recovers_previous_database"
  "test_restore_preserves_database_volume"
  "test_restore_requires_post_restart_readiness"
  "test_backup_archive_contains_no_links"
  "test_restore_rejects_archive_links"
  "test_recovery_stops_api_before_second_restore"
)

missing=()

for path in "${required_files[@]}"; do
  if [[ ! -f "$path" ]]; then
    missing+=("$path")
  fi
done

if [[ "${#missing[@]}" -gt 0 ]]; then
  printf 'EXPECTED RED: backup and restore implementation missing:\n' >&2

  for path in "${missing[@]}"; do
    printf '  %s\n' "$path" >&2
  done

  exit 1
fi

failures=0

fail_contract() {
  local name="$1"
  local reason="$2"

  printf 'FAIL: %s: %s\n' "$name" "$reason" >&2
  failures=$((failures + 1))
}

test_cli_contract() {
  local backup_help
  local restore_help

  backup_help="$("$HC_BACKUP_COMMAND" --help 2>&1)" || {
    fail_contract \
      "test_cli_contract" \
      "backup --help failed"
    return
  }

  [[ "$backup_help" == *"--output"* ]] || {
    fail_contract \
      "test_cli_contract" \
      "backup --output is missing"
    return
  }

  restore_help="$("$HC_RESTORE_COMMAND" --help 2>&1)" || {
    fail_contract \
      "test_cli_contract" \
      "restore --help failed"
    return
  }

  [[ "$restore_help" == *"--backup"* ]] || {
    fail_contract \
      "test_cli_contract" \
      "restore --backup is missing"
    return
  }

  [[ "$restore_help" == *"--confirm-restore"* ]] || {
    fail_contract \
      "test_cli_contract" \
      "restore confirmation flag is missing"
    return
  }
}

test_library_contract_markers() {
  local marker

  for marker in \
    pg_dump \
    SHA256SUMS \
    manifest.env \
    database.dump
  do
    if ! grep -Fq -- "$marker" "$HC_BACKUP_LIBRARY"; then
      fail_contract \
        "test_library_contract_markers" \
        "missing marker: $marker"
      return
    fi
  done

}

test_behavioral_contract_is_registered() {
  local name

  for name in "${required_contract_tests[@]}"; do
    if ! declare -F "$name" >/dev/null 2>&1; then
      fail_contract \
        "test_behavioral_contract_is_registered" \
        "missing runtime test: $name"
      return
    fi
  done

}

HC_CASE_TEMP=""
HC_CASE_ROOT=""
HC_FAKE_BIN=""
HC_OUTPUT_DIR=""
HC_ARCHIVE=""
HC_BACKUP_OUTPUT=""
HC_RESTORE_OUTPUT=""
HC_TEST_SECRET="task5-private-secret-value"
HC_TEST_RELEASE="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

hc_backup_case_cleanup() {
  if [[ -n "${HC_CASE_TEMP:-}" &&
        "$HC_CASE_TEMP" == /tmp/* ]]; then
    rm -rf -- "$HC_CASE_TEMP"
  fi

  HC_CASE_TEMP=""
  HC_CASE_ROOT=""
  HC_FAKE_BIN=""
  HC_OUTPUT_DIR=""
  HC_ARCHIVE=""
  HC_BACKUP_OUTPUT=""
  HC_RESTORE_OUTPUT=""

  unset \
    HC_TEST_MODE \
    HC_ROOT_PREFIX \
    HC_LOCK_FILE \
    HC_COMMAND_LOG \
    HC_RESTORE_COUNT_FILE \
    HC_RESTORE_PRE_BACKUP_DIR \
    HC_FAKE_PG_RESTORE_FAIL_ONCE \
    HC_FAKE_CURL_RESULT || true
}

hc_backup_case_setup() {
  hc_backup_case_cleanup

  HC_CASE_TEMP="$(mktemp -d)"
  HC_CASE_ROOT="$HC_CASE_TEMP/root"
  HC_FAKE_BIN="$HC_CASE_TEMP/fake-bin"
  HC_OUTPUT_DIR="$HC_CASE_TEMP/output"

  mkdir -p \
    "$HC_FAKE_BIN" \
    "$HC_OUTPUT_DIR" \
    "$HC_CASE_ROOT/etc/hoaxconnect" \
    "$HC_CASE_ROOT/etc/nginx/sites-available" \
    "$HC_CASE_ROOT/etc/nginx/sites-enabled" \
    "$HC_CASE_ROOT/opt/hoaxconnect/releases/$HC_TEST_RELEASE"

  cat >"$HC_CASE_ROOT/etc/hoaxconnect/backend.env" <<EOF
POSTGRES_DB=hoaxconnect
POSTGRES_USER=hoaxconnect
POSTGRES_PASSWORD=$HC_TEST_SECRET
DATABASE_URL=postgresql://hoaxconnect:$HC_TEST_SECRET@postgres:5432/hoaxconnect
JWT_ACCESS_SECRET=$HC_TEST_SECRET
REFRESH_TOKEN_PEPPER=$HC_TEST_SECRET
EOF
  chmod 0600 "$HC_CASE_ROOT/etc/hoaxconnect/backend.env"

  cat >"$HC_CASE_ROOT/etc/hoaxconnect/install.env" <<EOF
DOMAIN=api.example.com
RELEASE_ID=$HC_TEST_RELEASE
RELEASE_DIR=/opt/hoaxconnect/releases/$HC_TEST_RELEASE
TLS_MODE=production
EOF
  chmod 0600 "$HC_CASE_ROOT/etc/hoaxconnect/install.env"

  printf '%s\n' 'server { listen 443 ssl; }' \
    >"$HC_CASE_ROOT/etc/nginx/sites-available/hoaxconnect-control-plane.conf"

  ln -s \
    /etc/nginx/sites-available/hoaxconnect-control-plane.conf \
    "$HC_CASE_ROOT/etc/nginx/sites-enabled/hoaxconnect-control-plane.conf"

  ln -s \
    "/opt/hoaxconnect/releases/$HC_TEST_RELEASE" \
    "$HC_CASE_ROOT/opt/hoaxconnect/current"

  cat >"$HC_FAKE_BIN/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail

printf 'docker %s\n' "$*" >>"${HC_COMMAND_LOG:?}"

if [[ " $* " == *" pg_restore "* ]]; then
  restore_count=0

  if [[ -f "${HC_RESTORE_COUNT_FILE:?}" ]]; then
    restore_count="$(cat "$HC_RESTORE_COUNT_FILE")"
  fi

  restore_count=$((restore_count + 1))
  printf '%s\n' "$restore_count" >"$HC_RESTORE_COUNT_FILE"

  cat >/dev/null || true

  if [[ "${HC_FAKE_PG_RESTORE_FAIL_ONCE:-0}" == "1" &&
        "$restore_count" -eq 1 ]]; then
    exit 42
  fi

  exit 0
fi

case " $* " in
  *" compose version "*)
    printf '%s\n' "Docker Compose version v2.test"
    ;;
  *" pg_dump "*)
    printf '%s\n' "PGDMP-FAKE-CUSTOM-DATABASE"
    ;;
  *"schema_migrations"*)
    printf '%s\n' \
      "001_initial.sql|ee0890983b66ec34dc5e40221388872c4dcb776647995d158e922cf7b8f5d0fe"
    ;;
esac
FAKE_DOCKER

  cat >"$HC_FAKE_BIN/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail

printf 'curl %s\n' "$*" >>"${HC_COMMAND_LOG:?}"

if [[ "${HC_FAKE_CURL_RESULT:-0}" -ne 0 ]]; then
  exit "$HC_FAKE_CURL_RESULT"
fi

printf '%s\n' \
  '{"status":"ready","service":"hoaxconnect-backend","database":"ready"}'
FAKE_CURL

  chmod 0700 \
    "$HC_FAKE_BIN/docker" \
    "$HC_FAKE_BIN/curl"

  export HC_TEST_MODE=1
  export HC_ROOT_PREFIX="$HC_CASE_ROOT"
  export HC_LOCK_FILE="$HC_CASE_TEMP/backup.lock"
  export HC_COMMAND_LOG="$HC_CASE_TEMP/commands.log"
  export HC_RESTORE_COUNT_FILE="$HC_CASE_TEMP/restore-count"
  export HC_RESTORE_PRE_BACKUP_DIR="$HC_CASE_TEMP/pre-restore"
  export HC_FAKE_PG_RESTORE_FAIL_ONCE=0
  export HC_FAKE_CURL_RESULT=0

  : >"$HC_COMMAND_LOG"
  printf '%s\n' 0 >"$HC_RESTORE_COUNT_FILE"
}

hc_create_test_backup() {
  local original_path="$PATH"

  PATH="$HC_FAKE_BIN:$PATH"
  export PATH

  set +e
  HC_BACKUP_OUTPUT="$(
    "$HC_BACKUP_COMMAND" \
      --output "$HC_OUTPUT_DIR" 2>&1
  )"
  local status=$?
  set -e

  PATH="$original_path"
  export PATH

  if [[ "$status" -ne 0 ]]; then
    printf '%s\n' "$HC_BACKUP_OUTPUT" >&2
    return "$status"
  fi

  HC_ARCHIVE="$(
    find "$HC_OUTPUT_DIR" \
      -maxdepth 1 \
      -type f \
      -name '*.tar.gz' \
      -print -quit
  )"

  hc_assert_file_exists "$HC_ARCHIVE"
}

test_backup_archive_is_mode_0600() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  hc_assert_equal \
    "600" \
    "$(stat -c '%a' "$HC_ARCHIVE")"

  hc_backup_case_cleanup
}

test_backup_contains_required_members() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  local listing
  local member

  listing="$(tar -tzf "$HC_ARCHIVE")"

  for member in "${required_archive_members[@]}"; do
    hc_assert_contains "$listing" "$member" ||
      return 1
  done

  hc_backup_case_cleanup
}

test_manifest_contains_release_and_schema_metadata() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  local extracted="$HC_CASE_TEMP/extracted"
  local manifest

  mkdir -p "$extracted"
  tar -xzf "$HC_ARCHIVE" -C "$extracted"

  manifest="$(cat "$extracted/manifest.env")"

  hc_assert_contains \
    "$manifest" \
    "RELEASE_ID=$HC_TEST_RELEASE" ||
    return 1

  hc_assert_contains \
    "$manifest" \
    "SCHEMA_VERSION=001_initial.sql" ||
    return 1

  hc_assert_file_exists "$extracted/SHA256SUMS" ||
    return 1

  (
    cd "$extracted"
    sha256sum -c SHA256SUMS
  ) >/dev/null || return 1

  hc_backup_case_cleanup
}

test_backup_output_redacts_secrets() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  hc_assert_not_contains \
    "$HC_BACKUP_OUTPUT" \
    "$HC_TEST_SECRET" ||
    return 1

  if tar -xOzf "$HC_ARCHIVE" manifest.env 2>/dev/null |
      grep -Fq -- "$HC_TEST_SECRET"; then
    hc_test_fail "manifest contains a backend secret"
    return 1
  fi

  hc_backup_case_cleanup
}

hc_run_restore() {
  local original_path="$PATH"
  local status

  PATH="$HC_FAKE_BIN:$PATH"
  export PATH

  set +e
  HC_RESTORE_OUTPUT="$(
    "$HC_RESTORE_COMMAND" "$@" 2>&1
  )"
  status=$?
  set -e

  PATH="$original_path"
  export PATH

  return "$status"
}

test_restore_requires_explicit_confirmation() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  local status=0

  hc_run_restore \
    --backup "$HC_ARCHIVE" ||
    status=$?

  if [[ "$status" -eq 0 ]]; then
    hc_test_fail \
      "restore succeeded without --confirm-restore"
    return 1
  fi

  hc_assert_contains \
    "$HC_RESTORE_OUTPUT" \
    "confirm" ||
    return 1

  if grep -Fq \
      "pg_restore" \
      "$HC_COMMAND_LOG"; then
    hc_test_fail \
      "restore touched PostgreSQL without confirmation"
    return 1
  fi

  hc_backup_case_cleanup
}

test_restore_rejects_checksum_mismatch() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  local tampered="$HC_CASE_TEMP/tampered"
  local status=0

  mkdir -p "$tampered"
  tar -xzf "$HC_ARCHIVE" -C "$tampered"

  printf '%s\n' \
    "TAMPERED-DATABASE-DUMP" \
    >"$tampered/database.dump"

  tar -czf "$HC_CASE_TEMP/tampered.tar.gz" \
    -C "$tampered" \
    database.dump \
    config \
    nginx \
    manifest.env \
    SHA256SUMS

  chmod 0600 "$HC_CASE_TEMP/tampered.tar.gz"

  hc_run_restore \
    --backup "$HC_CASE_TEMP/tampered.tar.gz" \
    --confirm-restore ||
    status=$?

  if [[ "$status" -eq 0 ]]; then
    hc_test_fail \
      "restore accepted an invalid checksum"
    return 1
  fi

  hc_assert_contains \
    "$HC_RESTORE_OUTPUT" \
    "checksum" ||
    return 1

  if grep -Fq \
      "pg_restore" \
      "$HC_COMMAND_LOG"; then
    hc_test_fail \
      "checksum failure reached pg_restore"
    return 1
  fi

  hc_backup_case_cleanup
}

hc_restore_valid_archive() {
  hc_run_restore \
    --backup "$HC_ARCHIVE" \
    --confirm-restore
}

test_restore_creates_pre_restore_backup() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  hc_restore_valid_archive || {
    printf '%s\n' "$HC_RESTORE_OUTPUT" >&2
    return 1
  }

  local pre_restore_archive

  pre_restore_archive="$(
    find "$HC_RESTORE_PRE_BACKUP_DIR" \
      -maxdepth 1 \
      -type f \
      -name 'hoaxconnect-backup-*.tar.gz' \
      -print -quit
  )"

  hc_assert_file_exists "$pre_restore_archive" ||
    return 1

  python3 - "$HC_COMMAND_LOG" <<'PY_PRE_RESTORE_ORDER' || return 1
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

assert position(" pg_dump ") < position(" pg_restore "), lines
PY_PRE_RESTORE_ORDER

  hc_backup_case_cleanup
}

test_failed_restore_recovers_previous_database() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  export HC_FAKE_PG_RESTORE_FAIL_ONCE=1

  local status=0
  local restore_count

  hc_restore_valid_archive ||
    status=$?

  if [[ "$status" -eq 0 ]]; then
    hc_test_fail \
      "restore unexpectedly succeeded after primary pg_restore failure"
    return 1
  fi

  restore_count="$(cat "$HC_RESTORE_COUNT_FILE")"

  if [[ "$restore_count" -lt 2 ]]; then
    hc_test_fail \
      "failed restore did not invoke recovery pg_restore"
    return 1
  fi

  hc_assert_contains \
    "$HC_RESTORE_OUTPUT" \
    "recovered" ||
    return 1

  hc_backup_case_cleanup
}

test_restore_preserves_database_volume() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  hc_restore_valid_archive || {
    printf '%s\n' "$HC_RESTORE_OUTPUT" >&2
    return 1
  }

  if grep -Eq \
      'down[[:space:]]+-v|volume[[:space:]]+rm' \
      "$HC_COMMAND_LOG"; then
    hc_test_fail \
      "restore attempted to delete the database volume"
    return 1
  fi

  hc_assert_contains \
    "$(cat "$HC_COMMAND_LOG")" \
    "pg_restore" ||
    return 1

  hc_backup_case_cleanup
}

test_restore_requires_post_restart_readiness() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  hc_restore_valid_archive || {
    printf '%s\n' "$HC_RESTORE_OUTPUT" >&2
    return 1
  }

  python3 - "$HC_COMMAND_LOG" <<'PY_RESTORE_ORDER' || return 1
from pathlib import Path
import sys

lines = Path(sys.argv[1]).read_text(
    encoding="utf-8"
).splitlines()

def position(fragment: str, start: int = 0) -> int:
    for index in range(start, len(lines)):
        if fragment in lines[index]:
            return index
    raise AssertionError(f"missing command: {fragment}")

stop_api = position(" stop api")
restore = position(" pg_restore ", stop_api + 1)
start_api = position(" up -d api", restore + 1)
ready = position("/api/v1/health/ready", start_api + 1)

assert stop_api < restore < start_api < ready, lines
PY_RESTORE_ORDER

  hc_backup_case_cleanup
}

test_backup_archive_contains_no_links() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  if tar -tvzf "$HC_ARCHIVE" |
      awk '$1 ~ /^[lh]/ { found = 1 }
           END { exit found ? 0 : 1 }'
  then
    hc_test_fail \
      "backup archive contains a symbolic or hard link"
    return 1
  fi

  hc_backup_case_cleanup
}

test_restore_rejects_archive_links() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  local malicious="$HC_CASE_TEMP/malicious"
  local archive="$HC_CASE_TEMP/malicious-links.tar.gz"
  local status=0

  mkdir -p "$malicious"
  tar -xzf "$HC_ARCHIVE" -C "$malicious"

  ln -s \
    /tmp/hoaxconnect-restore-escape-target \
    "$malicious/config/escape-link"

  tar -czf "$archive" \
    -C "$malicious" \
    database.dump \
    config \
    nginx \
    manifest.env \
    SHA256SUMS

  chmod 0600 "$archive"
  : >"$HC_COMMAND_LOG"

  hc_run_restore \
    --backup "$archive" \
    --confirm-restore ||
    status=$?

  if [[ "$status" -eq 0 ]]; then
    hc_test_fail \
      "restore accepted an archive containing a link"
    return 1
  fi

  hc_assert_contains \
    "$HC_RESTORE_OUTPUT" \
    "link" ||
    return 1

  if grep -Fq "pg_restore" "$HC_COMMAND_LOG"; then
    hc_test_fail \
      "unsafe archive link reached pg_restore"
    return 1
  fi

  hc_backup_case_cleanup
}

test_recovery_stops_api_before_second_restore() {
  hc_backup_case_setup
  hc_create_test_backup || return 1

  export HC_FAKE_PG_RESTORE_FAIL_ONCE=1
  : >"$HC_COMMAND_LOG"
  printf '%s\n' 0 >"$HC_RESTORE_COUNT_FILE"

  local status=0

  hc_restore_valid_archive ||
    status=$?

  if [[ "$status" -eq 0 ]]; then
    hc_test_fail \
      "restore failure unexpectedly returned success"
    return 1
  fi

  python3 - "$HC_COMMAND_LOG" <<'PY_RECOVERY_STOP_ORDER' || return 1
from pathlib import Path
import sys

lines = Path(sys.argv[1]).read_text(
    encoding="utf-8"
).splitlines()

stops = [
    index
    for index, line in enumerate(lines)
    if " stop api" in line
]

restores = [
    index
    for index, line in enumerate(lines)
    if " pg_restore " in line
]

assert len(stops) >= 2, lines
assert len(restores) >= 2, lines
assert stops[0] < restores[0] < stops[1] < restores[1], lines
PY_RECOVERY_STOP_ORDER

  hc_backup_case_cleanup
}

hc_run_backup_restore_test() {
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
  local test_name
  local tests=(
    test_cli_contract
    test_library_contract_markers
    test_behavioral_contract_is_registered
    test_backup_archive_is_mode_0600
    test_backup_contains_required_members
    test_manifest_contains_release_and_schema_metadata
    test_backup_output_redacts_secrets
    test_restore_requires_explicit_confirmation
    test_restore_rejects_checksum_mismatch
    test_restore_creates_pre_restore_backup
    test_failed_restore_recovers_previous_database
    test_restore_preserves_database_volume
    test_restore_requires_post_restart_readiness
    test_backup_archive_contains_no_links
    test_restore_rejects_archive_links
    test_recovery_stops_api_before_second_restore
  )

  failures=0

  for test_name in "${tests[@]}"; do
    if ! hc_run_backup_restore_test "$test_name"; then
      failures=$((failures + 1))
    fi
  done

  if [[ "$failures" -ne 0 ]]; then
    printf 'FAILED BACKUP/RESTORE TESTS: %s\n' \
      "$failures" >&2
    return 1
  fi

  printf 'ALL BACKUP TESTS PASSED\n'
}

trap hc_backup_case_cleanup EXIT
main "$@"
