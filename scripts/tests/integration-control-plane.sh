#!/usr/bin/env bash
set -Eeuo pipefail

HC_INTEGRATION_CONFIRM="${HC_INTEGRATION_CONFIRM:-}"
HC_INTEGRATION_HOST="${HC_INTEGRATION_HOST:-}"
HC_INTEGRATION_DOMAIN="${HC_INTEGRATION_DOMAIN:-}"
HC_INTEGRATION_EMAIL="${HC_INTEGRATION_EMAIL:-}"
HC_INTEGRATION_SSH_USER="${HC_INTEGRATION_SSH_USER:-root}"
HC_INTEGRATION_SSH_PORT="${HC_INTEGRATION_SSH_PORT:-22}"
HC_INTEGRATION_IDENTITY_FILE="${HC_INTEGRATION_IDENTITY_FILE:-}"
HC_INTEGRATION_BUILD_ADDRESS="${HC_INTEGRATION_BUILD_ADDRESS:-}"
HC_INTEGRATION_EXECUTE="${HC_INTEGRATION_EXECUTE:-0}"

HC_SSH=()
HC_TARGET_ADDRESS=""

hc_usage() {
  cat <<'EOF'
Usage:
  HC_INTEGRATION_CONFIRM=YES \
  HC_INTEGRATION_HOST=203.0.113.10 \
  HC_INTEGRATION_DOMAIN=api.example.com \
  HC_INTEGRATION_EMAIL=admin@example.com \
  scripts/tests/integration-control-plane.sh
EOF
}

hc_die() {
  printf '[ERROR] %s\n' "$*" >&2
  return 1
}

hc_require() {
  local name="$1"
  local value="$2"

  [[ -n "$value" ]] || hc_die "$name is required."
}

hc_resolve() {
  local host="$1"

  getent ahostsv4 "$host" 2>/dev/null |
    awk 'NR == 1 { print $1 }' ||
    true
}

hc_local_addresses() {
  if [[ -n "$HC_INTEGRATION_BUILD_ADDRESS" ]]; then
    printf '%s\n' "$HC_INTEGRATION_BUILD_ADDRESS"
  fi

  hostname -I 2>/dev/null |
    tr ' ' '\n' |
    sed '/^$/d'

  printf '%s\n' "127.0.0.1" "0.0.0.0" "::1"
}

hc_validate_target() {
  local address

  case "$HC_INTEGRATION_HOST" in
    localhost|localhost.localdomain|127.*|0.0.0.0|::1)
      hc_die \
        "Localhost cannot be used as the disposable integration host."
      return 1
      ;;
  esac

  HC_TARGET_ADDRESS="$(hc_resolve "$HC_INTEGRATION_HOST")"

  [[ -n "$HC_TARGET_ADDRESS" ]] ||
    hc_die "Integration host could not be resolved."

  while IFS= read -r address; do
    if [[ "$HC_INTEGRATION_HOST" == "$address" ||
          "$HC_TARGET_ADDRESS" == "$address" ]]; then
      hc_die \
        "The current build server cannot be used for disposable E2E."
      return 1
    fi
  done < <(hc_local_addresses)
}

hc_validate_domain() {
  local address

  case "$HC_INTEGRATION_DOMAIN" in
    ""|localhost|*.localhost)
      hc_die "A public integration domain is required."
      return 1
      ;;
  esac

  address="$(hc_resolve "$HC_INTEGRATION_DOMAIN")"

  [[ "$address" == "$HC_TARGET_ADDRESS" ]] ||
    hc_die \
      "Integration domain does not resolve to the disposable host."
}

hc_validate_email() {
  [[ "$HC_INTEGRATION_EMAIL" == *@*.* ]] ||
    hc_die "A valid integration email is required."
}

hc_require_tools() {
  local command

  for command in git ssh scp tar curl openssl sha256sum; do
    command -v "$command" >/dev/null 2>&1 ||
      hc_die "Required command is unavailable: $command"
  done
}

