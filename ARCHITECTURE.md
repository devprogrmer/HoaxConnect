# Network architecture

Target: Windows split-tunnel virtual adapter → configurable Iran entry paths → one logical session and NAT at the Turkey gateway → game.

Current integration topology: one client-side ingress, one Iran relay, one Turkey gateway, and one UDP destination. Independent authenticated probes measure direct and relay paths in both directions. Each controller updates only its configured peer route. The test retains WireGuard peer addresses and one UDP socket across the change.

Target transport uses WireGuard UDP for both inner TCP and UDP. Multi-entry, sequencing and bounded deduplication belong in a separate transport layer that preserves the virtual IP and gateway session. QUIC, MPTCP and TCP tunnels are outside scope.
