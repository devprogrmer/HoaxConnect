#!/usr/bin/env bash
set -Eeuo pipefail

HC_SCRIPT_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
  pwd -P
)"
HC_SOURCE_ROOT="$(
  cd -- "$HC_SCRIPT_DIR/.." &&
  pwd -P
)"

# Paths are resolved through hc_path before writes.
HC_INSTALL_ROOT="/opt/hoaxconnect"
HC_RELEASES_ROOT="/opt/hoaxconnect/releases"
HC_CURRENT_LINK="/opt/hoaxconnect/current"
HC_INSTALL_ENV="/etc/hoaxconnect/install.env"
HC_BACKEND_ENV="/etc/hoaxconnect/backend.env"
HC_MAINTENANCE_LOG_ROOT="/var/log/hoaxconnect"

HC_DOMAIN=""
HC_EMAIL=""
HC_PUBLIC_IP=""
HC_SOURCE_REF=""
HC_ADMIN_ORIGIN=""
HC_TLS_MODE="required"
HC_EXEC_MODE="apply"
HC_RELEASE_ID=""
HC_RELEASE_DIR=""

# The source paths are resolved relative to this script.
# shellcheck disable=SC1090,SC1091
source "$HC_SCRIPT_DIR/lib/common.sh"
# shellcheck disable=SC1090,SC1091
source "$HC_SCRIPT_DIR/lib/config.sh"
# shellcheck disable=SC1090,SC1091
source "$HC_SCRIPT_DIR/lib/compose.sh"
# shellcheck disable=SC1090,SC1091
source "$HC_SCRIPT_DIR/lib/nginx.sh"

hc_install_usage() {
  cat <<'USAGE'
Usage:
  scripts/install.sh \
    --domain DOMAIN \
    --email EMAIL \
    --source-ref REF \
    [--public-ip IPV4] \
    [--admin-origin HTTPS_ORIGIN] \
    [--staging-http] \
    [--dry-run]

Options:
  --domain          Public API and update hostname.
  --email           ACME account email address.
  --source-ref      Git commit, tag, or branch to export.
  --public-ip       Public IPv4 for hosts behind outbound NAT.
  --admin-origin    One HTTPS Admin Panel origin.
  --staging-http    Use the staging TLS workflow.
  --dry-run         Validate and print the deployment plan only.
  --help            Show this help.
USAGE
}