hc_build_ssh() {
  HC_SSH=(
    ssh
    -o BatchMode=yes
    -o ConnectTimeout=10
    -o StrictHostKeyChecking=accept-new
    -p "$HC_INTEGRATION_SSH_PORT"
  )

  if [[ -n "$HC_INTEGRATION_IDENTITY_FILE" ]]; then
    [[ -f "$HC_INTEGRATION_IDENTITY_FILE" ]] ||
      hc_die "SSH identity file does not exist."

    HC_SSH+=(
      -i "$HC_INTEGRATION_IDENTITY_FILE"
      -o IdentitiesOnly=yes
    )
  fi

  HC_SSH+=(
    "$HC_INTEGRATION_SSH_USER@$HC_INTEGRATION_HOST"
  )
}

hc_validate_inputs() {
  [[ "$HC_INTEGRATION_CONFIRM" == "YES" ]] ||
    hc_die \
      "Disposable-host integration requires HC_INTEGRATION_CONFIRM=YES."

  hc_require HC_INTEGRATION_HOST "$HC_INTEGRATION_HOST"
  hc_require HC_INTEGRATION_DOMAIN "$HC_INTEGRATION_DOMAIN"
  hc_require HC_INTEGRATION_EMAIL "$HC_INTEGRATION_EMAIL"

  hc_validate_target
  hc_validate_domain
  hc_validate_email
  hc_require_tools
  hc_build_ssh
}

hc_integration_preflight_remote() {
  # The quoted content intentionally runs on the disposable host.
  # shellcheck disable=SC2016
  "${HC_SSH[@]}" \
    'set -Eeuo pipefail
     test "$(id -u)" -eq 0
     test -r /etc/os-release
     . /etc/os-release
     test "$ID" = ubuntu
     test "${VERSION_ID%%.*}" -ge 22
     printf "REMOTE_PREFLIGHT_OK\n"'
}


hc_integration_create_workspace() {
  HC_INTEGRATION_WORKSPACE="$(
    mktemp -d /tmp/hoaxconnect-e2e.XXXXXX
  )"

  chmod 0700 "$HC_INTEGRATION_WORKSPACE"

  HC_INTEGRATION_REMOTE_WORKSPACE="$(
    printf '/tmp/hoaxconnect-e2e-%s\n' \
      "$(date -u +%Y%m%dT%H%M%SZ)-$$"
  )"

  export \
    HC_INTEGRATION_WORKSPACE \
    HC_INTEGRATION_REMOTE_WORKSPACE
}

hc_integration_cleanup_workspace() {
  if [[ -n "${HC_INTEGRATION_WORKSPACE:-}" &&
        "$HC_INTEGRATION_WORKSPACE" == /tmp/hoaxconnect-e2e.* ]]; then
    rm -rf -- "$HC_INTEGRATION_WORKSPACE"
  fi
}

hc_integration_verify_worktree_scope() {
  local allowed
  local actual

  allowed="$(
    printf '%s\n' \
      README.md \
      deploy/compose/compose.source.yml \
      scripts/install.sh \
      scripts/lib/nginx.sh \
      scripts/restore.sh \
      scripts/status.sh \
      scripts/tests/integration-control-plane.sh \
      scripts/tests/run.sh \
      scripts/tests/test-compose.sh \
      scripts/tests/test-status-uninstall.sh \
      scripts/uninstall.sh \
      scripts/update.sh |
      sort
  )"

  actual="$(
    {
      git diff HEAD --name-only
      git ls-files --others --exclude-standard
    } |
      sort -u
  )"

  [[ "$actual" == "$allowed" ]] ||
    hc_die \
      "Unexpected paths exist in the E2E source snapshot."
}

