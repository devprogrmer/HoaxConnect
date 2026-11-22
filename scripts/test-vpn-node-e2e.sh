#!/usr/bin/env bash
set -Eeuo pipefail

HC_ROOT="${HC_ROOT:-/opt/HoaxConnect}"
HC_NODE_IMAGE="${HC_NODE_IMAGE:-hoaxnet-web:037666afa7c3f81cdeff9c25ebe0ac702fc7f872}"
HC_AGENT_IMAGE="${HC_AGENT_IMAGE:-hoaxconnect-vpn-agent:stage5-test}"
HC_DB=hc-vpn-e2e-db
HC_API=hc-vpn-e2e-api
HC_AGENT=hc-vpn-e2e-agent
HC_NS=hc-vpn-e2e-client
HC_VETH_HOST=hcve2eh
HC_VETH_CLIENT=hcve2ec
HC_SERVER_IF=hce2es
HC_CLIENT_IF=hce2ec
HC_API_PORT=31991
HC_WG_PORT=51999
HC_TMP=""
HC_NFT_OWNED=0

die() { printf 'E2E_ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || { printf 'MISSING_PREREQUISITE=%s\n' "$1"; exit 20; }; }

preflight() {
  test "$(id -u)" -eq 0 || die "run as root"
  for command in docker ip nft curl python3 sha256sum openssl ss nginx ping sort cmp df awk; do
    need "$command"
  done
  need wg
  test -d "$HC_ROOT/backend" || die "HoaxConnect test checkout is missing"
  test -f "$HC_ROOT/backend/scripts/vpn-e2e-fixture.mjs" || die "E2E fixture is missing"
  docker image inspect "$HC_NODE_IMAGE" >/dev/null
  docker image inspect "$HC_AGENT_IMAGE" >/dev/null
  for name in "$HC_DB" "$HC_API" "$HC_AGENT"; do
    test -z "$(docker ps -aq --filter "name=^/${name}$")" || die "container ${name} already exists"
  done
  ! ip netns list | grep -q "^${HC_NS}\b" || die "namespace ${HC_NS} already exists"
  ! ip link show "$HC_SERVER_IF" >/dev/null 2>&1 || die "interface ${HC_SERVER_IF} already exists"
  ! nft list table inet hoaxconnect >/dev/null 2>&1 || die "nft table inet hoaxconnect already exists"
  ! nft -a list chain ip filter DOCKER-USER 2>/dev/null | \
    grep -q "hoaxconnect-forward-${HC_SERVER_IF}-" || die "E2E forwarding rules already exist"
  ! ss -ltn | grep -q ":${HC_API_PORT} " || die "TCP ${HC_API_PORT} is busy"
  ! ss -lun | grep -q ":${HC_WG_PORT} " || die "UDP ${HC_WG_PORT} is busy"
  test "$(sysctl -n net.ipv4.ip_forward)" = "1" || die "IPv4 forwarding is disabled"
}

cleanup_runtime() {
  set +e
  docker rm -f "$HC_AGENT" "$HC_API" "$HC_DB" >/dev/null 2>&1
  ip netns del "$HC_NS" >/dev/null 2>&1
  ip link del "$HC_SERVER_IF" >/dev/null 2>&1
  ip link del "$HC_VETH_HOST" >/dev/null 2>&1
  if test -n "${HC_EGRESS:-}"; then
    for suffix in in out; do
      marker="hoaxconnect-forward-${HC_SERVER_IF}-${HC_EGRESS}-${suffix}"
      for handle in $(nft -a list chain ip filter DOCKER-USER 2>/dev/null | \
        awk -v marker="$marker" 'index($0, marker) {print $NF}'); do
        nft delete rule ip filter DOCKER-USER handle "$handle" >/dev/null 2>&1 || true
      done
    done
  fi
  if test "$HC_NFT_OWNED" = 1; then nft delete table inet hoaxconnect >/dev/null 2>&1; fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if test "$status" -ne 0; then
    for container in "$HC_AGENT" "$HC_API" "$HC_DB"; do
      if docker ps -aq --filter "name=^/${container}$" | grep -q .; then
        printf '===== %s LOG =====\n' "$container" >&2
        docker logs --tail 120 "$container" >&2 || true
      fi
    done
  fi
  cleanup_runtime
  if test -n "$HC_TMP"; then
    case "$HC_TMP" in /tmp/hc-vpn-e2e.*) rm -rf -- "$HC_TMP" ;; esac
  fi
  exit "$status"
}
trap cleanup EXIT

