# HoaxConnect VPN Node Deployment

This runbook deploys the Stage 5 Linux WireGuard node agent. It does not deploy
the Windows tunnel service and does not make the desktop Connect button real.

## Host prerequisites

- A dedicated Linux host with Docker Engine, Compose, nftables, and
  `wireguard-tools`.
- Kernel WireGuard support (`modprobe wireguard` and a disposable `ip link add
  hcwgprobe type wireguard` must succeed).
- IPv4 forwarding enabled deliberately by the host operator.
- The public UDP listen port allowed by the provider firewall and host firewall.
- A dedicated tunnel CIDR that does not overlap host, Docker, or customer LAN
  networks.
- A Backend node record and unused one-time enrollment token created by the
  operator command in `backend/dist/vpn-node-bootstrap.js`.

Do not reuse a node ID, enrollment token, state volume, WireGuard CIDR, or UDP
port across nodes. Never place a client or node private key in the Backend.

## Configuration

Copy `deploy/vpn-node.env.example` to `deploy/vpn-node.env`, mode `0600`, and
replace every example value. `HOAXCONNECT_BACKEND_URL` must be HTTPS outside
loopback. `HOAXCONNECT_EGRESS_INTERFACE` must be the host's real default-route
interface. `HOAXCONNECT_PUBLIC_ENDPOINT` must be reachable by clients.

The Compose service starts with only `NET_ADMIN`, `SETUID`, `SETGID`, and
`SETPCAP`. Its fixed `setpriv` launcher immediately changes to UID/GID 1000,
drops the latter three capabilities, and runs Node with only `NET_ADMIN`. The
container is read-only except for its private state volume and `/tmp` tmpfs.

On first start the agent consumes the enrollment token and writes
`agent-identity.json` and `wireguard.key` with mode `0600`. After that succeeds,
remove `HOAXCONNECT_ENROLLMENT_TOKEN` from the env file and recreate the
container. Keep the state volume; deleting it requires credential revocation
and a new enrollment token.

```bash
chmod 600 deploy/vpn-node.env
docker compose -f deploy/vpn-node.compose.yml config -q
docker compose -f deploy/vpn-node.compose.yml up -d --build
docker compose -f deploy/vpn-node.compose.yml logs --tail 100 vpn-agent
```

## Network ownership

The agent owns only its configured WireGuard interface, the `inet hoaxconnect`
nftables NAT table, and two comment-tagged rules in Docker's `ip filter
DOCKER-USER` chain. NAT and forwarding are restricted to the configured tunnel
CIDR, WireGuard interface, and egress interface. It does not flush firewall
tables or remove unmanaged peers.

Before deployment, reject a host that already has an unmanaged interface or
rules with the chosen names. If the host firewall is managed outside Docker,
review the generated rules and provider firewall separately.

## Verification

```bash
docker compose -f deploy/vpn-node.compose.yml ps
docker compose -f deploy/vpn-node.compose.yml logs --tail 100 vpn-agent
wg show hcx0
nft list table inet hoaxconnect
nft -a list chain ip filter DOCKER-USER | grep hoaxconnect-forward
```

An online heartbeat alone is not acceptance. Authorize a disposable subscribed
device, prove a recent WireGuard handshake and public UDP/TCP egress, revoke the
session, and prove the peer and traffic disappear. The repeatable isolated test
is `sudo HC_ROOT=/opt/HoaxConnect bash scripts/test-vpn-node-e2e.sh`.

## Rollback

1. Revoke the node credential and active VPN sessions in the Backend.
2. Stop the agent Compose service.
3. Remove only rules whose comments match
   `hoaxconnect-forward-<wg-interface>-<egress-interface>-{in,out}`.
4. Delete only the configured HoaxConnect WireGuard interface and the exact
   `inet hoaxconnect` table after confirming no managed session remains.
5. Preserve the state volume for investigation or credential-safe recovery.

Do not delete Docker's shared `ip filter` table or `DOCKER-USER` chain. Do not
remove another project's containers, volumes, firewall rules, or Nginx files.