hc_integration_build_source_payload() {
  local untracked=()

  hc_integration_verify_worktree_scope

  git bundle create \
    "$HC_INTEGRATION_WORKSPACE/repository.bundle" \
    --all

  git diff --binary HEAD > \
    "$HC_INTEGRATION_WORKSPACE/worktree.patch"

  mapfile -t untracked < <(
    git ls-files --others --exclude-standard |
      sort
  )

  if [[ "${#untracked[@]}" -eq 0 ]]; then
    tar -czf \
      "$HC_INTEGRATION_WORKSPACE/untracked.tar.gz" \
      --files-from /dev/null
  else
    tar -czf \
      "$HC_INTEGRATION_WORKSPACE/untracked.tar.gz" \
      -- "${untracked[@]}"
  fi

  (
    cd "$HC_INTEGRATION_WORKSPACE" || exit 1

    sha256sum \
      repository.bundle \
      worktree.patch \
      untracked.tar.gz > SHA256SUMS
  )
}

hc_integration_write_remote_runner() {
  cat > "$HC_INTEGRATION_WORKSPACE/run-e2e.sh" <<'REMOTE_E2E'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${HC_E2E_DOMAIN:?}"
: "${HC_E2E_EMAIL:?}"
: "${HC_E2E_PUBLIC_IP:?}"
: "${HC_E2E_WORKSPACE:?}"
: "${HC_E2E_BASE_REF:?}"

HC_SOURCE="$HC_E2E_WORKSPACE/source"
HC_BACKUPS="$HC_E2E_WORKSPACE/backups"
HC_FAILED_UPDATE_LOG="$HC_E2E_WORKSPACE/failed-update.log"

cd "$HC_E2E_WORKSPACE"

sha256sum -c SHA256SUMS

for command in \
  git docker nginx systemctl certbot curl openssl node npm
do
  command -v "$command" >/dev/null 2>&1 || {
    printf '[ERROR] Missing remote dependency: %s\n' "$command" >&2
    exit 1
  }
done

docker compose version >/dev/null
nginx -t
systemctl is-active --quiet nginx

git clone repository.bundle "$HC_SOURCE"
cd "$HC_SOURCE"

git apply "$HC_E2E_WORKSPACE/worktree.patch"
tar -xzf "$HC_E2E_WORKSPACE/untracked.tar.gz"

git config user.name "HoaxConnect E2E"
git config user.email "e2e@hoaxconnect.invalid"

git add --all
git commit -m "test: disposable install snapshot"
HC_INSTALL_REF="$(git rev-parse HEAD)"

printf '\nE2E-CANDIDATE-UPDATE\n' >> README.md
git add README.md
git commit -m "test: disposable candidate snapshot"
HC_CANDIDATE_REF="$(git rev-parse HEAD)"

printf '\nTHIS-INSTRUCTION-MUST-FAIL\n' >> backend/Dockerfile
git add backend/Dockerfile
git commit -m "test: forced failed update"
HC_BROKEN_REF="$(git rev-parse HEAD)"

git checkout --detach "$HC_INSTALL_REF"

mkdir -p "$HC_BACKUPS"

printf '%s\n' "===== CLEAN INSTALL ====="

bash scripts/install.sh \
  --domain "$HC_E2E_DOMAIN" \
  --email "$HC_E2E_EMAIL" \
  --public-ip "$HC_E2E_PUBLIC_IP" \
  --source-ref "$HC_INSTALL_REF"

HC_VOLUME_BEFORE="$(
  docker volume inspect hoaxconnect_pgdata \
    --format '{{.Name}}|{{.Driver}}|{{.Mountpoint}}'
)"

test -n "$HC_VOLUME_BEFORE"

curl \
  --fail \
  --silent \
  --show-error \
  --resolve "$HC_E2E_DOMAIN:443:127.0.0.1" \
  "https://$HC_E2E_DOMAIN/api/v1/health/ready" |
  grep -Fq '"status":"ready"'

printf '%s\n' "===== REINSTALL ====="

bash scripts/install.sh \
  --domain "$HC_E2E_DOMAIN" \
  --email "$HC_E2E_EMAIL" \
  --public-ip "$HC_E2E_PUBLIC_IP" \
  --source-ref "$HC_INSTALL_REF"

