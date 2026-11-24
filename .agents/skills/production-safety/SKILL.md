---
name: production-safety
description: "Review HoaxConnect Ubuntu deployment, PostgreSQL backup and restore, migrations and rollback readiness."
---

# Production Safety

Read `scripts/install.sh`, `scripts/update.sh`, `scripts/backup.sh`, `scripts/restore.sh`, `scripts/lib/compose.sh` and the deployment README. Check immutable source ref, backup checksum and restore rehearsal, API readiness, Nginx routing, TLS and the internal PostgreSQL network. Treat switching application releases and recovering PostgreSQL schema as separate operations. Rehearse in a disposable host. Record evidence of data preservation and the rollback decision before any separately authorized production operation.
