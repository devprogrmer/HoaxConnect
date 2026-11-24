---
name: traffic-accounting
description: "Review HoaxConnect per-process Windows traffic measurement and diagnostic attribution."
---

# Traffic Accounting

Trace Windows kernel ETW events in `native/HoaxTraffic/Program.cs` into `electron/traffic-helper.cjs` and `src/ProcessTrafficPanel.tsx`. Record the sampling interval, bytes versus rates and process identity. Design fixtures for restarted or reused PIDs, helper startup failure, zero samples and missing privileges. Verify that missing measurements remain distinguishable from idle traffic. Keep process-level diagnostics out of logs and telemetry unless explicitly required by the feature.
