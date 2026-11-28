# Iran–Turkey tunnel contract

## Transport

The Windows client routes selected game processes into its stable virtual adapter.
Iran entry nodes forward encrypted WireGuard UDP traffic toward one Turkey gateway.
Turkey holds the authoritative client session and NAT mapping, forwards inner IPv4
TCP and UDP packets to the game, and returns the replies through a currently
healthy entry path. The control API and Admin UI never forward game packets.

The existing integration harness uses one WireGuard peer between Iran 1 and
Turkey. Iran 2 relays outer UDP packets when the direct path loses probes.
The two Linux controllers update dedicated routing-table host routes in both
directions. This is an integration topology, not yet the production multi-entry
transport. To survive complete Iran 1 loss, the Windows client must have a
second independently reachable Iran entry and Turkey must accept traffic for the
same logical client session through either entry while preserving its inner
address and NAT state.

## Admin workflow to implement

1. An operator registers nodes with country, region, capacity, public endpoint,
   and role (Iran entry, relay, Turkey gateway). Reject duplicate endpoints,
   unsafe addresses, conflicting address pools, and missing capacity.
2. An operator creates a route group connecting eligible Iran entries to one
   Turkey gateway. The control API validates topology and stores versioned
   desired state. Nodes receive only the settings and peer public keys they
   own, through authenticated agent requests. Private keys remain on nodes.
3. The operator enables a group only after both directions pass authenticated
   UDP probe and tunnel checks. Status shows each path's RTT, jitter, loss,
   last observation, current selection, and last switch reason.
4. Changes are staged, checked on agents, then activated with an atomic config
   version. Failed activation restores the previous version. Draining removes
   the group from new allocations while leases and existing flows complete.
5. Disable and revoke actions are audited and reconcile peers on affected
   nodes. Panel or control API outages do not remove already active sessions
   before their bounded leases expire.

## Acceptance gates

- Backend migration and API tests cover route-group permissions, concurrency,
  topology validation, versioning, and rollback.
- Agent tests cover idempotent configuration, restart recovery, source-bound
  probes, bounded retries, and expired leases.
- CI network namespaces cover direct and relay paths, both return routes,
  active TCP and UDP, NAT tuple, and failback.
- Field tests cover complete entry failure, multiple ISPs, actual games,
  Linux capacity, and packaged Windows split tunneling.

Keep WireGuard as the encrypted UDP transport. Route selection and any
packet numbering, replication, reordering, and deduplication must be
explicitly designed and tested as a separate layer before enabling
multi-entry traffic.
