#!/usr/bin/env bash

# Verified HoaxConnect backup helpers.

HC_BACKUP_SOURCE_ROOT="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." &&
    pwd -P
)"

HC_BACKUP_INSTALL_ENV="/etc/hoaxconnect/install.env"
HC_BACKUP_BACKEND_ENV="/etc/hoaxconnect/backend.env"
HC_BACKUP_NGINX_AVAILABLE="/etc/nginx/sites-available"
HC_BACKUP_NGINX_ENABLED="/etc/nginx/sites-enabled"
HC_BACKUP_DEFAULT_OUTPUT="/var/backups/hoaxconnect"
HC_BACKUP_COMPOSE_FILE="$HC_BACKUP_SOURCE_ROOT/deploy/compose/compose.source.yml"
HC_BACKUP_PROJECT="hoaxconnect"

hc_backup_read_env() {
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

hc_backup_require_file() {
  local path="$1"
  local description="$2"

  if [[ ! -f "$path" ]]; then
    hc_die "$description is unavailable."
    return 1
  fi
}

hc_backup_compose() {
  local backend_env="$1"
  shift

  HC_ENV_FILE="$backend_env" \
    docker compose \
      --project-name "$HC_BACKUP_PROJECT" \
      --env-file "$backend_env" \
      --file "$HC_BACKUP_COMPOSE_FILE" \
      "$@"
}

hc_backup_schema_version() {
  local backend_env="$1"
  local database="$2"
  local user="$3"
  local result

  result="$(
    hc_backup_compose \
      "$backend_env" \
      exec -T postgres \
      psql \
        -At \
        -v ON_ERROR_STOP=1 \
        -U "$user" \
        -d "$database" \
        -c \
        'SELECT version, checksum
         FROM schema_migrations
         ORDER BY applied_at DESC, version DESC
         LIMIT 1;'
  )" || return 1

  result="${result%%$'\n'*}"
  result="${result%%|*}"

  if [[ -z "$result" ]]; then
    hc_die "Database schema version is unavailable."
    return 1
  fi

  printf '%s\n' "$result"
}

