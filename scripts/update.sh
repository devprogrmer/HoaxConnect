#!/usr/bin/env bash
set -Eeuo pipefail

HC_UPDATE_SCRIPT_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
  pwd -P
)"
HC_UPDATE_SOURCE_ROOT="$(
  cd -- "$HC_UPDATE_SCRIPT_DIR/.." &&
  pwd -P
)"

# Source-safe installer exports the validated deployment primitives.
# shellcheck disable=SC1090,SC1091
source "$HC_UPDATE_SCRIPT_DIR/install.sh"
# shellcheck disable=SC1090,SC1091
source "$HC_UPDATE_SCRIPT_DIR/lib/backup.sh"

HC_UPDATE_SOURCE_REF=""
HC_UPDATE_PREVIOUS_RELEASE_ID=""
HC_UPDATE_PREVIOUS_RELEASE_DIR=""
HC_UPDATE_BACKUP_ARCHIVE=""
HC_UPDATE_PREVIOUS_NGINX=""
HC_UPDATE_PREVIOUS_VOLUME=""
HC_UPDATE_LOG=""

hc_update_usage() {
  cat <<'USAGE'
Usage:
  scripts/update.sh --source-ref REF

Options:
  --source-ref REF  Git commit, tag, or branch to deploy.
  --help            Show this help.
USAGE
}

hc_update_parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --source-ref)
        if [[ "$#" -lt 2 || -z "${2:-}" ]]; then
          hc_die "--source-ref requires a value."
          return 1
        fi

        HC_UPDATE_SOURCE_REF="$2"
        shift 2
        ;;
      --help|-h)
        hc_update_usage
        return 2
        ;;
      *)
        hc_die "Unknown update option: $1"
        return 1
        ;;
    esac
  done

  if [[ -z "$HC_UPDATE_SOURCE_REF" ]]; then
    hc_die "Required option: --source-ref"
    return 1
  fi
}

hc_update_require_root() {
  local effective_euid="${EUID:-$(id -u)}"

  if [[ "${HC_TEST_MODE:-0}" == "1" &&
        -n "${HC_UPDATE_EUID_OVERRIDE:-}" ]]; then
    effective_euid="$HC_UPDATE_EUID_OVERRIDE"
  fi

  if [[ ! "$effective_euid" =~ ^[0-9]+$ ||
        "$effective_euid" -ne 0 ]]; then
    hc_die "This command must be run as root."
    return 1
  fi
}

hc_update_read_env() {
  local path="$1"
  local key="$2"

  awk \
    -F= \
    -v requested="$key" \
    '$1 == requested {
       sub(/^[^=]*=/, "")
       print
       exit
     }' \
    "$path"
}

hc_update_load_previous_state() {
  local actual_install_env

  actual_install_env="$(hc_path "$HC_INSTALL_ENV")" ||
    return 1

  if [[ ! -f "$actual_install_env" ]]; then
    hc_die "HoaxConnect installation metadata is unavailable."
    return 1
  fi

  HC_DOMAIN="$(hc_update_read_env "$actual_install_env" DOMAIN)"
  HC_ADMIN_ORIGIN="$(
    hc_update_read_env "$actual_install_env" ADMIN_ORIGIN
  )"
  HC_EMAIL="$(hc_update_read_env "$actual_install_env" ACME_EMAIL)"
  HC_PUBLIC_IP="$(hc_update_read_env "$actual_install_env" PUBLIC_IP)"
  HC_TLS_MODE="$(hc_update_read_env "$actual_install_env" TLS_MODE)"

  HC_UPDATE_PREVIOUS_RELEASE_ID="$(
    hc_update_read_env "$actual_install_env" RELEASE_ID
  )"
  HC_UPDATE_PREVIOUS_RELEASE_DIR="$(
    hc_update_read_env "$actual_install_env" RELEASE_DIR
  )"

  if [[ -z "$HC_DOMAIN" ||
        -z "$HC_EMAIL" ||
        -z "$HC_TLS_MODE" ||
        ! "$HC_UPDATE_PREVIOUS_RELEASE_ID" =~ ^[0-9a-f]{40}$ ||
        "$HC_UPDATE_PREVIOUS_RELEASE_DIR" != \
          "/opt/hoaxconnect/releases/$HC_UPDATE_PREVIOUS_RELEASE_ID" ]]; then
    hc_die "Installed update metadata is invalid."
    return 1
  fi

  if [[ -z "$HC_ADMIN_ORIGIN" ]]; then
    HC_ADMIN_ORIGIN="https://$HC_DOMAIN"
  fi

  export \
    HC_DOMAIN \
    HC_ADMIN_ORIGIN \
    HC_EMAIL \
    HC_PUBLIC_IP \
    HC_TLS_MODE
}