if test "${1:-}" = "--preflight"; then
  preflight
  echo "VPN_E2E_PREFLIGHT_PASSED"
  exit 0
fi

preflight
HC_TMP="$(mktemp -d /tmp/hc-vpn-e2e.XXXXXX)"
chmod 700 "$HC_TMP"
HC_BEFORE_NAMES="$HC_TMP/containers.before"
HC_AFTER_NAMES="$HC_TMP/containers.after"
HC_BEFORE_NGINX="$HC_TMP/nginx.before"
docker ps --filter name=hoaxnet --format '{{.Names}}' | sort >"$HC_BEFORE_NAMES"
nginx -T 2>/dev/null | sha256sum >"$HC_BEFORE_NGINX"
HC_DISK_BEFORE="$(df --output=used / | tail -n1)"
HC_EGRESS="$(ip -4 route show default | awk 'NR==1 {print $5}')"
test -n "$HC_EGRESS" || die "default egress interface not found"

HC_DB_PASSWORD="$(openssl rand -hex 24)"
HC_ENROLLMENT_TOKEN="$(openssl rand -base64 32 | tr -d '=+/\n' | cut -c1-43)"
HC_JWT_SECRET="$(openssl rand -hex 64)"
HC_REFRESH_PEPPER="$(openssl rand -hex 64)"
HC_RECOVERY_KEY="$(openssl rand -base64 32 | tr -d '\n')"

docker run -d --name "$HC_DB" --memory 384m --cpus 1.0 \
  -e POSTGRES_DB=hoaxconnect_vpn_e2e_test -e POSTGRES_USER=hc_e2e \
  -e POSTGRES_PASSWORD="$HC_DB_PASSWORD" -p 127.0.0.1::5432 postgres:18-bookworm >/dev/null
HC_DB_PORT="$(docker port "$HC_DB" 5432/tcp | awk -F: 'NR==1 {print $NF}')"
for _ in $(seq 1 90); do
  if docker logs "$HC_DB" 2>&1 | grep -F 'PostgreSQL init process complete; ready for start up' >/dev/null && \
    docker exec "$HC_DB" pg_isready -U hc_e2e -d hoaxconnect_vpn_e2e_test >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker logs "$HC_DB" 2>&1 | grep -F 'PostgreSQL init process complete; ready for start up' >/dev/null
docker exec "$HC_DB" pg_isready -U hc_e2e -d hoaxconnect_vpn_e2e_test >/dev/null
HC_DATABASE_URL="postgresql://hc_e2e:${HC_DB_PASSWORD}@127.0.0.1:${HC_DB_PORT}/hoaxconnect_vpn_e2e_test"

docker run -d --name "$HC_API" --network host --memory 384m --cpus 1.0 \
  -v "$HC_ROOT/backend:/app:ro" -w /app \
  -e NODE_ENV=test -e HOST=127.0.0.1 -e PORT="$HC_API_PORT" \
  -e DATABASE_URL="$HC_DATABASE_URL" -e DATABASE_SSL=false -e LOG_LEVEL=warn \
  -e JWT_ACCESS_SECRET="$HC_JWT_SECRET" -e JWT_ISSUER=https://vpn-e2e.test \
  -e JWT_AUDIENCE=hoaxconnect-desktop -e REFRESH_TOKEN_PEPPER="$HC_REFRESH_PEPPER" \
  -e REFRESH_RECOVERY_ENCRYPTION_KEY="$HC_RECOVERY_KEY" \
  "$HC_NODE_IMAGE" sh -lc 'node dist/migrate.js && node dist/server.js' >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${HC_API_PORT}/api/v1/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${HC_API_PORT}/api/v1/health/ready" >/dev/null

