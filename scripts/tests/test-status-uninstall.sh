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

HC_STATUS="$HC_ROOT/scripts/status.sh"
HC_UNINSTALL="$HC_ROOT/scripts/uninstall.sh"

required_contracts=(
  status_cli
  status_json_redaction
  status_release_health
  status_network_boundaries
  status_unavailable_components
  uninstall_confirmation
  uninstall_backup_first
  uninstall_owned_nginx_only
  uninstall_preserves_configuration
  uninstall_preserves_backups
  uninstall_preserves_volume
  uninstall_has_no_purge
  uninstall_backup_failure_is_non_destructive
  uninstall_nginx_failure_restores_owned_files
)

missing=()

for path in "$HC_STATUS" "$HC_UNINSTALL"; do
  [[ -f "$path" ]] || missing+=("$path")
done

if [[ "${#missing[@]}" -gt 0 ]]; then
  printf '%s\n' \
    "EXPECTED RED: status and uninstall implementation missing:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

HC_CASE_ROOT=""
HC_FAKE_BIN=""
HC_COMMAND_LOG=""

hc_case_cleanup() {
  if [[ -n "$HC_CASE_ROOT" &&
        "$HC_CASE_ROOT" == /tmp/hoaxconnect-task7.* ]]; then
    rm -rf -- "$HC_CASE_ROOT"
  fi

  HC_CASE_ROOT=""
  HC_FAKE_BIN=""
  HC_COMMAND_LOG=""
}

hc_case_setup() {
  hc_case_cleanup

  HC_CASE_ROOT="$(mktemp -d /tmp/hoaxconnect-task7.XXXXXX)"
  HC_FAKE_BIN="$HC_CASE_ROOT/bin"
  HC_COMMAND_LOG="$HC_CASE_ROOT/commands.log"

  mkdir -p \
    "$HC_FAKE_BIN" \
    "$HC_CASE_ROOT/root/etc/hoaxconnect" \
    "$HC_CASE_ROOT/root/var/lib/hoaxconnect" \
    "$HC_CASE_ROOT/root/var/backups/hoaxconnect" \
    "$HC_CASE_ROOT/root/var/log/hoaxconnect" \
    "$HC_CASE_ROOT/root/etc/nginx/sites-available" \
    "$HC_CASE_ROOT/root/etc/nginx/sites-enabled"

  : > "$HC_COMMAND_LOG"

  printf '%s\n' "owned-available" > \
    "$HC_CASE_ROOT/root/etc/nginx/sites-available/hoaxconnect-control-plane.conf"

  ln -s \
    /etc/nginx/sites-available/hoaxconnect-control-plane.conf \
    "$HC_CASE_ROOT/root/etc/nginx/sites-enabled/hoaxconnect-control-plane.conf"

  printf '%s\n' "unrelated" > \
    "$HC_CASE_ROOT/root/etc/nginx/sites-available/unrelated.conf"

  printf '%s\n' "preserve-config" > \
    "$HC_CASE_ROOT/root/etc/hoaxconnect/preserved.conf"

  printf '%s\n' "preserve-state" > \
    "$HC_CASE_ROOT/root/var/lib/hoaxconnect/preserved.state"

  printf '%s\n' "preserve-backup" > \
    "$HC_CASE_ROOT/root/var/backups/hoaxconnect/preserved.backup"
}

hc_fake_command() {
  local name="$1"

  shift

  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'set -Eeuo pipefail'
    # The quoted command is intentionally emitted for the fake executable.
    # shellcheck disable=SC2016
    printf '%s\n' \
      'printf "%s %s\n" "${0##*/}" "$*" >> "$HC_COMMAND_LOG"'
    printf '%s\n' "$@"
  } > "$HC_FAKE_BIN/$name"

  chmod 0755 "$HC_FAKE_BIN/$name"
}

hc_run_uninstall() {
  PATH="$HC_FAKE_BIN:$PATH" \
  HC_TEST_MODE=1 \
  HC_ROOT_PREFIX="$HC_CASE_ROOT/root" \
  HC_COMMAND_LOG="$HC_COMMAND_LOG" \
  HC_UNINSTALL_EUID_OVERRIDE=0 \
  HC_UNINSTALL_BACKUP_COMMAND="$HC_FAKE_BIN/backup-command" \
  HC_UNINSTALL_NGINX_COMMAND="$HC_FAKE_BIN/nginx" \
  HC_UNINSTALL_SYSTEMCTL_COMMAND="$HC_FAKE_BIN/systemctl" \
    bash "$HC_UNINSTALL" --yes
}