hc_install_parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --domain)
        [[ "$#" -ge 2 ]] ||
          hc_die "--domain requires a value." ||
          return 1
        HC_DOMAIN="$2"
        shift 2
        ;;
      --email)
        [[ "$#" -ge 2 ]] ||
          hc_die "--email requires a value." ||
          return 1
        HC_EMAIL="$2"
        shift 2
        ;;
      --public-ip)
        [[ "$#" -ge 2 ]] ||
          hc_die "--public-ip requires a value." ||
          return 1
        HC_PUBLIC_IP="$2"
        shift 2
        ;;
      --source-ref)
        [[ "$#" -ge 2 ]] ||
          hc_die "--source-ref requires a value." ||
          return 1
        HC_SOURCE_REF="$2"
        shift 2
        ;;
      --admin-origin)
        [[ "$#" -ge 2 ]] ||
          hc_die "--admin-origin requires a value." ||
          return 1
        HC_ADMIN_ORIGIN="$2"
        shift 2
        ;;
      --staging-http)
        HC_TLS_MODE="staging"
        shift
        ;;
      --dry-run)
        HC_EXEC_MODE="dry-run"
        shift
        ;;
      --help|-h)
        hc_install_usage
        return 2
        ;;
      *)
        hc_die "Unknown installer option: $1"
        return 1
        ;;
    esac
  done

  if [[ -z "$HC_DOMAIN" ||
        -z "$HC_EMAIL" ||
        -z "$HC_SOURCE_REF" ]]; then
    hc_die \
      "Required options: --domain --email --source-ref"
    return 1
  fi

  if [[ -n "$HC_PUBLIC_IP" ]]; then
    if [[ ! "$HC_PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      hc_die "--public-ip must be a valid IPv4 address."
      return 1
    fi

    local octet
    local -a octets=()

    IFS=. read -r -a octets <<<"$HC_PUBLIC_IP"

    for octet in "${octets[@]}"; do
      if ((10#$octet > 255)); then
        hc_die "--public-ip must be a valid IPv4 address."
        return 1
      fi
    done
  fi

  if [[ -z "$HC_ADMIN_ORIGIN" ]]; then
    HC_ADMIN_ORIGIN="https://$HC_DOMAIN"
  fi

  export \
    HC_DOMAIN \
    HC_EMAIL \
    HC_PUBLIC_IP \
    HC_SOURCE_REF \
    HC_ADMIN_ORIGIN \
    HC_TLS_MODE \
    HC_EXEC_MODE
}

hc_install_validate_test_overrides() {
  local override_used=0

  [[ -n "${HC_ROOT_PREFIX:-}" ]] &&
    override_used=1
  [[ -n "${HC_INSTALL_EUID_OVERRIDE:-}" ]] &&
    override_used=1
  [[ -n "${HC_INSTALL_OS_RELEASE:-}" ]] &&
    override_used=1
  [[ "${HC_SKIP_PORT_CHECK:-0}" == "1" ]] &&
    override_used=1
  [[ "${HC_SKIP_RESOURCE_CHECKS:-0}" == "1" ]] &&
    override_used=1

  if [[ "$override_used" -eq 1 &&
        "${HC_TEST_MODE:-0}" != "1" ]]; then
    hc_die "Installer overrides require test mode."
    return 1
  fi
}

hc_install_require_root() {
  local effective_euid="${EUID:-$(id -u)}"

  if [[ "${HC_TEST_MODE:-0}" == "1" &&
        -n "${HC_INSTALL_EUID_OVERRIDE:-}" ]]; then
    effective_euid="$HC_INSTALL_EUID_OVERRIDE"
  fi

  if [[ ! "$effective_euid" =~ ^[0-9]+$ ||
        "$effective_euid" -ne 0 ]]; then
    hc_die "This command must be run as root."
    return 1
  fi
}

hc_install_validate_os() {
  local release_path="/etc/os-release"
  local actual_release
  local os_id=""
  local version_id=""

  if [[ "${HC_TEST_MODE:-0}" == "1" &&
        -n "${HC_INSTALL_OS_RELEASE:-}" ]]; then
    release_path="$HC_INSTALL_OS_RELEASE"
  fi

  actual_release="$(hc_path "$release_path")" ||
    return 1

  if [[ ! -f "$actual_release" ]]; then
    hc_die "Unsupported operating system: os-release is missing."
    return 1
  fi

  os_id="$(
    (
      # os-release is system data, not executable project code.
      # shellcheck disable=SC1090
      source "$actual_release"
      printf '%s' "${ID:-}"
    )
  )"

  version_id="$(
    (
      # shellcheck disable=SC1090
      source "$actual_release"
      printf '%s' "${VERSION_ID:-}"
    )
  )"

  case "$os_id:$version_id" in
    ubuntu:22.04|ubuntu:24.04|debian:12)
      ;;
    *)
      hc_die \
        "Unsupported operating system: $os_id $version_id"
      return 1
      ;;
  esac
}

hc_install_validate_architecture() {
  local architecture

  architecture="$(uname -m)"

  if [[ "$architecture" != "x86_64" &&
        "$architecture" != "amd64" ]]; then
    hc_die "Unsupported architecture: $architecture"
    return 1
  fi
}

