# Network test results

Baseline integration: [GitHub Actions run 46119531878](https://github.com/devprogrmer/HoaxConnect/actions/runs/46119531878) passed. Both paths returned all five probes. The manually switched route preserved the externally observed UDP tuple 10.41.3.1:47362.

Automatic scenario: scripts/test-tunnel-paths.sh pins probes to independent paths, drops direct ingress and measures time and unanswered UDP packets until both controllers use the relay. [GitHub Actions run 46120516259](https://github.com/devprogrmer/HoaxConnect/actions/runs/46120516259) passed all 13 VPN agent tests and the WireGuard topology test. The same socket recovered in 6,013 ms after 24 unanswered test packets. Both routes returned 5/5 probes after selection. The gateway preserved the UDP tuple 10.41.3.1:51005. This lab result is not a seamless failover result.

Field test: BLOCKED. Namespace latency is not representative of the Iran–Turkey internet path.

TCP and failback regression: [GitHub Actions run 46120701058](https://github.com/devprogrmer/HoaxConnect/actions/runs/46120701058) passed. One TCP connection and one UDP socket survived relay selection and direct restoration. Egress tuples stayed 10.41.3.1:51519 (TCP) and 10.41.3.1:34682 (UDP). UDP recovery was again 6,013 ms with 24 unanswered packets.

Reduced detection window: [GitHub Actions run 46121136035](https://github.com/devprogrmer/HoaxConnect/actions/runs/46121136035) passed. UDP recovery took 1,254 ms with five unanswered packets. The persistent TCP and UDP sockets survived the route change and failback; gateway tuples were 10.41.3.1:50935 and 10.41.3.1:45504. These timings are from isolated Linux namespaces, not Iran–Turkey field measurements.

The user reported all GitHub Actions green after commit 298665bd4e27a7cb53c22a198b119de523089f29, including controller restart during direct path impairment. The run ID and fresh timing values were not supplied, so this records the reported result without inferring additional measurements.
