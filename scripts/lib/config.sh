#!/usr/bin/env bash

# HoaxConnect portable deployment configuration helpers.

umask 077

hc_validate_domain() {
  local value="${1:-}"
  local label
  local -a labels

  if [[ -z "$value" ||
        "${#value}" -gt 253 ||
        "$value" == *"*"* ||
        "$value" == *":"* ||
        "$value" != *"."* ||
        "$value" == .* ||
        "$value" == *. ||
        "$value" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    hc_die "A valid DNS hostname is required."
    return 1
  fi

  IFS='.' read -r -a labels <<<"$value"

  for label in "${labels[@]}"; do
    if [[ -z "$label" ||
          "${#label}" -gt 63 ||
          ! "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]]; then
      hc_die "Invalid DNS hostname label."
      return 1
    fi
  done
}

hc_validate_email() {
  local value="${1:-}"
  local local_part
  local domain
  local local_pattern='^[A-Za-z0-9._%+-]+$'

  if [[ "$value" != *@* ||
        "$value" == *[[:space:]]* ]]; then
    hc_die "A valid email address is required."
    return 1
  fi

  local_part="${value%@*}"
  domain="${value##*@}"

  if [[ -z "$local_part" ||
        "${#local_part}" -gt 64 ||
        ! "$local_part" =~ $local_pattern ]]; then
    hc_die "A valid email address is required."
    return 1
  fi

  hc_validate_domain "$domain"
}

hc_generate_secret() {
  local bytes="${1:-48}"
  local secret

  if [[ ! "$bytes" =~ ^[0-9]+$ ||
        "$bytes" -lt 48 ]]; then
    hc_die "Secret generation requires at least 48 bytes."
    return 1
  fi

  hc_require_command openssl || return 1

  secret="$(
    openssl rand -base64 "$bytes" |
      tr -d '\n' |
      tr '+/' '-_'
  )"

  if [[ "${#secret}" -lt 64 ]]; then
    hc_die "Generated secret did not meet minimum length."
    return 1
  fi

  printf '%s\n' "$secret"
}

hc_validate_admin_origin() {
  local value="${1:-}"
  local domain

  if [[ "$value" == "*" ||
        ! "$value" =~ ^https://[^/]+$ ]]; then
    hc_die "Admin origin must be one HTTPS origin."
    return 1
  fi

  domain="${value#https://}"
  hc_validate_domain "$domain"
}

hc_load_install_config() {
  : "${HC_DOMAIN:?HC_DOMAIN is required}"
  : "${HC_ADMIN_ORIGIN:?HC_ADMIN_ORIGIN is required}"
  : "${HC_RELEASE_ID:?HC_RELEASE_ID is required}"
  : "${HC_RELEASE_DIR:?HC_RELEASE_DIR is required}"
  : "${HC_ENV_FILE:=/etc/hoaxconnect/backend.env}"
  : "${HC_TLS_MODE:=required}"

  hc_validate_domain "$HC_DOMAIN" || return 1
  hc_validate_admin_origin "$HC_ADMIN_ORIGIN" || return 1

  if [[ ! "$HC_RELEASE_ID" =~ ^[0-9a-f]{40}$ ]]; then
    hc_die "HC_RELEASE_ID must be a full lowercase Git SHA."
    return 1
  fi

  if [[ "$HC_RELEASE_DIR" != \
        "/opt/hoaxconnect/releases/$HC_RELEASE_ID" ]]; then
    hc_die "HC_RELEASE_DIR does not match HC_RELEASE_ID."
    return 1
  fi

  if [[ "$HC_ENV_FILE" != \
        "/etc/hoaxconnect/backend.env" ]]; then
    hc_die "Backend environment path is fixed."
    return 1
  fi

  case "$HC_TLS_MODE" in
    required|staging)
      ;;
    *)
      hc_die "HC_TLS_MODE must be required or staging."
      return 1
      ;;
  esac

  export \
    HC_DOMAIN \
    HC_ADMIN_ORIGIN \
    HC_RELEASE_ID \
    HC_RELEASE_DIR \
    HC_ENV_FILE \
    HC_TLS_MODE
}

hc_read_env_value() {
  local file="$1"
  local key="$2"

  awk -v key="$key" '
    index($0, key "=") == 1 {
      sub("^[^=]*=", "")
      print
      exit
    }
  ' "$file"
}

hc_existing_or_new_secret() {
  local file="$1"
  local key="$2"
  local value=""

  if [[ -f "$file" ]]; then
    value="$(hc_read_env_value "$file" "$key")"
  fi

  if [[ "${#value}" -ge 64 ]]; then
    printf '%s\n' "$value"
    return 0
  fi

  hc_generate_secret 48
}

hc_write_backend_env() {
  hc_load_install_config || return 1

  local actual_file
  local actual_directory
  local postgres_password
  local jwt_secret
  local refresh_pepper

  actual_file="$(hc_path "$HC_ENV_FILE")" || return 1
  actual_directory="$(dirname -- "$actual_file")"

  mkdir -p -- "$actual_directory"
  chmod 0700 "$actual_directory"

  postgres_password="$(
    hc_existing_or_new_secret \
      "$actual_file" \
      POSTGRES_PASSWORD
  )"

  jwt_secret="$(
    hc_existing_or_new_secret \
      "$actual_file" \
      JWT_ACCESS_SECRET
  )"

  refresh_pepper="$(
    hc_existing_or_new_secret \
      "$actual_file" \
      REFRESH_TOKEN_PEPPER
  )"

  # The logging helper consumes this registered-secret array.
  # shellcheck disable=SC2034
  HC_SECRET_VALUES=(
    "$postgres_password"
    "$jwt_secret"
    "$refresh_pepper"
  )

  hc_atomic_write "$HC_ENV_FILE" 0600 <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=3100
LOG_LEVEL=info
POSTGRES_DB=hoaxconnect
POSTGRES_USER=hoaxconnect
POSTGRES_PASSWORD=$postgres_password
DATABASE_URL=postgresql://hoaxconnect:$postgres_password@postgres:5432/hoaxconnect
DATABASE_SSL=false
JWT_ACCESS_SECRET=$jwt_secret
REFRESH_TOKEN_PEPPER=$refresh_pepper
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
EMAIL_VERIFICATION_REQUIRED=false
EMAIL_PROVIDER=none
PAYMENT_PROVIDER=none
CORS_ALLOWED_ORIGINS=$HC_ADMIN_ORIGIN
EOF
}
