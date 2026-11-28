# Staging deployment

CI: run the Tunnel paths workflow. On a disposable Linux lab with WireGuard tools, iproute2, iptables, Python and Node, build the VPN agent and run sudo bash scripts/test-tunnel-paths.sh.

Field staging needs two Iran hosts, one Turkey host with a fixed public IPv4 address, and a Windows 10/11 test client. Use isolated interfaces, subnets, routing tables, credentials and services. Verify direct and relayed forward and return paths before enabling path controllers as documented in MASTER_ROADMAP.md. Keep NAT on the Turkey host. Record results in NETWORK_TEST_RESULTS.md. Keep HoaxNet and AntiMage out of the test topology.
