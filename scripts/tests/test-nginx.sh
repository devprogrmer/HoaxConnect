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
HC_LIBRARY="$HC_ROOT/scripts/lib/nginx.sh"
HC_HTTP_TEMPLATE="$HC_ROOT/deploy/templates/nginx-control-plane-http.conf.template"
HC_HTTPS_TEMPLATE="$HC_ROOT/deploy/templates/nginx-control-plane-https.conf.template"

# shellcheck disable=SC1090,SC1091
source "$HC_TEST_DIR/assert.sh"

if [[ ! -f "$HC_LIBRARY" ]]; then
  printf 'EXPECTED RED: nginx library missing: %s\n' \
    "$HC_LIBRARY" >&2
  exit 1
fi

for template in "$HC_HTTP_TEMPLATE" "$HC_HTTPS_TEMPLATE"; do
  if [[ ! -f "$template" ]]; then
    printf 'EXPECTED RED: nginx template missing: %s\n' \
      "$template" >&2
    exit 1
  fi
done

# shellcheck disable=SC1090,SC1091
source "$HC_ROOT/scripts/lib/common.sh"

# shellcheck disable=SC1090,SC1091
source "$HC_ROOT/scripts/lib/config.sh"

# shellcheck disable=SC1090,SC1091
source "$HC_LIBRARY"

HC_CASE_ROOT=""
HC_FAKE_BIN=""

hc_nginx_setup() {
  HC_CASE_ROOT="$(mktemp -d)"
  HC_FAKE_BIN="$HC_CASE_ROOT/fake-bin"

  mkdir -p \
    "$HC_FAKE_BIN" \
    "$HC_CASE_ROOT/etc/nginx/sites-available" \
    "$HC_CASE_ROOT/etc/nginx/sites-enabled" \
    "$HC_CASE_ROOT/etc/letsencrypt/live/api.example.com" \
    "$HC_CASE_ROOT/var/lib/hoaxconnect/acme" \
    "$HC_CASE_ROOT/var/lib/hoaxconnect/updates"

  export HC_TEST_MODE=1
  export HC_ROOT_PREFIX="$HC_CASE_ROOT"
  export HC_DOMAIN="api.example.com"
  export HC_ADMIN_ORIGIN="https://admin.example.com"
  export HC_RELEASE_ID="0123456789abcdef0123456789abcdef01234567"
  export HC_RELEASE_DIR="/opt/hoaxconnect/releases/$HC_RELEASE_ID"
  export HC_ENV_FILE="/etc/hoaxconnect/backend.env"
  export HC_TLS_MODE="required"
  export HC_NGINX_BIN="$HC_FAKE_BIN/nginx"
  export HC_SYSTEMCTL_BIN="$HC_FAKE_BIN/systemctl"
  export HC_CERTBOT_BIN="$HC_FAKE_BIN/certbot"
  export HC_FAKE_NGINX_RESULT=0
  export HC_FAKE_CERTBOT_RESULT=0
  export HC_SKIP_DNS_CHECK=1

  cat > "$HC_NGINX_BIN" <<'FAKE_NGINX'
#!/usr/bin/env bash
exit "${HC_FAKE_NGINX_RESULT:-0}"
FAKE_NGINX

  cat > "$HC_SYSTEMCTL_BIN" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${HC_FAKE_SYSTEMCTL_LOG:?}"
FAKE_SYSTEMCTL

  cat > "$HC_CERTBOT_BIN" <<'FAKE_CERTBOT'
#!/usr/bin/env bash
exit "${HC_FAKE_CERTBOT_RESULT:-0}"
FAKE_CERTBOT

  chmod 0700 \
    "$HC_NGINX_BIN" \
    "$HC_SYSTEMCTL_BIN" \
    "$HC_CERTBOT_BIN"

  export HC_FAKE_SYSTEMCTL_LOG="$HC_CASE_ROOT/systemctl.log"
  : > "$HC_FAKE_SYSTEMCTL_LOG"
}

