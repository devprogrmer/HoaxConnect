#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if (( EUID != 0 )); then
  echo "Run as root on a disposable Linux runner" >&2
  exit 1
fi
for command in ip wg iptables python3 node; do
  command -v "$command" >/dev/null
done

work="$(mktemp -d)"
created=()
children=()
cleanup() {
  for pid in "${children[@]}"; do kill "$pid" 2>/dev/null || true; done
  for ns in "${created[@]}"; do ip netns delete "$ns" || true; done
  rm -rf -- "$work"
}
trap cleanup EXIT
entry="hc-entry-$$"
relay="hc-relay-$$"
exit_node="hc-exit-$$"
game="hc-game-$$"
for ns in "$entry" "$relay" "$exit_node" "$game"; do
  ip netns add "$ns"
  created+=("$ns")
  ip -n "$ns" link set lo up
done

link() {
  local left="$1" left_dev="$2" left_ip="$3" right="$4" right_dev="$5" right_ip="$6"
  ip -n "$left" link add "$left_dev" type veth peer name "$right_dev" netns "$right"
  ip -n "$left" addr add "$left_ip" dev "$left_dev"
  ip -n "$right" addr add "$right_ip" dev "$right_dev"
  ip -n "$left" link set "$left_dev" up
  ip -n "$right" link set "$right_dev" up
}

link "$entry" direct 10.41.0.1/30 "$exit_node" direct 10.41.0.2/30
link "$entry" alternate 10.41.1.1/30 "$relay" entry0 10.41.1.2/30
link "$relay" exit0 10.41.2.1/30 "$exit_node" alternate 10.41.2.2/30
link "$exit_node" public0 10.41.3.1/30 "$game" game0 10.41.3.2/30

for ns in "$relay" "$exit_node"; do
  ip netns exec "$ns" sysctl -qw net.ipv4.ip_forward=1
done
ip -n "$entry" addr add 192.0.2.1/32 dev lo
ip -n "$exit_node" addr add 192.0.2.2/32 dev lo
ip -n "$relay" route add 192.0.2.1/32 via 10.41.1.1
ip -n "$relay" route add 192.0.2.2/32 via 10.41.2.2
ip -n "$entry" route add 192.0.2.2/32 via 10.41.0.2 src 192.0.2.1
ip -n "$exit_node" route add 192.0.2.1/32 via 10.41.0.1 src 192.0.2.2

umask 077
wg genkey >"$work/entry.key"
wg genkey >"$work/exit.key"
entry_pub="$(wg pubkey <"$work/entry.key")"
exit_pub="$(wg pubkey <"$work/exit.key")"
for ns in "$entry" "$exit_node"; do ip -n "$ns" link add wg0 type wireguard; done
ip -n "$entry" addr add 10.42.0.1/30 dev wg0
ip -n "$exit_node" addr add 10.42.0.2/30 dev wg0
ip netns exec "$entry" wg set wg0 listen-port 51820 private-key "$work/entry.key" \
  peer "$exit_pub" endpoint 192.0.2.2:51820 allowed-ips 10.42.0.2/32,10.41.3.2/32
ip netns exec "$exit_node" wg set wg0 listen-port 51820 private-key "$work/exit.key" \
  peer "$entry_pub" endpoint 192.0.2.1:51820 allowed-ips 10.42.0.1/32
for ns in "$entry" "$exit_node"; do ip -n "$ns" link set wg0 up; done
ip -n "$entry" route add 10.41.3.2/32 dev wg0
ip netns exec "$exit_node" iptables -t nat -A POSTROUTING -s 10.42.0.1/32 -o public0 \
  -j SNAT --to-source 10.41.3.1

python3 -c 'import os,sys; open(sys.argv[1],"wb").write(os.urandom(32))' "$work/probe.key"
export HC_PATH_PROBE_KEY_FILE="$work/probe.key"
ip netns exec "$exit_node" node vpn-agent/dist/path-probe-cli.js respond 10.42.0.2 45900 >"$work/probe.log" &
children+=("$!")
ip netns exec "$game" python3 -u -c '
import socket
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
    sock.bind(("10.41.3.2", 45901))
    print("ready")
    while True:
        packet, peer = sock.recvfrom(512)
        sock.sendto(packet + ("|%s:%d" % peer).encode(), peer)
' >"$work/game.log" &
children+=("$!")
for ready in "$work/probe.log" "$work/game.log"; do
  for _ in {1..50}; do
    [[ -s "$ready" ]] && break
    sleep .1
  done
  [[ -s "$ready" ]]
done

python3 - "$entry" "$relay" "$exit_node" <<'PY'
import json
import subprocess
import sys

entry, relay, exit_node = sys.argv[1:]

def ip(*args):
    return subprocess.check_output(["ip", *args], text=True)

def relay_received():
    links = json.loads(ip("-n", relay, "-j", "-s", "link", "show"))
    return {link["ifname"]: link["stats64"]["rx"]["packets"] for link in links}

def measure(label):
    command = ["ip", "netns", "exec", entry, "node", "vpn-agent/dist/path-probe-cli.js",
               "measure", "10.42.0.1", "45900", "10.42.0.2"]
    report = json.loads(subprocess.check_output(command, text=True))
    assert report["lossPercent"] == 0 and len(report["samples"]) == 5, report
    print(json.dumps({"path": label, **report}), flush=True)

# One socket remains open across both route changes and reports the peer tuple
# observed beyond the Turkish SNAT.
client = r"""
import json
import socket
import sys
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
    sock.bind(("10.42.0.1", 0))
    sock.settimeout(5)
    for line in sys.stdin:
        payload = line.strip().encode()
        sock.sendto(payload, ("10.41.3.2", 45901))
        reply, addr = sock.recvfrom(512)
        echoed, peer = reply.decode().split("|")
        assert echoed == payload.decode() and addr == ("10.41.3.2", 45901)
        print(json.dumps(peer), flush=True)
"""
with subprocess.Popen(["ip", "netns", "exec", entry, "python3", "-c", client],
                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as flow:
    def round_trip(label):
        flow.stdin.write(label + "\n")
        flow.stdin.flush()
        return json.loads(flow.stdout.readline())

    try:
        direct_peer = round_trip("direct")
        assert direct_peer.startswith("10.41.3.1:"), direct_peer
        measure("direct")
        before = relay_received()
        ip("-n", entry, "route", "replace", "192.0.2.2/32", "via", "10.41.1.2", "src", "192.0.2.1")
        ip("-n", exit_node, "route", "replace", "192.0.2.1/32", "via", "10.41.2.1", "src", "192.0.2.2")
        # Remove the direct link as a possible fallback.
        ip("-n", entry, "link", "set", "direct", "down")
        relay_peer = round_trip("relay")
        measure("relay")
        after = relay_received()
        assert after["entry0"] > before["entry0"] and after["exit0"] > before["exit0"]
        assert relay_peer == direct_peer, (direct_peer, relay_peer)
        print("TUNNEL_PATHS_E2E_OK stable_egress=" + relay_peer, flush=True)
    finally:
        flow.stdin.close()
        flow.wait(timeout=6)
PY