ip netns add "$HC_NS"
ip link add "$HC_VETH_HOST" type veth peer name "$HC_VETH_CLIENT"
ip link set "$HC_VETH_CLIENT" netns "$HC_NS"
ip addr add 192.0.2.1/30 dev "$HC_VETH_HOST"
ip link set "$HC_VETH_HOST" up
ip netns exec "$HC_NS" ip addr add 192.0.2.2/30 dev "$HC_VETH_CLIENT"
ip netns exec "$HC_NS" ip link set lo up
ip netns exec "$HC_NS" ip link set "$HC_VETH_CLIENT" up
ip netns exec "$HC_NS" ip route add default via 192.0.2.1 dev "$HC_VETH_CLIENT"

HC_FIXTURE_ENV=(
  -e NODE_ENV=test -e DATABASE_URL="$HC_DATABASE_URL" -e DATABASE_SSL=false
  -e JWT_ACCESS_SECRET="$HC_JWT_SECRET" -e JWT_ISSUER=https://vpn-e2e.test
  -e JWT_AUDIENCE=hoaxconnect-desktop -e REFRESH_TOKEN_PEPPER="$HC_REFRESH_PEPPER"
  -e REFRESH_RECOVERY_ENCRYPTION_KEY="$HC_RECOVERY_KEY"
  -e HC_E2E_ENROLLMENT_TOKEN="$HC_ENROLLMENT_TOKEN"
  -e HC_E2E_PUBLIC_ENDPOINT="192.0.2.1:${HC_WG_PORT}"
  -e HC_E2E_TUNNEL_CIDR=10.99.0.0/24 -e HC_E2E_EGRESS_INTERFACE="$HC_EGRESS"
  -e HC_E2E_RUN_ID="$(date +%s)-$$"
)
docker run --rm --network host --memory 256m --cpus 0.5 \
  -v "$HC_ROOT/backend:/app:ro" -w /app "${HC_FIXTURE_ENV[@]}" \
  "$HC_NODE_IMAGE" node scripts/vpn-e2e-fixture.mjs >"$HC_TMP/fixture.env"
source "$HC_TMP/fixture.env"

install -d -o 1000 -g 1000 -m 0700 "$HC_TMP/agent-state"
HC_NFT_OWNED=1
docker run -d --name "$HC_AGENT" --network host --memory 128m --cpus 0.5 \
  --cap-drop ALL --cap-add NET_ADMIN --cap-add SETUID --cap-add SETGID --cap-add SETPCAP \
  --security-opt no-new-privileges:true \
  -v "$HC_TMP/agent-state:/state" \
  -e HOAXCONNECT_BACKEND_URL="http://127.0.0.1:${HC_API_PORT}" \
  -e HOAXCONNECT_VPN_NODE_ID="$NODE_ID" -e HOAXCONNECT_ENROLLMENT_TOKEN="$HC_ENROLLMENT_TOKEN" \
  -e HOAXCONNECT_PUBLIC_ENDPOINT="192.0.2.1:${HC_WG_PORT}" \
  -e HOAXCONNECT_EGRESS_INTERFACE="$HC_EGRESS" -e HOAXCONNECT_WG_INTERFACE="$HC_SERVER_IF" \
  -e HOAXCONNECT_WG_ADDRESS=10.99.0.1/24 -e HOAXCONNECT_WG_PORT="$HC_WG_PORT" \
  -e HOAXCONNECT_CAPACITY_PEERS=10 -e HOAXCONNECT_RECONCILE_INTERVAL_MS=1000 \
  "$HC_AGENT_IMAGE" >/dev/null

for _ in $(seq 1 45); do
  ip link show "$HC_SERVER_IF" >/dev/null 2>&1 && \
    docker exec "$HC_DB" psql -U hc_e2e -d hoaxconnect_vpn_e2e_test -Atc \
      "SELECT status FROM vpn_nodes WHERE id='${NODE_ID}'" | grep -qx online && break
  sleep 1
done
ip link show "$HC_SERVER_IF" >/dev/null
nft list table inet hoaxconnect >/dev/null

umask 077
wg genkey >"$HC_TMP/client.key"
wg pubkey <"$HC_TMP/client.key" >"$HC_TMP/client.pub"
HC_CLIENT_PUBLIC_KEY="$(tr -d '\n' <"$HC_TMP/client.pub")"
curl -fsS -X POST "http://127.0.0.1:${HC_API_PORT}/api/v1/vpn/authorize" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  --data "{\"client_public_key\":\"${HC_CLIENT_PUBLIC_KEY}\",\"country_code\":\"DE\",\"region\":\"e2e\"}" \
  >"$HC_TMP/authorization.json"
