# Known issues

- Field topology and ISP results are pending access to staging.
- Relay path failover covers an impaired transit path. Client-side failover for a fully unavailable Iran entry is pending.
- TCP continuity, multipath duplication/deduplication, and long-run capacity are pending.
- Production signing, commercial workflows and closed beta still require verification.
- Route groups currently store topology only. Agent desired-state does not include inter-node routes, keys or forwarding policy; adding a group in Admin does not establish a tunnel or enable failover.
- The operator's Iran host has an interrupted apt transaction with unconfigured packages and limited free disk space; run `dpkg --audit` and repair this independently of the isolated test containers before production deployment.