hc_nginx_cleanup() {
  if [[ -n "${HC_CASE_ROOT:-}" &&
        "$HC_CASE_ROOT" == /tmp/* ]]; then
    rm -rf -- "$HC_CASE_ROOT"
  fi

  HC_CASE_ROOT=""
  HC_FAKE_BIN=""
}

hc_render_case() {
  local mode="$1"
  local output="$HC_CASE_ROOT/rendered-$mode.conf"

  hc_render_nginx "$mode" "$output"
  printf '%s\n' "$output"
}

test_acme_routing() {
  hc_nginx_setup
  local rendered
  rendered="$(hc_render_case http)"

  grep -Fq \
    'location ^~ /.well-known/acme-challenge/' \
    "$rendered" || return 1

  grep -Fq \
    'root /var/lib/hoaxconnect/acme;' \
    "$rendered" || return 1

  hc_nginx_cleanup
}

test_http_redirect() {
  hc_nginx_setup
  local rendered
  rendered="$(hc_render_case https)"

  # Nginx variables must remain literal in the rendered file.
  # shellcheck disable=SC2016
  grep -Fq \
    'return 301 https://$host$request_uri;' \
    "$rendered" || return 1

  hc_nginx_cleanup
}

test_https_loopback_proxy() {
  hc_nginx_setup
  local rendered
  rendered="$(hc_render_case https)"

  grep -Fq \
    'listen 443 ssl http2;' \
    "$rendered" || return 1

  grep -Fq \
    'proxy_pass http://127.0.0.1:3100;' \
    "$rendered" || return 1

  grep -Fq \
    '/etc/letsencrypt/live/api.example.com/fullchain.pem' \
    "$rendered" || return 1

  hc_nginx_cleanup
}

test_directory_listing_disabled() {
  hc_nginx_setup
  local rendered
  rendered="$(hc_render_case https)"

  grep -Fq 'autoindex off;' "$rendered" || return 1
  grep -Fq \
    'root /var/lib/hoaxconnect/updates;' \
    "$rendered" || return 1
  # Nginx variables must remain literal in the rendered file.
  # shellcheck disable=SC2016
  grep -Fq 'try_files $uri =404;' "$rendered" || return 1

  hc_nginx_cleanup
}

test_http_auth_blocked() {
  hc_nginx_setup
  local rendered
  rendered="$(hc_render_case http)"

  grep -Fq 'location ^~ /api/v1/' "$rendered" || return 1
  grep -Fq 'return 426' "$rendered" || return 1
  grep -Fq 'HTTPS_REQUIRED' "$rendered" || return 1

  hc_nginx_cleanup
}

test_unrelated_site_preserved() {
  hc_nginx_setup

  local unrelated="$HC_CASE_ROOT/etc/nginx/sites-available/unrelated.conf"
  local candidate="$HC_CASE_ROOT/candidate.conf"
  local before

  printf '%s\n' 'server { listen 8088; }' > "$unrelated"
  before="$(sha256sum "$unrelated" | awk '{print $1}')"

  hc_render_nginx http "$candidate"
  hc_activate_nginx "$candidate"

  hc_assert_equal \
    "$before" \
    "$(sha256sum "$unrelated" | awk '{print $1}')"

  hc_nginx_cleanup
}

test_invalid_nginx_rolls_back() {
  hc_nginx_setup

  local target="$HC_CASE_ROOT/etc/nginx/sites-available/hoaxconnect-control-plane.conf"
  local candidate="$HC_CASE_ROOT/candidate.conf"
  local before

  printf '%s\n' 'previous-valid-config' > "$target"
  before="$(sha256sum "$target" | awk '{print $1}')"

  hc_render_nginx http "$candidate"
  export HC_FAKE_NGINX_RESULT=1

  if hc_activate_nginx "$candidate"; then
    hc_test_fail "invalid Nginx candidate was activated"
    return 1
  fi

  hc_assert_equal \
    "$before" \
    "$(sha256sum "$target" | awk '{print $1}')"

  hc_nginx_cleanup
}

test_certbot_failure_preserves_active_config() {
  hc_nginx_setup

  local target="$HC_CASE_ROOT/etc/nginx/sites-available/hoaxconnect-control-plane.conf"
  local before

  printf '%s\n' 'existing-active-config' > "$target"
  before="$(sha256sum "$target" | awk '{print $1}')"

  export HC_FAKE_CERTBOT_RESULT=1

  if hc_obtain_certificate "admin@example.com"; then
    hc_test_fail "Certbot failure was reported as success"
    return 1
  fi

  hc_assert_equal \
    "$before" \
    "$(sha256sum "$target" | awk '{print $1}')"

  hc_nginx_cleanup
}

hc_run_nginx_test() {
  local test_name="$1"

  if "$test_name"; then
    printf 'PASS: %s\n' "$test_name"
    return 0
  fi

  printf 'FAIL: %s\n' "$test_name" >&2
  return 1
}

main() {
  local failures=0
  local test_name
  local tests=(
    test_acme_routing
    test_http_redirect
    test_https_loopback_proxy
    test_directory_listing_disabled
    test_http_auth_blocked
    test_unrelated_site_preserved
    test_invalid_nginx_rolls_back
    test_certbot_failure_preserves_active_config
  )

  for test_name in "${tests[@]}"; do
    if ! hc_run_nginx_test "$test_name"; then
      failures=$((failures + 1))
    fi
  done

  if [[ "$failures" -ne 0 ]]; then
    printf 'FAILED NGINX TESTS: %s\n' "$failures" >&2
    return 1
  fi

  printf 'ALL NGINX TESTS PASSED\n'
}

trap hc_nginx_cleanup EXIT
main "$@"
