# Test matrix

| Case | Environment | Acceptance |
| --- | --- | --- |
| Direct and relay UDP | Actions | Both exchange payloads and report probe RTT/loss |
| Direct path outage | Actions | Both route controllers select relay, existing UDP flow recovers, NAT tuple preserved |
| TCP/UDP failover and failback | Staging | Preserve sessions and report loss and interruption |
| Full ingress outage | Staging and Windows | Client changes entry without resetting game session |
| Delay, jitter, loss, multiple outages, MTU and load | Staging | Record p95/p99, packet loss, throughput and resource use |
| Multipath duplication | Staging | Each packet delivered at most once in both directions |
| Install/update/cleanup | Windows 10 and 11 | Clean install, update verification, sleep/restart and disconnect |
| PUBG and Warzone | Two Iran ISPs | Compare direct and tunnel under comparable peak-hour conditions |