hc_update_volume_identity() {
  docker volume inspect hoaxconnect_pgdata \
    --format '{{.Name}}|{{.Driver}}|{{.Mountpoint}}'
}

hc_update_prepare_log() {
  local actual_log_root

  actual_log_root="$(hc_path "$HC_MAINTENANCE_LOG_ROOT")" ||
    return 1

  mkdir -p -- "$actual_log_root"
  chmod 0700 "$actual_log_root"

  HC_UPDATE_LOG="$actual_log_root/update-$(date -u +%Y%m%dT%H%M%SZ).log"
  : >"$HC_UPDATE_LOG"
  chmod 0600 "$HC_UPDATE_LOG"
}

hc_update_record() {
  local key="$1"
  local value="$2"

  if [[ -n "$HC_UPDATE_LOG" ]]; then
    printf '%s=%s\n' "$key" "$value" >>"$HC_UPDATE_LOG"
  fi
}

hc_update_create_backup() {
  local output
  local actual_output

  actual_output="$(hc_path "/var/backups/hoaxconnect")" ||
    return 1

  output="$(hc_backup_create "$actual_output")" ||
    return 1

  HC_UPDATE_BACKUP_ARCHIVE="$(
    sed -n 's/^BACKUP_ARCHIVE=//p' <<<"$output" |
      tail -n 1
  )"

  if [[ -z "$HC_UPDATE_BACKUP_ARCHIVE" ||
        ! -f "$HC_UPDATE_BACKUP_ARCHIVE" ]]; then
    hc_die "Pre-update backup archive is unavailable."
    return 1
  fi

  hc_update_record \
    BACKUP_ARCHIVE \
    "$HC_UPDATE_BACKUP_ARCHIVE"

  hc_log INFO \
    "Pre-update backup: $HC_UPDATE_BACKUP_ARCHIVE"
}

hc_update_backup_nginx() {
  hc_install_backup_active_nginx ||
    return 1

  HC_UPDATE_PREVIOUS_NGINX="$HC_INSTALL_NGINX_BACKUP"
  hc_update_record \
    NGINX_BACKUP \
    "$HC_UPDATE_PREVIOUS_NGINX"
}

hc_update_resolve_candidate() {
  HC_SOURCE_REF="$HC_UPDATE_SOURCE_REF"
  export HC_SOURCE_ROOT="$HC_UPDATE_SOURCE_ROOT"

  hc_install_resolve_release ||
    return 1

  hc_update_record \
    PREVIOUS_RELEASE \
    "$HC_UPDATE_PREVIOUS_RELEASE_ID"
  hc_update_record CANDIDATE_RELEASE "$HC_RELEASE_ID"
}