hc_install_validate_resources() {
  if [[ "${HC_TEST_MODE:-0}" == "1" &&
        "${HC_SKIP_RESOURCE_CHECKS:-0}" == "1" ]]; then
    return 0
  fi

  local memory_kb
  local swap_kb
  local available_kb
  local install_parent

  memory_kb="$(
    awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo
  )"
  swap_kb="$(
    awk '/^SwapTotal:/ { print $2; exit }' /proc/meminfo
  )"

  install_parent="$(dirname -- "$HC_INSTALL_ROOT")"
  available_kb="$(
    df -Pk "$install_parent" |
      awk 'NR == 2 { print $4 }'
  )"

  if [[ -z "$available_kb" ||
        "$available_kb" -lt 4194304 ]]; then
    hc_die "At least 4GB of free disk space is required."
    return 1
  fi

  if [[ -n "$memory_kb" &&
        "$memory_kb" -le 2097152 &&
        "${swap_kb:-0}" -eq 0 ]]; then
    hc_log WARN \
      "Host has at most 2GB RAM and no swap. Swap was not created."
  fi
}

hc_install_validate_tools() {
  local command_name
  local required=(
    git
    tar
    docker
    nginx
    curl
    openssl
    flock
    python3
    sha256sum
  )

  if [[ "${HC_TEST_MODE:-0}" == "1" ]]; then
    return 0
  fi

  for command_name in "${required[@]}"; do
    hc_require_command "$command_name" ||
      return 1
  done

  if ! docker compose version >/dev/null 2>&1; then
    hc_die "Docker Compose v2 is required."
    return 1
  fi

  if [[ "$HC_TLS_MODE" == "required" ]] &&
     ! command -v certbot >/dev/null 2>&1; then
    hc_die "Certbot is required for production TLS."
    return 1
  fi
}

hc_install_validate_ports() {
  if [[ "${HC_TEST_MODE:-0}" == "1" &&
        "${HC_SKIP_PORT_CHECK:-0}" == "1" ]]; then
    return 0
  fi

  hc_require_command ss || return 1

  if ss -H -ltn '( sport = :3100 )' |
     grep -q .; then
    hc_log WARN \
      "Port 3100 is already active; reinstall checks will apply."
  fi
}

hc_install_resolve_release() {
  hc_require_command git || return 1

  if [[ ! "$HC_SOURCE_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ||
        "$HC_SOURCE_REF" == *".."* ||
        "$HC_SOURCE_REF" == *"//"* ||
        "$HC_SOURCE_REF" == *"@{"* ||
        "$HC_SOURCE_REF" == */ ]]; then
    hc_die "Source ref contains unsupported characters."
    return 1
  fi

  if ! git -C "$HC_SOURCE_ROOT" \
      rev-parse --verify --end-of-options \
      "${HC_SOURCE_REF}^{commit}" \
      >/dev/null 2>&1; then
    hc_die "Source ref does not resolve to a Git commit."
    return 1
  fi

  HC_RELEASE_ID="$(
    git -C "$HC_SOURCE_ROOT" \
      rev-parse --verify --end-of-options \
      "${HC_SOURCE_REF}^{commit}"
  )"

  if [[ ! "$HC_RELEASE_ID" =~ ^[0-9a-f]{40}$ ]]; then
    hc_die "Resolved source ref is not a full Git SHA."
    return 1
  fi

  HC_RELEASE_DIR="/opt/hoaxconnect/releases/$HC_RELEASE_ID"
  HC_ENV_FILE="$HC_BACKEND_ENV"

  export \
    HC_RELEASE_ID \
    HC_RELEASE_DIR \
    HC_ENV_FILE
}

hc_install_validate_configuration() {
  hc_validate_domain "$HC_DOMAIN" ||
    return 1
  hc_validate_email "$HC_EMAIL" ||
    return 1
  hc_validate_admin_origin "$HC_ADMIN_ORIGIN" ||
    return 1
  hc_load_install_config ||
    return 1
}

hc_install_release_digest() {
  local directory="$1"

  (
    cd -- "$directory"

    find . \
      -type f \
      ! -name '.hoaxconnect-release' \
      -print0 |
      sort -z |
      xargs -0 -r sha256sum --
  ) |
    sha256sum |
    awk '{print $1}'
}

