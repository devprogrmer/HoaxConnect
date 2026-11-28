# Windows multi-entry operation (option 2)

HoaxConnect can authorize two to five Iran entry nodes from one active Route Group and keep all corresponding WireGuard endpoints warm inside the Windows routing service.

## Control flow

1. The desktop service supplies its persistent WireGuard public key to `POST /api/v1/vpn/authorize-multi` and requests 2–5 paths.
2. The Backend locks the account, device, subscription, selected nodes and address allocations in one PostgreSQL transaction. It chooses one active Route Group with enough fresh healthy Iran members and creates one peer/session per entry under a shared `connection_group_id`.
3. The Windows service validates the full set, builds one userspace WireGuard endpoint per Iran entry and routes only the selected application processes into a `urltest` group.
4. The pinned routing engine probes every path every three seconds. A 20 ms tolerance avoids needless path changes. When the selected path becomes unhealthy, existing flows are interrupted at the local routing layer and moved to the best surviving entry; the application VPN stays connected and the other WireGuard endpoints remain warm.
5. Disconnect, lease expiry, account moderation and logout revoke every session in the logical connection. A request for more paths than one healthy active Route Group can provide fails atomically and installs nothing locally.

## Required server state

- Option 1 must be staged and active for the Route Group.
- Every requested Iran entry and the Turkey gateway must have a fresh agent heartbeat and fresh healthy route-group report.
- Iran client CIDRs must be distinct and must have adequate free addresses.
- The subscription's concurrent-session limit counts the multi-entry set as one logical connection.

## Verification boundary

CI verifies PostgreSQL allocation/rollback, API validation, desktop state, service protocol, generated multi-endpoint configuration against the pinned sing-box binary, the Windows installer and installed-service smoke test. Actual ISP diversity, public UDP reachability and game behavior still require field validation on real Iran and Turkey hosts before production release.
