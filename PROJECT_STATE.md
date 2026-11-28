# Project state

- Windows release baseline: codex/stage-6-windows-split-tunnel.
- Network integration branch: codex/iran-turkey-path-probes.
- Stage 1 topology: INTEGRATION_TESTED in GitHub Actions. Field staging: BLOCKED on two Iran VPSs, one Turkey VPS with fixed egress, and a Windows test client.
- Stage 2 automatic relay and failback: INTEGRATION_TESTED for persistent TCP and UDP. After reducing the probe window, CI measured 1,254 ms recovery and five unanswered UDP packets, down from 6,013 ms and 24. Field validation and further interruption reduction remain open.
- Next: implement make-before-break packet duplication to reduce interruption further. Validate the same scenarios on field staging when it is available, then implement client-side multi-entry transport.
- Production release and deployment remain blocked on RELEASE_CHECKLIST.md.
