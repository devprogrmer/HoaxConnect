# Changelog

## Unreleased

- Added a generic probe-scored Linux transit path controller with hysteresis and cooldown for multiple preconfigured routes to one fixed Turkey endpoint.
- Added an Admin route-group page and audited, optimistic-version topology updates for inactive Iran-entry/Turkey-gateway groups; this does not activate a network tunnel.
- Added a PostgreSQL GitHub Actions job for backend integration tests and route-group API coverage.
- Corrected Admin node status to show a fresh authenticated agent heartbeat and expire stale online status after 90 seconds.
- Added authenticated UDP path measurement and staged relay failover.
- Added GitHub Actions WireGuard topology with a stable Turkey-side NAT tuple.
- Extended the topology test to exercise automatic bidirectional failover and print recovery and loss counters.
