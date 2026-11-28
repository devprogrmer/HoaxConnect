# Project state

- Windows release baseline: codex/stage-6-windows-split-tunnel.
- Network integration branch: codex/iran-turkey-path-probes.
- Stage 1 topology: INTEGRATION_TESTED in GitHub Actions. Field staging: BLOCKED on two Iran VPSs, one Turkey VPS with fixed egress, and a Windows test client.
- Stage 2 automatic relay and failback: INTEGRATION_TESTED for persistent TCP and UDP. After reducing the probe window, CI measured 1,254 ms recovery and five unanswered UDP packets, down from 6,013 ms and 24. Field validation and further interruption reduction remain open.
- Desktop connection operations: pending connect and simultaneous disconnect serialization passed GitHub Actions according to the user. Multi-entry and packet duplication still require transport and Backend changes.
- Controller restart on an impaired primary path passed GitHub Actions according to the user. Field validation remains pending.
- Admin route-group foundation: migration 009 and create/list API added for Iran entries and Turkey gateway. Pending migration integration tests, Admin UI, agent desired-state reconciliation, and activation safeguards.
- Route-group management follow-up: Admin UI now creates and lists Iran-entry/Turkey-gateway groups; API supports audited, version-checked topology edits while groups are inactive. Route groups remain inactive; no agent topology rollout, live tunnel activation, or automatic user-path switching exists yet.
- Route-group CI evidence: GitHub Actions run 46143386831 on commit 200c419e passed backend-postgres (65 passed, 0 failed, 0 skipped, including route-group create/edit/stale-version assertions) and admin-build. Route-group inventory management is INTEGRATION_TESTED; activation and packet transport remain NOT_STARTED.
- Iran host evidence reported by operator: vpn-agent build and 14/14 tests passed in isolated Node container; backend build and 17 tests passed with 27 database tests skipped; migrations 001–009 applied to disposable PostgreSQL. A host `apt install npm` was interrupted and left many packages unconfigured. Do not deploy an agent or change host networking before repairing `dpkg`, checking free disk space, and protecting existing HoaxNet services.
- Turkey staging VPS is now available according to operator. Exact connection details and a second independent Iran entry plus Windows client field access remain needed for the full multi-entry field gate. No field traffic or game continuity has been verified.
- Next: implement make-before-break packet duplication to reduce interruption further. Validate the same scenarios on field staging when it is available, then implement client-side multi-entry transport.
- Production release and deployment remain blocked on RELEASE_CHECKLIST.md.
