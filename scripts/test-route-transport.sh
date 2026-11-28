#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d /tmp/hc-route-lab.XXXXXX)
ns=(hcre hcrg hcri hcrc)
cleanup() {
  status=$?
  trap - EXIT
  if [[ -n "${http_pid:-}" ]]; then kill "$http_pid" 2>/dev/null || true; fi
  for name in "${ns[@]}"; do ip netns del "$name" 2>/dev/null || true; done
  if [[ -n "${gateway_pid:-}" ]]; then kill "$gateway_pid" 2>/dev/null || true; wait "$gateway_pid" 2>/dev/null || true; fi
  rm -rf -- "$tmp"
  exit "$status"
}
trap cleanup EXIT
for name in "${ns[@]}"; do ip netns add "$name"; ip -n "$name" link set lo up; done
ip link add hcu1 type veth peer name hcu2
ip link set hcu1 netns hcre; ip link set hcu2 netns hcrg
ip -n hcre link set hcu1 name under0; ip -n hcrg link set hcu2 name under0
ip -n hcre addr add 198.18.0.1/30 dev under0
ip -n hcrg addr add 198.18.0.2/30 dev under0
ip link add hce1 type veth peer name hce2
ip link set hce1 netns hcrg; ip link set hce2 netns hcri
ip -n hcrg link set hce1 name eth0; ip -n hcri link set hce2 name eth0
ip -n hcrg addr add 203.0.113.1/30 dev eth0
ip -n hcri addr add 203.0.113.2/30 dev eth0
ip link add hcc1 type veth peer name hcc2
ip link set hcc1 netns hcre; ip link set hcc2 netns hcrc
ip -n hcre link set hcc1 name hcx0; ip -n hcrc link set hcc2 name eth0
ip -n hcre addr add 10.143.0.1/24 dev hcx0
ip -n hcrc addr add 10.143.0.2/24 dev eth0
for name in "${ns[@]}"; do
  for dev in $(ip -n "$name" -o link show | awk -F': ' '{print $2}' | cut -d@ -f1); do ip -n "$name" link set "$dev" up; done
done
ip -n hcrc route add default via 10.143.0.1
ip netns exec hcre sysctl -qw net.ipv4.ip_forward=1
ip netns exec hcrg sysctl -qw net.ipv4.ip_forward=1
for name in hcre hcrg; do
  ip netns exec "$name" nft add table ip filter
  ip netns exec "$name" nft 'add chain ip filter DOCKER-USER { type filter hook forward priority -100; policy drop; }'
done
id=124e9e6b-2461-4568-8b6f-95f745501a5d
entry_key=$(wg genkey); gateway_key=$(wg genkey)
entry_public=$(printf '%s' "$entry_key" | wg pubkey)
gateway_public=$(printf '%s' "$gateway_key" | wg pubkey)
for role in entry gateway; do
  mkdir -p "$tmp/$role/route-keys"
  if [[ "$role" == entry ]]; then key=$entry_key; else key=$gateway_key; fi
  printf '%s\n' "$key" > "$tmp/$role/route-keys/$id.key"
  chmod 600 "$tmp/$role/route-keys/$id.key"
done
node - "$tmp" "$id" "$entry_public" "$gateway_public" <<'JS'
const fs = require('fs');
const [tmp,id,entryKey,gatewayKey] = process.argv.slice(2);
const common = {groupId:id,configVersion:'1',phase:'staging',interfaceName:'hcr124e9e6b246',
  gatewayLinkIp:'10.253.17.1',gatewayEndpoint:'198.18.0.2:51820',linkPort:51830,
  routingTable:20101,gatewayPublicKey:gatewayKey,
  peers:[{nodeId:'bf32dbd8-c5a2-477b-90bf-86e286f30288',publicKey:entryKey,
    linkIp:'10.253.17.2',clientCidr:'10.143.0.0/24'}]};
fs.writeFileSync(`${tmp}/gateway.json`,JSON.stringify({...common,role:'gateway',linkAddress:'10.253.17.1/24',clientCidr:null}));
fs.writeFileSync(`${tmp}/entry.json`,JSON.stringify({...common,role:'entry',linkAddress:'10.253.17.2/24',clientCidr:'10.143.0.0/24'}));
JS
ip netns exec hcrg node vpn-agent/tests/route-transport-lab.mjs gateway "$tmp/gateway" "$tmp/gateway.json" "$tmp/flag" >"$tmp/gateway.log" 2>&1 &
gateway_pid=$!
for i in $(seq 1 50); do [[ -f "$tmp/flag.ready" ]] && break; sleep 0.1; done
[[ -f "$tmp/flag.ready" ]] || { cat "$tmp/gateway.log"; exit 1; }
ip netns exec hcre node vpn-agent/tests/route-transport-lab.mjs entry "$tmp/entry" "$tmp/entry.json" "$tmp/flag"
if ip -n hcre -4 rule show | grep -q 'from 10.143.0.0/24 lookup 20101'; then
  echo 'Staging unexpectedly installed client route' >&2; exit 1
fi
printf 'active' > "$tmp/flag"
for i in $(seq 1 50); do [[ -f "$tmp/flag.active" ]] && break; sleep 0.1; done
[[ -f "$tmp/flag.active" ]] || { cat "$tmp/gateway.log"; exit 1; }
node - "$tmp" <<'JS'
const fs = require('fs');const tmp=process.argv[2];const group=JSON.parse(fs.readFileSync(`${tmp}/entry.json`));
group.phase='active';fs.writeFileSync(`${tmp}/entry.json`,JSON.stringify(group));
JS
ip netns exec hcre node vpn-agent/tests/route-transport-lab.mjs entry "$tmp/entry" "$tmp/entry.json" "$tmp/flag"
ip -n hcre -4 rule show | grep -q 'from 10.143.0.0/24 lookup 20101'
ip netns exec hcri python3 -m http.server 8080 --bind 203.0.113.2 >"$tmp/http.log" 2>&1 &
http_pid=$!
for i in $(seq 1 20); do
  if ip netns exec hcrc curl -fsS --max-time 2 http://203.0.113.2:8080/ >"$tmp/response"; then break; fi
  sleep 0.2
done
test -s "$tmp/response"
# A withdrawn entry cannot keep the policy route or forwarding rule.
ip netns exec hcre node --input-type=module -e 'import {RouteTransport} from "./vpn-agent/dist/route-transport.js"; await new RouteTransport(process.argv[1],"hcx0","under0").withdraw()' "$tmp/entry"
! ip -n hcre -4 rule show | grep -q 'from 10.143.0.0/24 lookup 20101'
! ip -n hcre link show hcr124e9e6b246 >/dev/null 2>&1
printf 'withdraw' > "$tmp/flag"
for i in $(seq 1 50); do [[ -f "$tmp/flag.withdrawn" ]] && break; sleep 0.1; done
[[ -f "$tmp/flag.withdrawn" ]] || { cat "$tmp/gateway.log"; exit 1; }
kill "$http_pid" 2>/dev/null || true
printf 'ROUTE_TRANSPORT_LAB_PASSED\n'