HC_VOLUME_REINSTALL="$(
  docker volume inspect hoaxconnect_pgdata \
    --format '{{.Name}}|{{.Driver}}|{{.Mountpoint}}'
)"

test "$HC_VOLUME_REINSTALL" = "$HC_VOLUME_BEFORE"

printf '%s\n' "===== HTTP AUTH BOUNDARY ====="

HC_AUTH_STATUS="$(
  curl \
    --silent \
    --output "$HC_E2E_WORKSPACE/http-auth-body" \
    --write-out '%{http_code}' \
    --resolve "$HC_E2E_DOMAIN:80:127.0.0.1" \
    --request POST \
    --header 'Content-Type: application/json' \
    --data '{}' \
    "http://$HC_E2E_DOMAIN/api/v1/auth/login"
)"

case "$HC_AUTH_STATUS" in
  301|302|307|308|426) ;;
  *)
    printf '[ERROR] Unsafe HTTP auth status: %s\n' \
      "$HC_AUTH_STATUS" >&2
    exit 1
    ;;
esac

printf '%s\n' "===== FORCED FAILED UPDATE ====="

set +e
bash scripts/update.sh \
  --source-ref "$HC_BROKEN_REF" \
  >"$HC_FAILED_UPDATE_LOG" 2>&1
HC_FAILED_UPDATE_RESULT=$?
set -e

test "$HC_FAILED_UPDATE_RESULT" -ne 0

test "$(
  readlink /opt/hoaxconnect/current
)" = "/opt/hoaxconnect/releases/$HC_INSTALL_REF"

curl \
  --fail \
  --silent \
  --show-error \
  http://127.0.0.1:3100/api/v1/health/ready |
  grep -Fq '"status":"ready"'

printf '%s\n' "===== SUCCESSFUL UPDATE ====="

bash scripts/update.sh \
  --source-ref "$HC_CANDIDATE_REF"

test "$(
  readlink /opt/hoaxconnect/current
)" = "/opt/hoaxconnect/releases/$HC_CANDIDATE_REF"

HC_VOLUME_UPDATED="$(
  docker volume inspect hoaxconnect_pgdata \
    --format '{{.Name}}|{{.Driver}}|{{.Mountpoint}}'
)"

test "$HC_VOLUME_UPDATED" = "$HC_VOLUME_BEFORE"

bash scripts/status.sh --json |
  python3 -c '
import json
import sys

data = json.load(sys.stdin)
assert data["health"] == "ready", data
assert data["postgres_binding"] == "not-published", data
'

printf '%s\n' "===== BACKUP AND RESTORE ====="

HC_BACKUP_OUTPUT="$(
  bash scripts/backup.sh --output "$HC_BACKUPS"
)"

HC_BACKUP_ARCHIVE="$(
  sed -n 's/^BACKUP_ARCHIVE=//p' <<< "$HC_BACKUP_OUTPUT" |
    tail -n 1
)"

test -n "$HC_BACKUP_ARCHIVE"
test -f "$HC_BACKUP_ARCHIVE"
test "$(stat -c '%a' "$HC_BACKUP_ARCHIVE")" = "600"

bash scripts/restore.sh \
  --backup "$HC_BACKUP_ARCHIVE" \
  --confirm-restore

curl \
  --fail \
  --silent \
  --show-error \
  http://127.0.0.1:3100/api/v1/health/ready |
  grep -Fq '"status":"ready"'

printf '%s\n' "===== SAFE UNINSTALL ====="

bash scripts/uninstall.sh --yes

test -d /etc/hoaxconnect
test -d /var/lib/hoaxconnect
test -d /var/backups/hoaxconnect
test -d /opt/hoaxconnect

test ! -e \
  /etc/nginx/sites-available/hoaxconnect-control-plane.conf

test ! -e \
  /etc/nginx/sites-enabled/hoaxconnect-control-plane.conf

HC_VOLUME_AFTER="$(
  docker volume inspect hoaxconnect_pgdata \
    --format '{{.Name}}|{{.Driver}}|{{.Mountpoint}}'
)"