hc_backup_copy_tree_without_links() {
  local source="$1"
  local destination="$2"
  local entry
  local relative
  local target
  local link_target
  local resolved

  if [[ ! -d "$source" ]]; then
    return 0
  fi

  while IFS= read -r -d '' entry; do
    relative="${entry#"$source"/}"
    target="$destination/$relative"

    if [[ -d "$entry" && ! -L "$entry" ]]; then
      mkdir -p -- "$target"
      continue
    fi

    mkdir -p -- "$(dirname -- "$target")"

    if [[ -f "$entry" && ! -L "$entry" ]]; then
      cp --preserve=mode,timestamps \
        "$entry" \
        "$target"
      continue
    fi

    if [[ -L "$entry" ]]; then
      link_target="$(readlink -- "$entry")"

      if [[ "$link_target" == /* ]]; then
        resolved="$(hc_path "$link_target")" ||
          return 1
      else
        resolved="$(readlink -f -- "$entry")" ||
          return 1
      fi

      if [[ ! -f "$resolved" ]]; then
        hc_die \
          "Nginx link does not resolve to a regular file."
        return 1
      fi

      cp --preserve=mode,timestamps \
        "$resolved" \
        "$target"
      continue
    fi

    hc_die \
      "Backup source contains an unsupported filesystem entry."
    return 1
  done < <(
    find "$source" \
      -mindepth 1 \
      -print0
  )
}

hc_backup_copy_configuration() {
  local workspace="$1"
  local install_env="$2"
  local backend_env="$3"
  local nginx_available="$4"
  local nginx_enabled="$5"

  mkdir -p \
    "$workspace/config" \
    "$workspace/nginx/sites-available" \
    "$workspace/nginx/sites-enabled"

  cp --preserve=mode,timestamps \
    "$install_env" \
    "$workspace/config/install.env"

  cp --preserve=mode,timestamps \
    "$backend_env" \
    "$workspace/config/backend.env"

  hc_backup_copy_tree_without_links \
    "$nginx_available" \
    "$workspace/nginx/sites-available" ||
    return 1

  hc_backup_copy_tree_without_links \
    "$nginx_enabled" \
    "$workspace/nginx/sites-enabled" ||
    return 1
}

hc_backup_write_checksums() {
  local workspace="$1"

  (
    cd "$workspace" || exit 1

    find \
      database.dump \
      config \
      nginx \
      manifest.env \
      -type f \
      -print0 |
      sort -z |
      xargs -0 sha256sum \
      > SHA256SUMS
  )
}

hc_backup_create() {
  local requested_output="${1:-$HC_BACKUP_DEFAULT_OUTPUT}"
  local output_directory="$requested_output"
  local actual_install_env
  local actual_backend_env
  local actual_nginx_available
  local actual_nginx_enabled
  local database
  local user
  local release_id
  local schema_version
  local timestamp
  local workspace
  local temporary_archive
  local final_archive
  local result=0

  hc_require_command docker || return 1
  hc_require_command tar || return 1
  hc_require_command sha256sum || return 1
  hc_require_command awk || return 1
  hc_require_command find || return 1
  hc_require_command xargs || return 1

  if ! docker compose version >/dev/null 2>&1; then
    hc_die "Docker Compose v2 is required."
    return 1
  fi

  if [[ ! -f "$HC_BACKUP_COMPOSE_FILE" ]]; then
    hc_die "Backup Compose file is unavailable."
    return 1
  fi

  actual_install_env="$(hc_path "$HC_BACKUP_INSTALL_ENV")" ||
    return 1
  actual_backend_env="$(hc_path "$HC_BACKUP_BACKEND_ENV")" ||
    return 1
  actual_nginx_available="$(hc_path "$HC_BACKUP_NGINX_AVAILABLE")" ||
    return 1
  actual_nginx_enabled="$(hc_path "$HC_BACKUP_NGINX_ENABLED")" ||
    return 1

  hc_backup_require_file \
    "$actual_install_env" \
    "Install metadata" ||
    return 1

  hc_backup_require_file \
    "$actual_backend_env" \
    "Backend environment" ||
    return 1

  database="$(
    hc_backup_read_env "$actual_backend_env" POSTGRES_DB
  )"
  user="$(
    hc_backup_read_env "$actual_backend_env" POSTGRES_USER
  )"
  release_id="$(
    hc_backup_read_env "$actual_install_env" RELEASE_ID
  )"

  if [[ -z "$database" ||
        -z "$user" ||
        ! "$release_id" =~ ^[0-9a-f]{40}$ ]]; then
    hc_die "Backup metadata is invalid."
    return 1
  fi

  mkdir -p -- "$output_directory"
  chmod 0700 "$output_directory"

  workspace="$(mktemp -d)"
  temporary_archive="$output_directory/.hoaxconnect-backup.tmp.$$"

  cleanup_backup_workspace() {
    rm -rf -- "$workspace"
    rm -f -- "$temporary_archive"
  }

  trap cleanup_backup_workspace RETURN

  hc_backup_copy_configuration \
    "$workspace" \
    "$actual_install_env" \
    "$actual_backend_env" \
    "$actual_nginx_available" \
    "$actual_nginx_enabled" ||
    return 1

  if ! hc_backup_compose \
      "$actual_backend_env" \
      exec -T postgres \
      pg_dump \
        --format=custom \
        --no-owner \
        --no-acl \
        -U "$user" \
        -d "$database" \
      >"$workspace/database.dump"
  then
    hc_die "PostgreSQL backup failed."
    return 1
  fi

  chmod 0600 "$workspace/database.dump"

  schema_version="$(
    hc_backup_schema_version \
      "$actual_backend_env" \
      "$database" \
      "$user"
  )" || return 1

  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  cat >"$workspace/manifest.env" <<EOF
FORMAT_VERSION=1
CREATED_AT=$timestamp
RELEASE_ID=$release_id
SCHEMA_VERSION=$schema_version
DATABASE_NAME=$database
COMPOSE_PROJECT=$HC_BACKUP_PROJECT
DATABASE_VOLUME=hoaxconnect_pgdata
EOF

  chmod 0600 "$workspace/manifest.env"

  hc_backup_write_checksums "$workspace" ||
    return 1

  chmod 0600 "$workspace/SHA256SUMS"

  final_archive="$output_directory/hoaxconnect-backup-${timestamp//[:]/-}.tar.gz"

  if ! (
    cd "$workspace"

    tar -czf "$temporary_archive" \
      database.dump \
      config \
      nginx \
      manifest.env \
      SHA256SUMS
  ); then
    hc_die "Backup archive creation failed."
    return 1
  fi

  chmod 0600 "$temporary_archive"

  if ! mv -f -- "$temporary_archive" "$final_archive"; then
    hc_die "Backup archive activation failed."
    return 1
  fi

  trap - RETURN
  cleanup_backup_workspace

  hc_log INFO "Verified backup created."
  printf 'BACKUP_ARCHIVE=%s\n' "$final_archive"

  return "$result"
}
