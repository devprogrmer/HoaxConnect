#!/usr/bin/env bash

# Transactional Nginx and TLS helpers for HoaxConnect.

HC_NGINX_ROOT="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." &&
  pwd -P
)"

HC_NGINX_SITE_AVAILABLE="/etc/nginx/sites-available/hoaxconnect-control-plane.conf"
HC_NGINX_SITE_ENABLED="/etc/nginx/sites-enabled/hoaxconnect-control-plane.conf"
HC_ACME_ROOT="/var/lib/hoaxconnect/acme"
HC_UPDATE_ROOT="/var/lib/hoaxconnect/updates"

_hc_nginx_tool() {
  local variable_name="$1"
  local default_value="$2"
  local selected="${!variable_name:-$default_value}"

  if [[ "$selected" != "$default_value" &&
        "${HC_TEST_MODE:-0}" != "1" ]]; then
    hc_die "$variable_name may be overridden only in test mode."
    return 1
  fi

  if [[ "$selected" == */* ]]; then
    if [[ ! -x "$selected" ]]; then
      hc_die "Required executable is unavailable: $selected"
      return 1
    fi
  else
    hc_require_command "$selected" || return 1
  fi

  printf '%s\n' "$selected"
}

_hc_nginx_atomic_install() {
  local source="$1"
  local target="$2"
  local directory
  local temporary

  directory="$(dirname -- "$target")"
  mkdir -p -- "$directory"

  temporary="$(
    mktemp "$directory/.hoaxconnect-nginx.XXXXXX"
  )"

  if ! install -m 0644 -- "$source" "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi

  if ! mv -f -- "$temporary" "$target"; then
    rm -f -- "$temporary"
    return 1
  fi
}

hc_render_nginx() {
  local mode="${1:-}"
  local output="${2:-}"
  local template
  local cert_root

  hc_load_install_config || return 1

  if [[ -z "$output" || "$output" != /* ]]; then
    hc_die "Nginx render output must be an absolute path."
    return 1
  fi

  case "$mode" in
    http)
      template="$HC_NGINX_ROOT/deploy/templates/nginx-control-plane-http.conf.template"
      ;;
    https)
      template="$HC_NGINX_ROOT/deploy/templates/nginx-control-plane-https.conf.template"
      ;;
    *)
      hc_die "Nginx render mode must be http or https."
      return 1
      ;;
  esac

  if [[ ! -f "$template" ]]; then
    hc_die "Nginx template is unavailable: $template"
    return 1
  fi

  cert_root="/etc/letsencrypt/live/$HC_DOMAIN"

  local temporary
  temporary="$(
    mktemp "$(dirname -- "$output")/.nginx-render.XXXXXX"
  )"

  if ! sed \
      -e "s|__HC_DOMAIN__|$HC_DOMAIN|g" \
      -e "s|__HC_ACME_ROOT__|$HC_ACME_ROOT|g" \
      -e "s|__HC_UPDATE_ROOT__|$HC_UPDATE_ROOT|g" \
      -e "s|__HC_CERT_ROOT__|$cert_root|g" \
      "$template" > "$temporary"
  then
    rm -f -- "$temporary"
    return 1
  fi

  if grep -Eq '__HC_[A-Z_]+__' "$temporary"; then
    rm -f -- "$temporary"
    hc_die "Nginx template contains unresolved placeholders."
    return 1
  fi

  chmod 0644 "$temporary"
  mv -f -- "$temporary" "$output"
}

hc_validate_dns() {
  local resolved
  local public_ip

  hc_load_install_config || return 1

  if [[ "${HC_TEST_MODE:-0}" == "1" &&
        "${HC_SKIP_DNS_CHECK:-0}" == "1" ]]; then
    return 0
  fi

  hc_require_command dig || return 1
  hc_require_command curl || return 1

  resolved="$(
    dig +short A "$HC_DOMAIN" |
      awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/'
  )"

  if [[ -n "${HC_PUBLIC_IP:-}" ]]; then
    public_ip="$HC_PUBLIC_IP"
  else
    public_ip="$(
      curl \
        --fail \
        --silent \
        --show-error \
        --max-time 10 \
        --ipv4 \
        https://api.ipify.org
    )" || {
      hc_die "Unable to determine the public IPv4 address."
      return 1
    }
  fi

  if [[ -z "$resolved" ]] ||
     ! grep -Fxq -- "$public_ip" <<<"$resolved"
  then
    hc_die "Domain DNS does not resolve to this server."
    return 1
  fi
}

hc_validate_nginx() {
  local candidate="${1:-}"
  local nginx_bin

  if [[ -z "$candidate" || ! -f "$candidate" ]]; then
    hc_die "Nginx candidate is unavailable."
    return 1
  fi

  nginx_bin="$(
    _hc_nginx_tool HC_NGINX_BIN nginx
  )" || return 1

  "$nginx_bin" -t
}

hc_restore_nginx() {
  local backup="${1:-}"
  local actual_available
  local actual_enabled

  if [[ -z "$backup" || ! -d "$backup" ]]; then
    hc_die "Nginx rollback backup is unavailable."
    return 1
  fi

  actual_available="$(
    hc_path "$HC_NGINX_SITE_AVAILABLE"
  )" || return 1

  actual_enabled="$(
    hc_path "$HC_NGINX_SITE_ENABLED"
  )" || return 1

  rm -f -- "$actual_available" "$actual_enabled"

  if [[ -e "$backup/available" ||
        -L "$backup/available" ]]; then
    cp -a -- "$backup/available" "$actual_available"
  fi

  if [[ -e "$backup/enabled" ||
        -L "$backup/enabled" ]]; then
    cp -a -- "$backup/enabled" "$actual_enabled"
  fi
}

hc_activate_nginx() {
  local candidate="${1:-}"
  local nginx_bin
  local systemctl_bin
  local actual_available
  local actual_enabled
  local backup
  local stable_link

  if [[ -z "$candidate" || ! -f "$candidate" ]]; then
    hc_die "Nginx candidate is unavailable."
    return 1
  fi

  nginx_bin="$(
    _hc_nginx_tool HC_NGINX_BIN nginx
  )" || return 1

  systemctl_bin="$(
    _hc_nginx_tool HC_SYSTEMCTL_BIN systemctl
  )" || return 1

  actual_available="$(
    hc_path "$HC_NGINX_SITE_AVAILABLE"
  )" || return 1

  actual_enabled="$(
    hc_path "$HC_NGINX_SITE_ENABLED"
  )" || return 1

  mkdir -p -- \
    "$(dirname -- "$actual_available")" \
    "$(dirname -- "$actual_enabled")"

  backup="$(mktemp -d)"

  if [[ -e "$actual_available" ||
        -L "$actual_available" ]]; then
    cp -a -- "$actual_available" "$backup/available"
  fi

  if [[ -e "$actual_enabled" ||
        -L "$actual_enabled" ]]; then
    cp -a -- "$actual_enabled" "$backup/enabled"
  fi

  if ! _hc_nginx_atomic_install \
      "$candidate" \
      "$actual_available"
  then
    rm -rf -- "$backup"
    return 1
  fi

  rm -f -- "$actual_enabled"
  stable_link="$HC_NGINX_SITE_AVAILABLE"
  ln -s -- "$stable_link" "$actual_enabled"

  if ! hc_validate_nginx "$candidate"; then
    hc_restore_nginx "$backup"
    "$nginx_bin" -t >/dev/null 2>&1 || true
    rm -rf -- "$backup"
    return 1
  fi

  if ! "$systemctl_bin" reload nginx; then
    hc_restore_nginx "$backup"
    "$nginx_bin" -t >/dev/null 2>&1 || true
    "$systemctl_bin" reload nginx >/dev/null 2>&1 || true
    rm -rf -- "$backup"
    return 1
  fi

  rm -rf -- "$backup"
}

hc_obtain_certificate() {
  local email="${1:-}"
  local certbot_bin
  local actual_acme
  local -a arguments

  hc_load_install_config || return 1
  hc_validate_email "$email" || return 1
  hc_validate_dns || return 1

  certbot_bin="$(
    _hc_nginx_tool HC_CERTBOT_BIN certbot
  )" || return 1

  actual_acme="$(hc_path "$HC_ACME_ROOT")" || return 1

  mkdir -p -- "$actual_acme"
  chmod 0711 "$(dirname -- "$actual_acme")"
  chmod 0755 "$actual_acme"

  arguments=(
    certonly
    --non-interactive
    --agree-tos
    --no-eff-email
    --email "$email"
    --webroot
    --webroot-path "$actual_acme"
    --domain "$HC_DOMAIN"
  )

  if [[ "$HC_TLS_MODE" == "staging" ]]; then
    arguments+=(--staging)
  fi

  "$certbot_bin" "${arguments[@]}"
}