test "$HC_VOLUME_AFTER" = "$HC_VOLUME_BEFORE"

nginx -t
systemctl is-active --quiet nginx

printf '%s\n' \
  "STAGE2B_PORTABLE_DEPLOYMENT_E2E_OK" \
  "CLEAN_INSTALL_OK" \
  "REINSTALL_OK" \
  "HTTPS_HEALTH_OK" \
  "HTTP_AUTH_BOUNDARY_OK" \
  "FAILED_UPDATE_ROLLBACK_OK" \
  "SUCCESSFUL_UPDATE_OK" \
  "BACKUP_RESTORE_OK" \
  "SAFE_UNINSTALL_OK" \
  "DATABASE_VOLUME_IDENTITY_STABLE"
REMOTE_E2E

  chmod 0700 "$HC_INTEGRATION_WORKSPACE/run-e2e.sh"
}

hc_integration_transfer_payload() {
  local destination

  destination="$HC_INTEGRATION_SSH_USER@$HC_INTEGRATION_HOST:$HC_INTEGRATION_REMOTE_WORKSPACE/"

  "${HC_SSH[@]}" \
    "install -d -m 0700 '$HC_INTEGRATION_REMOTE_WORKSPACE'"

  scp_args=(
    scp
    -P "$HC_INTEGRATION_SSH_PORT"
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
  )

  if [[ -n "$HC_INTEGRATION_IDENTITY_FILE" ]]; then
    scp_args+=(
      -i "$HC_INTEGRATION_IDENTITY_FILE"
      -o IdentitiesOnly=yes
    )
  fi

  scp_args+=(
    "$HC_INTEGRATION_WORKSPACE/repository.bundle"
    "$HC_INTEGRATION_WORKSPACE/worktree.patch"
    "$HC_INTEGRATION_WORKSPACE/untracked.tar.gz"
    "$HC_INTEGRATION_WORKSPACE/SHA256SUMS"
    "$HC_INTEGRATION_WORKSPACE/run-e2e.sh"
    "$destination"
  )

  "${scp_args[@]}"
}

hc_integration_execute_remote() {
  local quoted_domain
  local quoted_email
  local quoted_public_ip
  local quoted_workspace
  local quoted_base

  printf -v quoted_domain '%q' "$HC_INTEGRATION_DOMAIN"
  printf -v quoted_email '%q' "$HC_INTEGRATION_EMAIL"
  printf -v quoted_public_ip '%q' "$HC_TARGET_ADDRESS"
  printf -v quoted_workspace '%q' "$HC_INTEGRATION_REMOTE_WORKSPACE"
  printf -v quoted_base '%q' "$(git rev-parse HEAD)"

  "${HC_SSH[@]}" \
    "HC_E2E_DOMAIN=$quoted_domain \
     HC_E2E_EMAIL=$quoted_email \
     HC_E2E_PUBLIC_IP=$quoted_public_ip \
     HC_E2E_WORKSPACE=$quoted_workspace \
     HC_E2E_BASE_REF=$quoted_base \
     bash '$HC_INTEGRATION_REMOTE_WORKSPACE/run-e2e.sh'"
}

hc_integration_run() {
  hc_integration_create_workspace
  trap hc_integration_cleanup_workspace EXIT

  hc_integration_preflight_remote
  hc_integration_build_source_payload
  hc_integration_write_remote_runner
  hc_integration_transfer_payload
  hc_integration_execute_remote
}

main() {
  case "${1:-}" in
    --help|-h)
      hc_usage
      return 0
      ;;
    "")
      ;;
    *)
      hc_die "Unknown option: $1"
      ;;
  esac

  hc_validate_inputs

  [[ "$HC_INTEGRATION_EXECUTE" == "1" ]] ||
    hc_die \
      "E2E execution is blocked unless HC_INTEGRATION_EXECUTE=1."

  hc_integration_run
}

main "$@"