HC_ASSIGNED_IP="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["data"]["client"]["assigned_ip"])' "$HC_TMP/authorization.json")"
HC_SERVER_PUBLIC_KEY="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["data"]["node"]["public_key"])' "$HC_TMP/authorization.json")"

for _ in $(seq 1 30); do
  wg show "$HC_SERVER_IF" peers | grep -qxF "$HC_CLIENT_PUBLIC_KEY" && break
  sleep 1
done
wg show "$HC_SERVER_IF" peers | grep -qxF "$HC_CLIENT_PUBLIC_KEY"
ip netns exec "$HC_NS" ip link add "$HC_CLIENT_IF" type wireguard
ip netns exec "$HC_NS" wg set "$HC_CLIENT_IF" private-key "$HC_TMP/client.key" \
  peer "$HC_SERVER_PUBLIC_KEY" endpoint "192.0.2.1:${HC_WG_PORT}" \
  allowed-ips 0.0.0.0/0 persistent-keepalive 5
ip netns exec "$HC_NS" ip addr add "${HC_ASSIGNED_IP}/32" dev "$HC_CLIENT_IF"
ip netns exec "$HC_NS" ip link set "$HC_CLIENT_IF" up
ip netns exec "$HC_NS" ip route replace default dev "$HC_CLIENT_IF"

ip netns exec "$HC_NS" ping -c 2 -W 2 10.99.0.1 >"$HC_TMP/ping.log"
ip netns exec "$HC_NS" python3 - <<'PY'
import socket
import struct

transaction_id = b"\x48\x43"
question = b"".join(bytes([len(label)]) + label for label in b"example.com".split(b"."))
packet = transaction_id + struct.pack("!HHHHH", 0x0100, 1, 0, 0, 0) + question + b"\x00\x00\x01\x00\x01"
client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
client.settimeout(10)
client.sendto(packet, ("1.1.1.1", 53))
response, _ = client.recvfrom(4096)
assert response[:2] == transaction_id and len(response) > 12
PY
ip netns exec "$HC_NS" curl -kfsS --max-time 20 https://1.1.1.1/cdn-cgi/trace >"$HC_TMP/egress.log"
grep -q '^ip=' "$HC_TMP/egress.log"
wg show "$HC_SERVER_IF" latest-handshakes | awk -v key="$HC_CLIENT_PUBLIC_KEY" '$1==key && $2>0 {found=1} END{exit !found}'

curl -fsS -X POST "http://127.0.0.1:${HC_API_PORT}/api/v1/vpn/disconnect" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" -H 'Content-Type: application/json' --data '{}' >/dev/null
for _ in $(seq 1 20); do
  ! wg show "$HC_SERVER_IF" peers | grep -qxF "$HC_CLIENT_PUBLIC_KEY" && break
  sleep 1
done
! wg show "$HC_SERVER_IF" peers | grep -qxF "$HC_CLIENT_PUBLIC_KEY"
if ip netns exec "$HC_NS" ping -c 1 -W 2 10.99.0.1 >/dev/null 2>&1; then
  die "revoked peer still passes traffic"
fi

cleanup_runtime
set -e
docker ps --filter name=hoaxnet --format '{{.Names}}' | sort >"$HC_AFTER_NAMES"
cmp "$HC_BEFORE_NAMES" "$HC_AFTER_NAMES"
nginx -T 2>/dev/null | sha256sum | cmp "$HC_BEFORE_NGINX" -
for container in $(cat "$HC_BEFORE_NAMES"); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
  case "$status" in healthy|running) ;; *) die "unrelated container ${container} is ${status}" ;; esac
done
HC_DISK_AFTER="$(df --output=used / | tail -n1)"
test $((HC_DISK_AFTER - HC_DISK_BEFORE)) -lt 1048576 || die "E2E consumed more than 1 GiB"
printf 'VPN_E2E_PASSED assigned_ip=%s egress=%s\n' "$HC_ASSIGNED_IP" "$(grep '^ip=' "$HC_TMP/egress.log" | head -n1)"
case "$HC_TMP" in /tmp/hc-vpn-e2e.*) rm -rf -- "$HC_TMP" ;; esac
trap - EXIT

