#!/usr/bin/env bash

# HoaxConnect portable deployment shell foundation.

umask 077

: "${HC_EXEC_MODE:=apply}"

HC_LOCK_FD=""

hc_log() {
  local level="${1:-INFO}"
  shift || true

  local message="$*"
  local rendered="$message"
  local secret

  if declare -p HC_SECRET_VALUES >/dev/null 2>&1; then
    for secret in "${HC_SECRET_VALUES[@]}"; do
      if [[ -n "$secret" ]]; then
        rendered="${rendered//"$secret"/[REDACTED]}"
      fi
    done
  fi

  printf '[%s] %s\n' "$level" "$rendered" >&2
}

hc_die() {
  hc_log ERROR "$*"
  return 1
}

hc_require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    hc_die "This command must be run as root."
    return 1
  fi
}

hc_require_command() {
  local command_name="${1:-}"

  if [[ -z "$command_name" ]]; then
    hc_die "A command name is required."
    return 1
  fi

  if ! command -v "$command_name" >/dev/null 2>&1; then
    hc_die "Required command is unavailable: $command_name"
    return 1
  fi
}

hc_path() {
  local absolute_path="${1:-}"
  local root_prefix="${HC_ROOT_PREFIX:-}"

  if [[ -z "$absolute_path" ||
        "$absolute_path" != /* ]]; then
    hc_die "An absolute path is required."
    return 1
  fi

  if [[ -z "$root_prefix" ]]; then
    printf '%s\n' "$absolute_path"
    return 0
  fi

  if [[ "${HC_TEST_MODE:-0}" != "1" ]]; then
    hc_die "HC_ROOT_PREFIX is permitted only in test mode."
    return 1
  fi

  if [[ "$root_prefix" != /* ]]; then
    hc_die "HC_ROOT_PREFIX must be an absolute path."
    return 1
  fi

  printf '%s%s\n' "${root_prefix%/}" "$absolute_path"
}

hc_acquire_lock() {
  local default_lock="/run/lock/hoaxconnect-deploy.lock"
  local lock_file="${HC_LOCK_FILE:-$default_lock}"
  local lock_directory

  if [[ "$lock_file" != "$default_lock" &&
        "${HC_TEST_MODE:-0}" != "1" ]]; then
    hc_die "HC_LOCK_FILE may be overridden only in test mode."
    return 1
  fi

  hc_require_command flock || return 1

  lock_directory="$(dirname -- "$lock_file")"
  mkdir -p -- "$lock_directory"

  exec {HC_LOCK_FD}> "$lock_file"

  if ! flock -n "$HC_LOCK_FD"; then
    hc_die "Another HoaxConnect deployment operation is active."
    return 1
  fi
}

hc_render_command() {
  local rendered=""
  local argument
  local escaped

  for argument in "$@"; do
    printf -v escaped '%q' "$argument"

    if [[ -n "$rendered" ]]; then
      rendered+=" "
    fi

    rendered+="$escaped"
  done

  printf '%s\n' "$rendered"
}

hc_run() {
  local mode="${HC_EXEC_MODE:-apply}"
  local rendered

  if [[ "$#" -eq 0 ]]; then
    hc_die "hc_run requires a command."
    return 1
  fi

  case "$mode" in
    apply)
      "$@"
      ;;
    dry-run)
      rendered="$(hc_render_command "$@")"
      hc_log DRY-RUN "$rendered"
      ;;
    *)
      hc_die "Invalid HC_EXEC_MODE: $mode"
      return 1
      ;;
  esac
}

hc_atomic_write() {
  local requested_target="${1:-}"
  local mode="${2:-}"
  local target
  local target_directory
  local target_name
  local temporary

  if [[ -z "$requested_target" ]]; then
    hc_die "Atomic write target is required."
    return 1
  fi

  if [[ ! "$mode" =~ ^0?[0-7]{3}$ ]]; then
    hc_die "Atomic write mode must be an octal file mode."
    return 1
  fi

  target="$(hc_path "$requested_target")" || return 1
  target_directory="$(dirname -- "$target")"
  target_name="$(basename -- "$target")"

  if [[ ! -d "$target_directory" ]]; then
    hc_die "Atomic write directory does not exist: $target_directory"
    return 1
  fi

  temporary="$(
    mktemp \
      "$target_directory/.${target_name}.tmp.XXXXXX"
  )"

  if ! chmod "$mode" "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi

  if ! cat > "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi

  if ! mv -f -- "$temporary" "$target"; then
    rm -f -- "$temporary"
    return 1
  fi
}
