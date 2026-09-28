#!/usr/bin/env bash
set -Eeuo pipefail

HC_SCRIPT_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
    pwd -P
)"

# Paths are resolved dynamically from the installed release.
# shellcheck disable=SC1090,SC1091
source "$HC_SCRIPT_DIR/lib/common.sh"
# shellcheck disable=SC1090,SC1091
source "$HC_SCRIPT_DIR/lib/backup.sh"

HC_BACKUP_OUTPUT=""

hc_backup_usage() {
  cat <<'USAGE'
Usage:
  scripts/backup.sh [--output DIR]

Options:
  --output DIR  Store the verified archive in DIR.
  --help        Show this help.
USAGE
}

hc_backup_parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --output)
        if [[ "$#" -lt 2 || -z "${2:-}" ]]; then
          hc_die "--output requires a directory."
          return 1
        fi

        HC_BACKUP_OUTPUT="$2"
        shift 2
        ;;
      --help|-h)
        hc_backup_usage
        return 2
        ;;
      *)
        hc_die "Unknown backup argument: $1"
        return 1
        ;;
    esac
  done
}

main() {
  local parse_result=0

  hc_backup_parse_args "$@" ||
    parse_result=$?

  if [[ "$parse_result" -eq 2 ]]; then
    return 0
  fi

  if [[ "$parse_result" -ne 0 ]]; then
    return "$parse_result"
  fi

  hc_require_root || return 1
  hc_acquire_lock || return 1

  if [[ -n "$HC_BACKUP_OUTPUT" ]]; then
    hc_backup_create "$HC_BACKUP_OUTPUT"
  else
    hc_backup_create
  fi
}

main "$@"
