# Project state

- Windows release baseline: codex/stage-6-windows-split-tunnel.
- Network integration branch: codex/iran-turkey-path-probes.
- Stage 1 topology: INTEGRATION_TESTED in GitHub Actions. Field staging: BLOCKED on two Iran VPSs, one Turkey VPS with fixed egress, and a Windows test client.
- Stage 2 automatic UDP relay: IMPLEMENTED in the CI harness. Record the run result in NETWORK_TEST_RESULTS.md.
- Next: verify automatic failover and failback for TCP and UDP, then implement client-side multi-entry transport.
- Production release and deployment remain blocked on RELEASE_CHECKLIST.md.
