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

HC_RESTORE_ARCHIVE=""
HC_RESTORE_CONFIRMED=0
HC_RESTORE_WORKSPACE=""

hc_restore_usage() {
  cat <<'USAGE'
Usage:
  scripts/restore.sh --backup ARCHIVE --confirm-restore

Options:
  --backup ARCHIVE   Restore from a verified HoaxConnect archive.
  --confirm-restore  Explicitly authorize the destructive restore.
  --help             Show this help.
USAGE
}

hc_restore_cleanup() {
  if [[ -n "${HC_RESTORE_WORKSPACE:-}" &&
        "$HC_RESTORE_WORKSPACE" == /tmp/* ]]; then
    rm -rf -- "$HC_RESTORE_WORKSPACE"
  fi

  HC_RESTORE_WORKSPACE=""
}

hc_restore_parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --backup)
        if [[ "$#" -lt 2 || -z "${2:-}" ]]; then
          hc_die "--backup requires an archive path."
          return 1
        fi

        HC_RESTORE_ARCHIVE="$2"
        shift 2
        ;;
      --confirm-restore)
        HC_RESTORE_CONFIRMED=1
        shift
        ;;
      --help|-h)
        hc_restore_usage
        return 2
        ;;
      *)
        hc_die "Unknown restore argument: $1"
        return 1
        ;;
    esac
  done
}

hc_restore_require_confirmation() {
  if [[ "$HC_RESTORE_CONFIRMED" -ne 1 ]]; then
    hc_die \
      "Restore requires explicit confirmation with --confirm-restore."
    return 1
  fi
}

hc_restore_validate_member_name() {
  local member="$1"

  if [[ -z "$member" ||
        "$member" == /* ||
        "$member" == ".." ||
        "$member" == ../* ||
        "$member" == */../* ||
        "$member" == */.. ]]; then
    hc_die "Backup archive contains an unsafe path."
    return 1
  fi
}

hc_restore_validate_archive_paths() {
  local archive="$1"

  hc_require_command python3 || return 1

  if ! python3 - "$archive" <<'PY_VALIDATE_ARCHIVE'
from pathlib import PurePosixPath
import sys
import tarfile

archive = sys.argv[1]
seen: set[str] = set()

with tarfile.open(archive, mode="r:gz") as handle:
    for member in handle.getmembers():
        name = member.name
        path = PurePosixPath(name)

        if (
            not name
            or path.is_absolute()
            or ".." in path.parts
        ):
            raise SystemExit(
                f"unsafe archive path: {name}"
            )

        if name in seen:
            raise SystemExit(
                f"duplicate archive path: {name}"
            )

        seen.add(name)

        if (
            member.issym()
            or member.islnk()
            or member.ischr()
            or member.isblk()
            or member.isfifo()
        ):
            raise SystemExit(
                f"unsafe archive link or special entry: {name}"
            )
PY_VALIDATE_ARCHIVE
  then
    hc_die \
      "Backup archive contains an unsafe link, path, or special entry."
    return 1
  fi
}

hc_restore_require_members() {
  local workspace="$1"
  local required

  for required in \
    database.dump \
    manifest.env \
    SHA256SUMS
  do
    if [[ ! -f "$workspace/$required" ]]; then
      hc_die "Backup archive is missing: $required"
      return 1
    fi
  done

  for required in config nginx; do
    if [[ ! -d "$workspace/$required" ]]; then
      hc_die "Backup archive is missing: $required/"
      return 1
    fi
  done
}