hc_install_verify_release_integrity() {
  local directory="$1"
  local marker="$directory/.hoaxconnect-release"
  local marker_release=""
  local marker_digest=""
  local actual_digest=""

  if [[ ! -f "$marker" ]]; then
    hc_die "Release integrity marker is unavailable."
    return 1
  fi

  marker_release="$(
    sed -n 's/^RELEASE_ID=//p' "$marker"
  )"
  marker_digest="$(
    sed -n 's/^CONTENT_SHA256=//p' "$marker"
  )"

  if [[ "$marker_release" != "$HC_RELEASE_ID" ||
        ! "$marker_digest" =~ ^[0-9a-f]{64}$ ]]; then
    hc_die "Release integrity marker is invalid."
    return 1
  fi

  actual_digest="$(
    hc_install_release_digest "$directory"
  )" || return 1

  if [[ "$actual_digest" != "$marker_digest" ]]; then
    hc_die "Release integrity verification failed."
    return 1
  fi
}

hc_install_stage_release() {
  local actual_releases
  local actual_release
  local temporary

  actual_releases="$(hc_path "$HC_RELEASES_ROOT")" ||
    return 1
  actual_release="$(hc_path "$HC_RELEASE_DIR")" ||
    return 1

  if [[ -d "$actual_release" ]]; then
    hc_install_verify_release_integrity "$actual_release" ||
      return 1

    hc_log INFO "Release already staged and verified: $HC_RELEASE_ID"
    return 0
  fi

  mkdir -p -- "$actual_releases"
  temporary="$(
    mktemp -d \
      "$actual_releases/.release-$HC_RELEASE_ID.XXXXXX"
  )"

  if ! (
    cd -- "$HC_SOURCE_ROOT"
    git archive "$HC_RELEASE_ID"
  ) | tar -x -C "$temporary"; then
    rm -rf -- "$temporary"
    return 1
  fi

  if find "$temporary" \
      \( \
        -name .git -o \
        -name node_modules -o \
        -name dist -o \
        -name release -o \
        -name '*.pem' -o \
        -name '*.key' -o \
        -name '*.pfx' -o \
        -name '*.p12' \
      \) -print -quit |
      grep -q .; then
    rm -rf -- "$temporary"
    hc_die "Exported release contains a forbidden path."
    return 1
  fi

  local content_digest

  content_digest="$(
    hc_install_release_digest "$temporary"
  )" || {
    rm -rf -- "$temporary"
    return 1
  }

  cat > "$temporary/.hoaxconnect-release" <<EOF
RELEASE_ID=$HC_RELEASE_ID
CONTENT_SHA256=$content_digest
EOF

  chmod 0444 "$temporary/.hoaxconnect-release"
  chmod -R go-w "$temporary"

  if ! mv -- "$temporary" "$actual_release"; then
    rm -rf -- "$temporary"
    return 1
  fi

  hc_install_verify_release_integrity "$actual_release"
}

hc_install_report_components() {
  local admin_status="unavailable"
  local website_status="unavailable"
  local desktop_status="unavailable"

  if [[ -d "$HC_SOURCE_ROOT/admin" ]]; then
    admin_status="available"
  fi

  if [[ -d "$HC_SOURCE_ROOT/website" ]]; then
    website_status="available"
  fi

  if git -C "$HC_SOURCE_ROOT" \
      ls-files |
      grep -Eq \
        '(^|/)(release|artifacts)/.*\.(exe|msi|msix)$'; then
    desktop_status="available"
  fi

  printf 'Admin panel: %s\n' "$admin_status"
  printf 'Website: %s\n' "$website_status"
  printf 'Desktop artifacts: %s\n' "$desktop_status"
}