hc_update_restore_previous_api() {
  HC_RELEASE_ID="$HC_UPDATE_PREVIOUS_RELEASE_ID"
  HC_RELEASE_DIR="$HC_UPDATE_PREVIOUS_RELEASE_DIR"
  HC_ENV_FILE="$HC_BACKEND_ENV"
  HC_COMPOSE_FILE="$(
    hc_path "$HC_UPDATE_PREVIOUS_RELEASE_DIR"
  )/deploy/compose/compose.source.yml"

  export \
    HC_RELEASE_ID \
    HC_RELEASE_DIR \
    HC_ENV_FILE \
    HC_COMPOSE_FILE

  if [[ ! -f "$HC_COMPOSE_FILE" ]]; then
    hc_die "Previous release Compose file is unavailable."
    return 1
  fi

  hc_compose up -d api ||
    return 1
  hc_wait_service api 180 ||
    return 1
  hc_install_verify_local_health
}

hc_update_rollback() {
  local rollback_result=0

  hc_log ERROR \
    "Update failed; restoring previous application state."

  if [[ -n "$HC_UPDATE_PREVIOUS_NGINX" &&
        -d "$HC_UPDATE_PREVIOUS_NGINX" ]]; then
    hc_install_restore_active_nginx ||
      rollback_result=1
  fi

  hc_update_restore_previous_api ||
    rollback_result=1

  hc_log ERROR \
    "Database migrations were not rolled back. Verified backup: $HC_UPDATE_BACKUP_ARCHIVE"

  hc_update_record RESULT failed
  hc_update_record \
    MIGRATION_ROLLBACK \
    not_attempted

  return "$rollback_result"
}

hc_update_transaction() {
  local candidate_release_id
  local candidate_release_dir

  hc_update_prepare_log ||
    return 1

  HC_UPDATE_PREVIOUS_VOLUME="$(hc_update_volume_identity)" ||
    return 1

  hc_update_record \
    VOLUME_BEFORE \
    "$HC_UPDATE_PREVIOUS_VOLUME"

  hc_update_create_backup ||
    return 1

  hc_update_resolve_candidate ||
    return 1

  candidate_release_id="$HC_RELEASE_ID"
  candidate_release_dir="$HC_RELEASE_DIR"

  hc_install_stage_release ||
    return 1
  hc_install_use_staged_release_assets ||
    return 1

  hc_update_backup_nginx ||
    return 1

  hc_install_start_candidate ||
    return 1
  hc_install_configure_tls ||
    return 1

  HC_RELEASE_ID="$candidate_release_id"
  HC_RELEASE_DIR="$candidate_release_dir"
  HC_SOURCE_REF="$HC_UPDATE_SOURCE_REF"

  export \
    HC_RELEASE_ID \
    HC_RELEASE_DIR \
    HC_SOURCE_REF

  hc_install_activate_release ||
    return 1

  local volume_after

  volume_after="$(hc_update_volume_identity)" ||
    return 1

  if [[ "$volume_after" != "$HC_UPDATE_PREVIOUS_VOLUME" ]]; then
    hc_die "Database volume identity changed during update."
    return 1
  fi

  hc_update_record VOLUME_AFTER "$volume_after"
  hc_update_record RESULT success

  hc_install_remove_nginx_backup
  HC_UPDATE_PREVIOUS_NGINX=""

  hc_log INFO \
    "Health-gated update completed: $HC_RELEASE_ID"
}

hc_update_apply() {
  local result=0

  hc_update_transaction ||
    result=$?

  if [[ "$result" -eq 0 ]]; then
    return 0
  fi

  if [[ -n "$HC_UPDATE_BACKUP_ARCHIVE" ]]; then
    hc_update_rollback ||
      hc_log ERROR "Update rollback encountered an error."
  fi

  hc_install_remove_nginx_backup
  return "$result"
}

main() {
  local parse_result=0

  hc_update_parse_args "$@" ||
    parse_result=$?

  if [[ "$parse_result" -eq 2 ]]; then
    return 0
  fi

  if [[ "$parse_result" -ne 0 ]]; then
    return "$parse_result"
  fi

  hc_update_require_root ||
    return 1
  hc_acquire_lock ||
    return 1
  hc_update_load_previous_state ||
    return 1
  hc_update_apply
}

main "$@"
