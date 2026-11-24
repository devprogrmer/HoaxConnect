---
name: gaming-network-optimization
description: "Evaluate HoaxConnect Windows gaming diagnostics, adapter selection, latency, jitter and packet loss."
---

# Gaming Network Optimization

Read `electron/network.cjs`, `electron/network-doctor.cjs`, `electron/game-detect.cjs` and the ETW helper before changing routing or measurement. Use matched direct and VPN samples with the same target, adapter, DNS condition and sample window. Record median and tail RTT, jitter, loss and workload. Separate game process attribution from connectivity and avoid treating ICMP results as direct evidence of game UDP performance. Validate any tuning on a disposable Windows system and document the reversal procedure.
