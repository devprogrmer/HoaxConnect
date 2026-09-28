#!/usr/bin/env bash
set -Eeuo pipefail

HC_CONFIRMED=0
HC_INSTALL_ROOT="/opt/hoaxconnect"
HC_CURRENT_LINK="/opt/hoaxconnect/current"
HC_CONFIG_ROOT="/etc/hoaxconnect"
HC_INSTALL_ENV="/etc/hoaxconnect/install.env"
HC_STATE_ROOT="/var/lib/hoaxconnect"
HC_BACKUP_ROOT="/var/backups/hoaxconnect"
HC_LOG_ROOT="/var/log/hoaxconnect"
HC_PROJECT="hoaxconnect"
HC_DATABASE_VOLUME="hoaxconnect_pgdata"
HC_NGINX_AVAILABLE="/etc/nginx/sites-available/hoaxconnect-control-plane.conf"
HC_NGINX_ENABLED="/etc/nginx/sites-enabled/hoaxconnect-control-plane.conf"

hc_usage() {
  cat <<'EOF'
Usage:
  scripts/uninstall.sh --yes

Removes only the HoaxConnect runtime containers and owned Nginx files.

Preserved:
  /etc/hoaxconnect
  /var/lib/hoaxconnect
  /var/backups/hoaxconnect
  /opt/hoaxconnect
  hoaxconnect_pgdata
EOF
}

hc_die() {
  printf '[ERROR] %s\n' "$*" >&2
  return 1
}

hc_log() {
  printf '[INFO] %s\n' "$*"
}

hc_path() {
  local path="$1"

  if [[ -n "${HC_ROOT_PREFIX:-}" ]]; then
    [[ "${HC_TEST_MODE:-0}" == "1" ]] ||
      hc_die "HC_ROOT_PREFIX requires HC_TEST_MODE=1."

    printf '%s%s\n' "${HC_ROOT_PREFIX%/}" "$path"
  else
    printf '%s\n' "$path"
  fi
}

hc_parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --yes)
        HC_CONFIRMED=1
        ;;
      --help|-h)
        hc_usage
        return 2
        ;;
      *)
        hc_die "Unknown option: $1"
        ;;
    esac

    shift
  done

  [[ "$HC_CONFIRMED" -eq 1 ]] ||
    hc_die "Runtime removal requires explicit --yes confirmation."
}

hc_require_root() {
  local effective_euid="$EUID"

  if [[ "${HC_TEST_MODE:-0}" == "1" &&
        -n "${HC_UNINSTALL_EUID_OVERRIDE:-}" ]]; then
    effective_euid="$HC_UNINSTALL_EUID_OVERRIDE"
  fi

  [[ "$effective_euid" -eq 0 ]] ||
    hc_die "Uninstall must run as root."
}

hc_backup_first() {
  local output
  local command_path

  output="$(hc_path "$HC_BACKUP_ROOT")"
  command_path="${HC_UNINSTALL_BACKUP_COMMAND:-}"

  if [[ -z "$command_path" ]]; then
    command_path="$(
      cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
      pwd -P
    )/backup.sh"
  elif [[ "${HC_TEST_MODE:-0}" != "1" ]]; then
    hc_die "Backup override requires HC_TEST_MODE=1."
    return 1
  fi

  [[ -x "$command_path" ]] ||
    hc_die "Backup command is unavailable."

  mkdir -p -- "$output"
  chmod 0700 "$output"

  hc_log "Creating verified pre-uninstall backup."
  "$command_path" --output "$output"
  hc_log "Verified pre-uninstall backup completed."
}

hc_find_compose() {
  local current
  local candidate

  current="$(hc_path "$HC_CURRENT_LINK")"
  candidate="$current/deploy/compose/compose.source.yml"

  if [[ -f "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$(
    cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &&
    pwd -P
  )/deploy/compose/compose.source.yml"

  [[ -f "$candidate" ]] ||
    hc_die "Compose configuration is unavailable."

  printf '%s\n' "$candidate"
}

hc_read_install_value() {
  local install_env="$1"
  local key="$2"

  awk -F= -v key="$key" \
    '$1 == key {
      print substr($0, index($0, "=") + 1)
      exit
    }' "$install_env"
}

hc_load_compose_metadata() {
  local install_env
  local release_id
  local release_dir

  install_env="$(hc_path "$HC_INSTALL_ENV")"

  if [[ -f "$install_env" ]]; then
    release_id="$(
      hc_read_install_value "$install_env" RELEASE_ID
    )"
    release_dir="$(
      hc_read_install_value "$install_env" RELEASE_DIR
    )"
  elif [[ "${HC_TEST_MODE:-0}" == "1" ]]; then
    release_id="0000000000000000000000000000000000000000"
    release_dir="$HC_INSTALL_ROOT/releases/$release_id"
  else
    hc_die "Installation metadata is unavailable."
    return 1
  fi

  [[ "$release_id" =~ ^[0-9a-f]{40}$ ]] || {
    hc_die "Installed release identifier is invalid."
    return 1
  }

  [[ "$release_dir" == \
    "$HC_INSTALL_ROOT/releases/$release_id" ]] || {
    hc_die "Installed release directory is invalid."
    return 1
  }

  HC_RELEASE_ID="$release_id"
  HC_RELEASE_DIR="$release_dir"
  HC_ENV_FILE="$HC_CONFIG_ROOT/backend.env"

  export HC_RELEASE_ID HC_RELEASE_DIR HC_ENV_FILE
}

