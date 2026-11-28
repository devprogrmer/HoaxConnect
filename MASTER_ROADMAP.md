# HoaxConnect master roadmap

Baseline: Windows branch at `77d4e95`. Windows is the first release target. Android and iOS require separate platform feasibility and field validation. This is an initial inventory, not a completed security or release audit.

## Implementation order and acceptance

| Area | Present in branch | Remaining work and acceptance |
| --- | --- | --- |
| Routing and control | Node registration, heartbeat, session authorization, load-based allocation, region preference, Windows service with sing-box and a WireGuard outbound | Bind fresh latency, jitter and probe-loss measurements to eligible nodes. Compare against the same destination on direct and tunneled routes. Verify congestion handling, balancing, recovery, DNS, MTU, IPv4/IPv6 and routing-loop prevention with real traffic. |
| Multipath and failover | Single selected uplink per connection | Establish a stable egress/session model, implement failover and then multipath. Validate existing TCP and UDP flows during node and link loss, and measure the interruption and added overhead. |
| Games and apps | Steam/Epic and Windows discovery, executable selection, partial artwork, process routing configuration | Maintain a licensed catalog, associate launcher and game processes, validate destination and region profiles, detect lifecycle events, and record opt-in per-session quality and lag diagnostics. |
| Windows experience | Account UI, partial Persian/English localization, desktop diagnostics, installer and update workflow | Complete locale coverage, tray/startup and notification behavior, live route graphs, profiles, opt-in crash reporting, secure signed installer/update checks, uninstall cleanup and antivirus/anti-cheat field tests. |
| Backend and admin | PostgreSQL migrations, account/device ownership, refresh rotation, admin moderation/audit, node agent and device reports | Verify access roles and audit coverage, complete node/route/catalog/version administration, telemetry controls, live operational reporting, API contracts, secret rotation, backups and scale tests. |
| Commercial system | Account registration and sign-in | Add account recovery and verification, account MFA, trials, monthly entitlements, device limits, discounts, renewals, payment reconciliation, support and account portal. Verify webhook authentication, idempotency, refunds and entitlement expiry. |
| Operations and security | Windows CI, backend integration jobs, delta checks, Docker deployment assets | Audit auth, service IPC, privileged executable selection, update trust, dependencies and privacy boundaries. Exercise isolated staging, reproducible deployment and rollback, load, alerting and restore before release. |
| Mobile | Windows-first repository | Evaluate Android/iOS per-app VPN and store constraints. Build supported flows and reuse account/entitlement APIs after Windows stabilization. |

## Competitor benchmarks

- [ExitLag technology](https://www.exitlag.com/technology?language=english) describes parallel routes, simultaneous internet connections, traffic shaping and PC performance tools. Independently measure sustained flow continuity, latency distributions, loss and bandwidth overhead before claiming parity.
- [GearUP Adaptive Intelligent Routing](https://www.gearupbooster.com/support/what-is-adaptive-intelligent-routing-technology.html) describes adaptive switching across servers for supported games. Measure endpoint changes across matchmaking and map changes.
- [GearUP platform and catalog coverage](https://www.gearupbooster.com/) describes Windows, mobile and console/router offerings. Installed-app discovery and named, field-validated game profiles are separate coverage measures.

## External dependencies

Execution queue: route scoring → authenticated node probe discovery and a bounded probe scheduler → bind selected node to session allocation → direct/tunnel comparison → isolated failover → stable egress multipath. In parallel after routing integration, proceed with catalog/profiles and localization, then entitlement/payment and admin workflows, then release hardening and mobile feasibility.

The route-quality module covers sample aggregation and fresh eligible-node ranking only. Next implementation task: expose node probe targets through the authenticated API, measure from Electron, and connect rankings to node-specific session allocation. Current Windows auto-selection still uses server load. Preserve load-based fallback when no valid measurements exist.

- Isolated staging with at least two independently routed nodes for failover, and Windows test clients on different networks. The previous server deployment was removed.
- Publisher signing credentials, test payment and verification accounts, and rights to distribute catalog artwork.
- Field sessions for supported games and anti-cheat compatibility. A passing CI installer check does not establish live traffic isolation or game compatibility.

For each release claim record the commit, CI run, test environment, pass/fail evidence and any unresolved issue. Compare performance with matched destinations and repeated samples. Keep HoaxNet and AntiMage outside the deployment scope.

## Iran-to-Turkey transport milestone

Use independent Iranian paths and one Turkish egress. The first scenario
keeps the client on Iran 1 and compares its direct path to Turkey with a
path relayed by Iran 2. A later client-side failover scenario covers loss of
Iran 1 itself. Keep NAT in Turkey and verify the public IP and NAT port
remain stable across changes to the transit path.

The VPN agent provides a standalone authenticated UDP probe for staging.
After building the agent, run the responder on an explicit private tunnel
address on the Turkish host and run the sampler from each Iranian path:

```sh
HC_PATH_PROBE_KEY_FILE=/path/to/probe.key node vpn-agent/dist/path-probe-cli.js respond TURKEY_TUNNEL_IP 45900
HC_PATH_PROBE_KEY_FILE=/path/to/probe.key node vpn-agent/dist/path-probe-cli.js measure IRAN_TUNNEL_IP 45900 TURKEY_TUNNEL_IP
```

Use the same dedicated 32-byte binary key at both ends. Configure and verify
the route for each source/destination pair before measuring. Binding a source
IP does not by itself force a Linux routing table or a symmetric return
path. Samples are round-trip milliseconds, with null for a missing reply.
No route changes are made by the probe. Use repeated samples on each path
before introducing automatic failover, then test a live UDP flow while
impairing only the direct path.

The staging path controller replaces one peer endpoint host route in a dedicated
Linux policy table. It keeps the endpoint address and source address stable.
Both probe paths must already have independent, fixed routes distinct from
the managed endpoint route. Run a controller on each end for bidirectional
switching. Configure forwarding on the relay and retain the existing WireGuard
session and egress NAT on the Turkish gateway. Establish the policy rules
before starting the controller; no default route or policy rule is installed
by the controller.

```sh
HC_PATH_PROBE_KEY_FILE=/path/to/probe.key node vpn-agent/dist/path-failover-cli.js \
  PEER_ENDPOINT_IP TABLE_ID LOCAL_STABLE_IP \
  PRIMARY_NEXT_HOP PRIMARY_INTERFACE PRIMARY_PROBE_IP \
  RELAY_NEXT_HOP RELAY_INTERFACE RELAY_PROBE_IP PROBE_PORT
```

Two consecutive rounds with at least 20% primary probe loss trigger a switch
if the relay is healthy in the latest round. Five healthy primary rounds
permit failback. Loss on both paths retains the current route. If the active
relay degrades and the primary is healthy, the controller returns immediately
to the primary. The controller starts on primary and leaves the last applied
route in place on exit. Staging must exercise restart, live return traffic,
tunnel continuity and multiple-flow behavior before production adoption.