uninstall_backup_failure_is_non_destructive() {
  local output
  local result

  hc_case_setup

  hc_fake_command backup-command 'exit 41'
  hc_fake_command docker 'exit 0'
  hc_fake_command nginx 'exit 0'
  hc_fake_command systemctl 'exit 0'

  set +e
  output="$(hc_run_uninstall 2>&1)"
  result=$?
  set -e

  [[ "$result" -ne 0 ]]
  [[ "$output" != *"task7-secret"* ]]

  if grep -Fq 'docker ' "$HC_COMMAND_LOG"; then
    return 1
  fi

  [[ -e \
    "$HC_CASE_ROOT/root/etc/nginx/sites-available/hoaxconnect-control-plane.conf" ]]

  [[ -L \
    "$HC_CASE_ROOT/root/etc/nginx/sites-enabled/hoaxconnect-control-plane.conf" ]]
}

uninstall_nginx_failure_restores_owned_files() {
  local result

  hc_case_setup

  hc_fake_command backup-command \
    'printf "%s\n" "BACKUP_ARCHIVE=/tmp/verified.tar.gz"'

  hc_fake_command docker 'exit 0'

  hc_fake_command nginx \
    'if [[ "$*" == "-t" ]]; then exit 42; fi' \
    'exit 0'

  hc_fake_command systemctl 'exit 0'

  set +e
  hc_run_uninstall >/dev/null 2>&1
  result=$?
  set -e

  [[ "$result" -ne 0 ]]

  grep -Fq 'docker compose' "$HC_COMMAND_LOG" || return 1
  grep -Fq 'nginx -t' "$HC_COMMAND_LOG" || return 1

  [[ -e \
    "$HC_CASE_ROOT/root/etc/nginx/sites-available/hoaxconnect-control-plane.conf" ]]

  [[ -L \
    "$HC_CASE_ROOT/root/etc/nginx/sites-enabled/hoaxconnect-control-plane.conf" ]]

  [[ -e \
    "$HC_CASE_ROOT/root/etc/nginx/sites-available/unrelated.conf" ]]

  if grep -Eq \
    'volume[[:space:]]+rm|down[[:space:]]+-v' \
    "$HC_COMMAND_LOG"; then
    return 1
  fi
}

check_contract() {
  local contract="$1"

  case "$contract" in
    status_cli)
      grep -Fq -- '--json' "$HC_STATUS"
      ;;
    status_json_redaction)
      grep -Eq 'redact|REDACTED|secret' "$HC_STATUS"
      ;;
    status_release_health)
      grep -Eq 'release|RELEASE' "$HC_STATUS" &&
        grep -Eq 'health|ready' "$HC_STATUS"
      ;;
    status_network_boundaries)
      grep -Fq '127.0.0.1:3100' "$HC_STATUS" &&
        grep -Eq 'postgres|PostgreSQL|5432' "$HC_STATUS"
      ;;
    status_unavailable_components)
      grep -Eq 'unavailable|unknown' "$HC_STATUS"
      ;;
    uninstall_confirmation)
      grep -Fq -- '--yes' "$HC_UNINSTALL"
      ;;
    uninstall_backup_first)
      grep -Eq 'backup\.sh|hc_backup_create' "$HC_UNINSTALL"
      ;;
    uninstall_owned_nginx_only)
      grep -Fq 'hoaxconnect-control-plane.conf' "$HC_UNINSTALL"
      ;;
    uninstall_preserves_configuration)
      grep -Fq '/etc/hoaxconnect' "$HC_UNINSTALL" &&
        grep -Fq '/var/lib/hoaxconnect' "$HC_UNINSTALL"
      ;;
    uninstall_preserves_backups)
      grep -Fq '/var/backups/hoaxconnect' "$HC_UNINSTALL"
      ;;
    uninstall_preserves_volume)
      grep -Fq 'hoaxconnect_pgdata' "$HC_UNINSTALL"
      ;;
    uninstall_has_no_purge)
      if grep -Eq \
        'down[[:space:]]+-v|--volumes|volume[[:space:]]+rm|--purge-data' \
        "$HC_UNINSTALL"; then
        return 1
      fi
      ;;
    uninstall_backup_failure_is_non_destructive)
      uninstall_backup_failure_is_non_destructive
      ;;
    uninstall_nginx_failure_restores_owned_files)
      uninstall_nginx_failure_restores_owned_files
      ;;
    *)
      return 1
      ;;
  esac
}

main() {
  local contract
  local failures=0

  for contract in "${required_contracts[@]}"; do
    if check_contract "$contract"; then
      printf 'PASS: %s\n' "$contract"
    else
      printf 'FAIL: %s\n' "$contract" >&2
      failures=$((failures + 1))
    fi
  done

  if [[ "$failures" -ne 0 ]]; then
    printf 'FAILED STATUS/UNINSTALL CONTRACTS: %s\n' \
      "$failures" >&2
    return 1
  fi

  printf 'ALL STATUS/UNINSTALL CONTRACTS PASSED\n'
}

trap hc_case_cleanup EXIT
main "$@"