hc_stop_runtime() {
  local compose_file
  local env_file

  hc_load_compose_metadata || return 1

  compose_file="$(hc_find_compose)"
  env_file="$(hc_path "$HC_CONFIG_ROOT/backend.env")"

  command -v docker >/dev/null 2>&1 ||
    hc_die "Docker is unavailable."

  hc_log \
    "Stopping owned containers while preserving $HC_DATABASE_VOLUME."

  if [[ -f "$env_file" ]]; then
    docker compose \
      --project-name "$HC_PROJECT" \
      --env-file "$env_file" \
      --file "$compose_file" \
      down \
      --remove-orphans
  else
    docker compose \
      --project-name "$HC_PROJECT" \
      --file "$compose_file" \
      down \
      --remove-orphans
  fi
}

hc_restore_owned_nginx() {
  local backup_directory="$1"
  local available="$2"
  local enabled="$3"

  rm -f -- "$enabled" "$available"

  if [[ -e "$backup_directory/available" ]]; then
    cp -a -- "$backup_directory/available" "$available"
  fi

  if [[ -e "$backup_directory/enabled" ||
        -L "$backup_directory/enabled" ]]; then
    cp -a -- "$backup_directory/enabled" "$enabled"
  fi
}

hc_remove_owned_nginx() {
  local available
  local enabled
  local backup_directory
  local nginx_command="${HC_UNINSTALL_NGINX_COMMAND:-nginx}"
  local systemctl_command="${HC_UNINSTALL_SYSTEMCTL_COMMAND:-systemctl}"

  if [[ "${HC_TEST_MODE:-0}" != "1" &&
        ( -n "${HC_UNINSTALL_NGINX_COMMAND:-}" ||
          -n "${HC_UNINSTALL_SYSTEMCTL_COMMAND:-}" ) ]]; then
    hc_die "Nginx command overrides require HC_TEST_MODE=1."
    return 1
  fi

  available="$(hc_path "$HC_NGINX_AVAILABLE")"
  enabled="$(hc_path "$HC_NGINX_ENABLED")"

  backup_directory="$(mktemp -d)"
  chmod 0700 "$backup_directory"

  if [[ -e "$available" ]]; then
    cp -a -- "$available" "$backup_directory/available"
  fi

  if [[ -e "$enabled" || -L "$enabled" ]]; then
    cp -a -- "$enabled" "$backup_directory/enabled"
  fi

  rm -f -- "$enabled" "$available"

  if ! "$nginx_command" -t; then
    hc_restore_owned_nginx \
      "$backup_directory" \
      "$available" \
      "$enabled"

    rm -rf -- "$backup_directory"
    hc_die "Nginx validation failed; owned configuration restored."
    return 1
  fi

  if ! "$systemctl_command" reload nginx; then
    hc_restore_owned_nginx \
      "$backup_directory" \
      "$available" \
      "$enabled"

    "$nginx_command" -t >/dev/null 2>&1 || true
    "$systemctl_command" reload nginx >/dev/null 2>&1 || true

    rm -rf -- "$backup_directory"
    hc_die "Nginx reload failed; owned configuration restored."
    return 1
  fi

  rm -rf -- "$backup_directory"
  hc_log "Owned Nginx configuration removed."
}

hc_write_record() {
  local directory
  local record

  directory="$(hc_path "$HC_LOG_ROOT")"
  mkdir -p -- "$directory"
  chmod 0700 "$directory"

  record="$directory/uninstall-$(date -u +%Y%m%dT%H%M%SZ).log"

  {
    printf 'RESULT=runtime-removed\n'
    printf 'CONFIG_ROOT=%s\n' "$HC_CONFIG_ROOT"
    printf 'STATE_ROOT=%s\n' "$HC_STATE_ROOT"
    printf 'BACKUP_ROOT=%s\n' "$HC_BACKUP_ROOT"
    printf 'INSTALL_ROOT=%s\n' "$HC_INSTALL_ROOT"
    printf 'DATABASE_VOLUME=%s\n' "$HC_DATABASE_VOLUME"
  } > "$record"

  chmod 0600 "$record"
  hc_log "Uninstall record: $record"
}

hc_apply() {
  hc_backup_first
  hc_stop_runtime
  hc_remove_owned_nginx
  hc_write_record

  hc_log \
    "Runtime removed; configuration, releases, backups, and database data preserved."
}

main() {
  local result=0

  set +e
  hc_parse_args "$@"
  result=$?
  set -e

  [[ "$result" -ne 2 ]] || return 0
  [[ "$result" -eq 0 ]] || return "$result"

  hc_require_root
  hc_apply
}

main "$@"
