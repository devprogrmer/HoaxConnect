---
name: local-load-testing
description: "Design bounded local HoaxConnect API and PostgreSQL load tests with synthetic accounts."
---

# Local Load Testing

Read `backend/src/server.ts` and `deploy/compose/compose.source.yml` to identify local API endpoints, data dependencies and readiness. Build the workload with disposable accounts and data. Require the target to resolve to the isolated test instance. Set maximum rate, parallelism and duration, and an error threshold. Record p50, p95, error rate and database connection saturation, then confirm the API returns to baseline.
