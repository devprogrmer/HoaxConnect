# Network test results

Baseline integration: [GitHub Actions run 46119531878](https://github.com/devprogrmer/HoaxConnect/actions/runs/46119531878) passed. Both paths returned all five probes. The manually switched route preserved the externally observed UDP tuple 10.41.3.1:47362.

Automatic scenario: scripts/test-tunnel-paths.sh pins probes to independent paths, drops direct ingress and measures time and unanswered UDP packets until both controllers use the relay. The run logs carry the measured values.

Field test: BLOCKED. Namespace latency is not representative of the Iran–Turkey internet path.
