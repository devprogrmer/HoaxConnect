# Staging deployment

CI: run the Tunnel paths workflow. On a disposable Linux lab with WireGuard tools, iproute2, iptables, Python and Node, build the VPN agent and run sudo bash scripts/test-tunnel-paths.sh.

Field staging needs two Iran hosts, one Turkey host with a fixed public IPv4 address, and a Windows 10/11 test client. Use isolated interfaces, subnets, routing tables, credentials and services. Verify direct and relayed forward and return paths before enabling path controllers as documented in MASTER_ROADMAP.md. Keep NAT on the Turkey host. Record results in NETWORK_TEST_RESULTS.md. Keep HoaxNet and AntiMage out of the test topology.

## Clone and verify on an Iran staging host

Use a dedicated test host or an isolated checkout on a shared host. The following
commands fetch the current development branch and run read-only source checks:

```bash
git clone --branch codex/iran-turkey-path-probes https://github.com/devprogrmer/HoaxConnect.git HoaxConnect
cd HoaxConnect
git rev-parse HEAD
npm ci
npm --prefix backend ci
npm --prefix vpn-agent ci
npm run build
npm --prefix backend run build
npm --prefix vpn-agent run build
npm --prefix vpn-agent test
```

For a disposable Ubuntu host with iproute2, iptables, WireGuard kernel support,
wireguard-tools and Python 3, run the isolated topology test as root:

```bash
sudo bash scripts/test-tunnel-paths.sh
```

This test creates temporary network namespaces and deletes them on exit.
It proves the direct and relayed WireGuard paths on that host. It cannot
measure the Internet route to Turkey because both simulated nodes run on
the same machine.

To install the API after obtaining a dedicated domain and a reviewed
configuration, first validate its installer without changes:

```bash
sudo scripts/install.sh --domain api.example.com --email you@example.com \
  --admin-origin https://admin.example.com --source-ref "$(git rev-parse HEAD)" --dry-run
```

The installer deploys the control API and PostgreSQL. The Linux VPN node agent
has its own deployment procedure in docs/product/vpn-node-deployment.md and
requires a real node record and one-time enrollment token. Route groups added
in migration 009 are configuration records only. Their admin UI, activation,
agent distribution, and Turkey gateway transport are still under development.
Do not point a gaming client at a route group until those steps and field
tests pass.