hc_install_print_plan() {
  hc_log DRY-RUN "HoaxConnect source installation plan"
  hc_log DRY-RUN "Domain: $HC_DOMAIN"
  hc_log DRY-RUN "Admin origin: $HC_ADMIN_ORIGIN"
  hc_log DRY-RUN "TLS mode: $HC_TLS_MODE"
  hc_log DRY-RUN "Source ref: $HC_SOURCE_REF"
  hc_log DRY-RUN "Release ID: $HC_RELEASE_ID"
  hc_log DRY-RUN "Release path: $HC_RELEASE_DIR"
  hc_log DRY-RUN "Backend env: $HC_BACKEND_ENV"
  hc_log DRY-RUN "Install metadata: $HC_INSTALL_ENV"
  hc_log DRY-RUN "Current link: $HC_CURRENT_LINK"
  hc_log DRY-RUN "Maintenance logs: $HC_MAINTENANCE_LOG_ROOT"

  hc_install_report_components
}

HC_INSTALL_LOG=""
HC_INSTALL_NGINX_BACKUP=""
HC_INSTALL_NGINX_CANDIDATE=""

hc_install_log_stage() {
  local message="$*"

  hc_log INFO "$message"

  if [[ -n "${HC_INSTALL_LOG:-}" ]]; then
    printf '[%s] %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$message" >> "$HC_INSTALL_LOG"
  fi
}

hc_install_prepare_runtime_paths() {
  local actual_install_root
  local actual_log_root
  local actual_acme_root
  local actual_update_root

  actual_install_root="$(hc_path "$HC_INSTALL_ROOT")" ||
    return 1
  actual_log_root="$(hc_path "$HC_MAINTENANCE_LOG_ROOT")" ||
    return 1
  actual_acme_root="$(hc_path "$HC_ACME_ROOT")" ||
    return 1
  actual_update_root="$(hc_path "$HC_UPDATE_ROOT")" ||
    return 1

  mkdir -p \
    "$actual_install_root" \
    "$actual_log_root" \
    "$actual_acme_root" \
    "$actual_update_root"

  chmod 0700 \
    "$actual_install_root" \
    "$actual_log_root"

  chmod 0755 \
    "$actual_acme_root" \
    "$actual_update_root"

  HC_INSTALL_LOG="$actual_log_root/install-$HC_RELEASE_ID.log"
  : > "$HC_INSTALL_LOG"
  chmod 0600 "$HC_INSTALL_LOG"

  export HC_INSTALL_LOG
}

hc_install_use_staged_release_assets() {
  local actual_release

  actual_release="$(hc_path "$HC_RELEASE_DIR")" ||
    return 1

  HC_COMPOSE_FILE="$actual_release/deploy/compose/compose.source.yml"
  HC_NGINX_ROOT="$actual_release"

  if [[ ! -f "$HC_COMPOSE_FILE" ]]; then
    hc_die "Staged release Compose file is unavailable."
    return 1
  fi

  if [[ ! -f \
    "$HC_NGINX_ROOT/deploy/templates/nginx-control-plane-http.conf.template" ]]; then
    hc_die "Staged HTTP Nginx template is unavailable."
    return 1
  fi

  if [[ ! -f \
    "$HC_NGINX_ROOT/deploy/templates/nginx-control-plane-https.conf.template" ]]; then
    hc_die "Staged HTTPS Nginx template is unavailable."
    return 1
  fi

  export HC_COMPOSE_FILE HC_NGINX_ROOT
}

hc_install_backup_active_nginx() {
  local actual_available
  local actual_enabled

  actual_available="$(hc_path "$HC_NGINX_SITE_AVAILABLE")" ||
    return 1
  actual_enabled="$(hc_path "$HC_NGINX_SITE_ENABLED")" ||
    return 1

  HC_INSTALL_NGINX_BACKUP="$(mktemp -d)"

  if [[ -e "$actual_available" ||
        -L "$actual_available" ]]; then
    cp -a \
      -- "$actual_available" \
      "$HC_INSTALL_NGINX_BACKUP/available"
  fi

  if [[ -e "$actual_enabled" ||
        -L "$actual_enabled" ]]; then
    cp -a \
      -- "$actual_enabled" \
      "$HC_INSTALL_NGINX_BACKUP/enabled"
  fi

  export HC_INSTALL_NGINX_BACKUP
}

