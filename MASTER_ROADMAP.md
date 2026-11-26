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

- Isolated staging with at least two independently routed nodes for failover, and Windows test clients on different networks. The previous server deployment was removed.
- Publisher signing credentials, test payment and verification accounts, and rights to distribute catalog artwork.
- Field sessions for supported games and anti-cheat compatibility. A passing CI installer check does not establish live traffic isolation or game compatibility.

For each release claim record the commit, CI run, test environment, pass/fail evidence and any unresolved issue. Compare performance with matched destinations and repeated samples. Keep HoaxNet and AntiMage outside the deployment scope.