hc_restore_validate_checksum_paths() {
  local workspace="$1"
  local checksum_file="$workspace/SHA256SUMS"
  local checksum_path

  while IFS= read -r checksum_path; do
    checksum_path="${checksum_path#\*}"

    hc_restore_validate_member_name "$checksum_path" ||
      return 1

    case "$checksum_path" in
      database.dump|manifest.env|config/*|nginx/*)
        ;;
      *)
        hc_die \
          "Checksum manifest references an unexpected path."
        return 1
        ;;
    esac
  done < <(
    awk '{print $2}' "$checksum_file"
  )
}

hc_restore_verify_archive() {
  local archive="$1"

  hc_require_command tar || return 1
  hc_require_command sha256sum || return 1
  hc_require_command awk || return 1

  if [[ ! -f "$archive" ]]; then
    hc_die "Backup archive is unavailable."
    return 1
  fi

  if ! tar -tzf "$archive" >/dev/null 2>&1; then
    hc_die "Backup archive is invalid."
    return 1
  fi

  hc_restore_validate_archive_paths "$archive" ||
    return 1

  HC_RESTORE_WORKSPACE="$(mktemp -d)"

  if ! tar -xzf \
      "$archive" \
      -C "$HC_RESTORE_WORKSPACE"
  then
    hc_die "Backup archive extraction failed."
    return 1
  fi

  hc_restore_require_members "$HC_RESTORE_WORKSPACE" ||
    return 1

  hc_restore_validate_checksum_paths \
    "$HC_RESTORE_WORKSPACE" ||
    return 1

  if ! (
    cd "$HC_RESTORE_WORKSPACE" || exit 1
    sha256sum -c SHA256SUMS >/dev/null
  ); then
    hc_die "Backup checksum verification failed."
    return 1
  fi

  hc_log INFO "Backup archive checksum verified."
}

hc_restore_pre_backup_directory() {
  local requested="${HC_RESTORE_PRE_BACKUP_DIR:-}"

  if [[ -n "$requested" ]]; then
    if [[ "${HC_TEST_MODE:-0}" != "1" ]]; then
      hc_die \
        "HC_RESTORE_PRE_BACKUP_DIR is permitted only in test mode."
      return 1
    fi

    if [[ "$requested" != /* ]]; then
      hc_die \
        "HC_RESTORE_PRE_BACKUP_DIR must be absolute."
      return 1
    fi

    printf '%s\n' "$requested"
    return 0
  fi

  printf '%s\n' "/var/backups/hoaxconnect/pre-restore"
}

hc_restore_create_pre_backup() {
  local output_directory
  local output
  local archive

  output_directory="$(hc_restore_pre_backup_directory)" ||
    return 1

  output="$(
    hc_backup_create "$output_directory"
  )" || {
    hc_die "Pre-restore backup failed."
    return 1
  }

  archive="$(
    sed -n 's/^BACKUP_ARCHIVE=//p' <<<"$output" |
      tail -n 1
  )"

  if [[ -z "$archive" || ! -f "$archive" ]]; then
    hc_die "Pre-restore backup archive is unavailable."
    return 1
  fi

  printf '%s\n' "$archive"
}

hc_restore_apply_dump() {
  local dump="$1"
  local backend_env="$2"
  local database="$3"
  local user="$4"

  hc_backup_compose \
    "$backend_env" \
    exec -T postgres \
    pg_restore \
      --clean \
      --if-exists \
      --exit-on-error \
      --single-transaction \
      --no-owner \
      --no-acl \
      -U "$user" \
      -d "$database" \
      <"$dump"
}

hc_restore_wait_readiness() {
  local attempt
  local attempts="${HC_RESTORE_READY_ATTEMPTS:-30}"

  if [[ ! "$attempts" =~ ^[0-9]+$ ||
        "$attempts" -lt 1 ]]; then
    hc_die "Restore readiness attempt count is invalid."
    return 1
  fi

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl \
      --fail \
      --silent \
      --show-error \
      http://127.0.0.1:3100/api/v1/health/ready \
      >/dev/null
    then
      return 0
    fi

    sleep 2
  done

  hc_die "API readiness failed after restore."
  return 1
}

hc_restore_restart_api() {
  local backend_env="$1"

  hc_backup_compose \
    "$backend_env" \
    up -d api ||
    return 1

  hc_restore_wait_readiness
}

hc_restore_extract_recovery_dump() {
  local archive="$1"
  local destination="$2"

  mkdir -p -- "$destination"

  if ! tar -xzf \
      "$archive" \
      -C "$destination"
  then
    hc_die "Pre-restore recovery archive extraction failed."
    return 1
  fi

  if ! (
    cd "$destination" || exit 1
    sha256sum -c SHA256SUMS >/dev/null
  ); then
    hc_die "Pre-restore recovery checksum failed."
    return 1
  fi

  printf '%s\n' "$destination/database.dump"
}

hc_restore_recover_previous_database() {
  local pre_restore_archive="$1"
  local backend_env="$2"
  local database="$3"
  local user="$4"
  local recovery_workspace
  local recovery_dump

  recovery_workspace="$(mktemp -d)"

  recovery_dump="$(
    hc_restore_extract_recovery_dump \
      "$pre_restore_archive" \
      "$recovery_workspace"
  )" || {
    rm -rf -- "$recovery_workspace"
    return 1
  }

  if ! hc_backup_compose \
      "$backend_env" \
      stop api
  then
    rm -rf -- "$recovery_workspace"
    hc_die "API could not be stopped for database recovery."
    return 1
  fi

  if ! hc_restore_apply_dump \
      "$recovery_dump" \
      "$backend_env" \
      "$database" \
      "$user"
  then
    rm -rf -- "$recovery_workspace"
    hc_die "Previous database recovery failed."
    return 1
  fi

  rm -rf -- "$recovery_workspace"

  if ! hc_restore_restart_api "$backend_env"; then
    hc_die "API failed after database recovery."
    return 1
  fi

  hc_log ERROR \
    "Previous database recovered after restore failure."
}

hc_restore_transaction() {
  local actual_backend_env
  local actual_install_env
  local database
  local user
  local pre_restore_archive
  local restore_result=0

  hc_restore_require_confirmation ||
    return 1

  hc_restore_verify_archive "$HC_RESTORE_ARCHIVE" ||
    return 1

  hc_require_command docker || return 1
  hc_require_command curl || return 1

  actual_backend_env="$(
    hc_path "$HC_BACKUP_BACKEND_ENV"
  )" || return 1

  hc_backup_require_file \
    "$actual_backend_env" \
    "Backend environment" ||
    return 1

  actual_install_env="$(
    hc_path "$HC_BACKUP_INSTALL_ENV"
  )" || return 1

  hc_backup_require_file \
    "$actual_install_env" \
    "Installation metadata" ||
    return 1

  HC_RELEASE_ID="$(
    hc_backup_read_env "$actual_install_env" RELEASE_ID
  )"
  HC_RELEASE_DIR="$(
    hc_backup_read_env "$actual_install_env" RELEASE_DIR
  )"

  if [[ ! "$HC_RELEASE_ID" =~ ^[0-9a-f]{40}$ ||
        "$HC_RELEASE_DIR" != "/opt/hoaxconnect/releases/$HC_RELEASE_ID" ]]; then
    hc_die "Restore release metadata is invalid."
    return 1
  fi

  export HC_RELEASE_ID HC_RELEASE_DIR

  database="$(
    hc_backup_read_env \
      "$actual_backend_env" \
      POSTGRES_DB
  )"

  user="$(
    hc_backup_read_env \
      "$actual_backend_env" \
      POSTGRES_USER
  )"

  if [[ -z "$database" || -z "$user" ]]; then
    hc_die "Restore database metadata is invalid."
    return 1
  fi

  pre_restore_archive="$(
    hc_restore_create_pre_backup
  )" || return 1

  hc_log INFO "Stopping API traffic for restore."

  hc_backup_compose \
    "$actual_backend_env" \
    stop api ||
    return 1

  hc_restore_apply_dump \
    "$HC_RESTORE_WORKSPACE/database.dump" \
    "$actual_backend_env" \
    "$database" \
    "$user" ||
    restore_result=$?

  if [[ "$restore_result" -ne 0 ]]; then
    hc_log ERROR \
      "Database restore failed; starting automatic recovery."

    if ! hc_restore_recover_previous_database \
        "$pre_restore_archive" \
        "$actual_backend_env" \
        "$database" \
        "$user"
    then
      hc_die \
        "Restore and automatic database recovery both failed."
      return 1
    fi

    return "$restore_result"
  fi

  if ! hc_restore_restart_api "$actual_backend_env"; then
    hc_log ERROR \
      "API readiness failed; recovering previous database."

    if ! hc_restore_recover_previous_database \
        "$pre_restore_archive" \
        "$actual_backend_env" \
        "$database" \
        "$user"
    then
      hc_die \
        "API readiness and automatic recovery both failed."
      return 1
    fi

    return 1
  fi

  hc_log INFO "Database restore completed and API is ready."
  printf 'PRE_RESTORE_BACKUP=%s\n' "$pre_restore_archive"
}

main() {
  local parse_result=0

  hc_restore_parse_args "$@" ||
    parse_result=$?

  if [[ "$parse_result" -eq 2 ]]; then
    return 0
  fi

  if [[ "$parse_result" -ne 0 ]]; then
    return "$parse_result"
  fi

  if [[ -z "$HC_RESTORE_ARCHIVE" ]]; then
    hc_die "--backup is required."
    return 1
  fi

  hc_require_root || return 1
  hc_acquire_lock || return 1
  hc_restore_transaction
}

trap hc_restore_cleanup EXIT
main "$@"
