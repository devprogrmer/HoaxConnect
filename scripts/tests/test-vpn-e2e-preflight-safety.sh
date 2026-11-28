#!/usr/bin/env bash
set -Eeuo pipefail

HC_TEST_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
  pwd -P
)"
HC_TMP="$(mktemp -d)"
trap 'rm -rf -- "$HC_TMP"' EXIT
HC_ROOT="$HC_TMP/root"
HC_BIN="$HC_TMP/bin"
HC_LOG="$HC_TMP/commands.log"
mkdir -p "$HC_ROOT/backend/scripts" "$HC_ROOT/scripts" "$HC_BIN"
: >"$HC_LOG"
touch "$HC_ROOT/backend/scripts/vpn-e2e-fixture.mjs"
cp "$HC_TEST_DIR/../test-vpn-node-e2e.sh" "$HC_ROOT/scripts/"

for command in docker ip nft curl python3 sha256sum openssl ss nginx ping sort cmp df awk wg id sysctl; do
  cat >"$HC_BIN/$command" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "${0##*/}" "$*" >>"$HC_TEST_LOG"
case "${0##*/}" in
  id)
    printf '0\n'
    ;;
  docker)
    if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi
    exit 0
    ;;
  ip)
    if [[ "$1" == "netns" && "$2" == "list" ]]; then exit 0; fi
    if [[ "$1" == "link" && "$2" == "show" && "$3" == "hce2es" ]]; then exit 1; fi
    if [[ "$1" == "link" && "$2" == "show" && "$3" == "hcve2eh" ]]; then
      [[ "${HC_TEST_VETH_EXISTS:-0}" == "1" ]] && exit 0
      exit 1
    fi
    exit 0
    ;;
  nft)
    if [[ "$1" == "list" && "$2" == "table" ]]; then exit 1; fi
    exit 0
    ;;
  sysctl)
    printf '1\n'
    ;;
  *)
    exit 0
    ;;
esac
STUB
  chmod 0755 "$HC_BIN/$command"
done

if output="$(HC_ROOT="$HC_ROOT" HC_TEST_LOG="$HC_LOG" HC_TEST_VETH_EXISTS=1 \
  PATH="$HC_BIN:$PATH" bash "$HC_ROOT/scripts/test-vpn-node-e2e.sh" --preflight 2>&1)"; then
  printf 'Expected preflight to reject the existing host veth interface\n' >&2
  exit 1
fi
grep -Fq 'interface hcve2eh already exists' <<<"$output"
if grep -Eq '^(ip link del|docker rm -f|nft delete)' "$HC_LOG"; then
  printf 'Preflight cleanup touched a host resource\n' >&2
  cat "$HC_LOG" >&2
  exit 1
fi

: >"$HC_LOG"
output="$(HC_ROOT="$HC_ROOT" HC_TEST_LOG="$HC_LOG" HC_TEST_VETH_EXISTS=0 \
  PATH="$HC_BIN:$PATH" bash "$HC_ROOT/scripts/test-vpn-node-e2e.sh" --preflight 2>&1)"
grep -Fq 'VPN_E2E_PREFLIGHT_PASSED' <<<"$output"
if grep -Eq '^(ip link del|docker rm -f|nft delete)' "$HC_LOG"; then
  printf 'Successful preflight cleanup touched a host resource\n' >&2
  cat "$HC_LOG" >&2
  exit 1
fi

printf 'VPN E2E preflight cleanup safety passed\n'