hc_install_restore_active_nginx() {
  local systemctl_bin

  if [[ -z "${HC_INSTALL_NGINX_BACKUP:-}" ||
        ! -d "$HC_INSTALL_NGINX_BACKUP" ]]; then
    return 0
  fi

  hc_restore_nginx "$HC_INSTALL_NGINX_BACKUP" ||
    return 1

  systemctl_bin="$(
    _hc_nginx_tool HC_SYSTEMCTL_BIN systemctl
  )" || return 1

  "$systemctl_bin" reload nginx >/dev/null 2>&1 ||
    true
}

hc_install_remove_nginx_backup() {
  if [[ -n "${HC_INSTALL_NGINX_BACKUP:-}" &&
        "$HC_INSTALL_NGINX_BACKUP" == /tmp/* ]]; then
    rm -rf -- "$HC_INSTALL_NGINX_BACKUP"
  fi

  HC_INSTALL_NGINX_BACKUP=""
}

hc_install_verify_local_health() {
  if ! curl \
      --fail \
      --silent \
      --show-error \
      http://127.0.0.1:3100/api/v1/health/ready \
      >/dev/null; then
    hc_die "Local API readiness verification failed."
    return 1
  fi
}

hc_install_verify_public_http_health() {
  if ! curl \
      --fail \
      --silent \
      --show-error \
      "http://$HC_DOMAIN/api/v1/health/ready" \
      >/dev/null; then
    hc_die "Public HTTP staging readiness verification failed."
    return 1
  fi
}

hc_install_verify_public_health() {
  local -a arguments=(
    --fail
    --silent
    --show-error
  )

  arguments+=(
    "https://$HC_DOMAIN/api/v1/health/ready"
  )

  if ! curl "${arguments[@]}" >/dev/null; then
    hc_die "Public HTTPS readiness verification failed."
    return 1
  fi
}

hc_install_write_metadata() {
  hc_atomic_write "$HC_INSTALL_ENV" 0600 <<EOF
DOMAIN=$HC_DOMAIN
ADMIN_ORIGIN=$HC_ADMIN_ORIGIN
ACME_EMAIL=$HC_EMAIL
PUBLIC_IP=$HC_PUBLIC_IP
SOURCE_REF=$HC_SOURCE_REF
RELEASE_ID=$HC_RELEASE_ID
RELEASE_DIR=$HC_RELEASE_DIR
TLS_MODE=$HC_TLS_MODE
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

hc_install_activate_release() {
  local actual_current
  local current_directory
  local temporary
  local previous_target=""

  actual_current="$(hc_path "$HC_CURRENT_LINK")" ||
    return 1
  current_directory="$(dirname -- "$actual_current")"

  mkdir -p -- "$current_directory"

  if [[ -L "$actual_current" ]]; then
    previous_target="$(readlink -- "$actual_current")"
  elif [[ -e "$actual_current" ]]; then
    hc_die "Current release path exists and is not a symlink."
    return 1
  fi

  temporary="$current_directory/.current-$HC_RELEASE_ID"

  rm -f -- "$temporary"
  ln -s -- "$HC_RELEASE_DIR" "$temporary"

  if ! mv -Tf -- "$temporary" "$actual_current"; then
    rm -f -- "$temporary"
    return 1
  fi

  if ! hc_install_write_metadata; then
    if [[ -n "$previous_target" ]]; then
      ln -s -- "$previous_target" "$temporary"
      mv -Tf -- "$temporary" "$actual_current"
    else
      rm -f -- "$actual_current"
    fi

    return 1
  fi
}

hc_install_start_candidate() {
  hc_install_log_stage "Verifying Compose network boundaries."

  hc_verify_network_boundaries ||
    return 1

  hc_install_log_stage "Building API candidate."

  if ! hc_compose build api; then
    hc_die "API candidate build failed."
    return 1
  fi

  hc_install_log_stage "Starting PostgreSQL."

  if ! hc_compose up -d postgres; then
    hc_die "PostgreSQL start failed."
    return 1
  fi

  hc_wait_service postgres 120 ||
    return 1

  hc_install_log_stage "Starting API candidate."

  if ! hc_compose up -d api; then
    hc_die "API start failed."
    return 1
  fi

  hc_wait_service api 180 ||
    return 1

  hc_install_verify_local_health ||
    return 1
}

hc_install_configure_tls() {
  local actual_install_root

  actual_install_root="$(hc_path "$HC_INSTALL_ROOT")" ||
    return 1

  HC_INSTALL_NGINX_CANDIDATE="$actual_install_root/nginx-candidate.conf"

  hc_install_backup_active_nginx ||
    return 1

  hc_install_log_stage "Activating ACME HTTP configuration."

  hc_render_nginx http "$HC_INSTALL_NGINX_CANDIDATE" ||
    return 1

  hc_activate_nginx "$HC_INSTALL_NGINX_CANDIDATE" ||
    return 1

  if [[ "$HC_TLS_MODE" == "staging" ]]; then
    hc_install_log_stage "HTTP staging configuration is active."

    rm -f -- "$HC_INSTALL_NGINX_CANDIDATE"
    HC_INSTALL_NGINX_CANDIDATE=""

    hc_install_verify_public_http_health ||
      return 1

    return 0
  fi

  hc_install_log_stage "Requesting TLS certificate."

  hc_obtain_certificate "$HC_EMAIL" ||
    return 1

  hc_install_log_stage "Activating HTTPS configuration."

  hc_render_nginx https "$HC_INSTALL_NGINX_CANDIDATE" ||
    return 1

  hc_activate_nginx "$HC_INSTALL_NGINX_CANDIDATE" ||
    return 1

  rm -f -- "$HC_INSTALL_NGINX_CANDIDATE"
  HC_INSTALL_NGINX_CANDIDATE=""

  hc_install_verify_public_health ||
    return 1
}

hc_install_transaction() {
  hc_install_prepare_runtime_paths ||
    return 1

  hc_install_log_stage "Exporting immutable source release."

  hc_install_stage_release ||
    return 1

  hc_install_use_staged_release_assets ||
    return 1

  hc_install_log_stage "Writing preserved backend configuration."

  hc_write_backend_env ||
    return 1

  hc_install_start_candidate ||
    return 1

  hc_install_configure_tls ||
    return 1

  hc_install_log_stage "Activating release metadata."

  hc_install_activate_release ||
    return 1

  hc_install_log_stage "Installation completed."
}

hc_install_apply() {
  local result=0

  hc_install_transaction ||
    result=$?

  if [[ "$result" -ne 0 ]]; then
    hc_log ERROR "Installation transaction failed."

    hc_install_restore_active_nginx ||
      hc_log ERROR "Nginx rollback failed."

    if [[ -n "${HC_INSTALL_NGINX_CANDIDATE:-}" ]]; then
      rm -f -- "$HC_INSTALL_NGINX_CANDIDATE"
      HC_INSTALL_NGINX_CANDIDATE=""
    fi

    hc_install_remove_nginx_backup
    return "$result"
  fi

  hc_install_remove_nginx_backup
  hc_install_report_components
  return 0
}

main() {
  local parse_result=0

  hc_install_parse_args "$@" ||
    parse_result=$?

  if [[ "$parse_result" -eq 2 ]]; then
    return 0
  fi

  if [[ "$parse_result" -ne 0 ]]; then
    return "$parse_result"
  fi

  hc_install_validate_test_overrides ||
    return 1
  hc_install_require_root ||
    return 1
  hc_install_validate_os ||
    return 1
  hc_install_validate_architecture ||
    return 1
  hc_install_validate_resources ||
    return 1
  hc_install_validate_tools ||
    return 1
  hc_install_validate_ports ||
    return 1
  hc_install_resolve_release ||
    return 1
  hc_install_validate_configuration ||
    return 1

  if [[ "$HC_EXEC_MODE" == "dry-run" ]]; then
    hc_install_print_plan
    return 0
  fi

  hc_acquire_lock ||
    return 1
  hc_install_apply
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
