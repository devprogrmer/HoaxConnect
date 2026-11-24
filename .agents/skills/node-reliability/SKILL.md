---
name: node-reliability
description: "Review HoaxConnect API readiness, Compose dependency recovery and desktop reconnection to the control plane."
---

# Node Reliability

Use the deployment README, `deploy/compose/compose.source.yml`, `scripts/lib/compose.sh` and `electron/auth/auth-owner.cjs`. Trace which checks represent process health, API readiness and client session recovery. Keep PostgreSQL unexposed and preserve the loopback API binding. Test database startup delay, candidate API failure and transient client disconnection in disposable infrastructure. Verify that a failed readiness check preserves the prior release and leaves the reason observable.
