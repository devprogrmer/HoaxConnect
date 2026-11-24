---
name: docker-deployment-review
description: "Review HoaxConnect Docker Compose topology, PostgreSQL isolation and candidate API activation."
---

# Docker Deployment Review

Inspect `backend/Dockerfile`, `deploy/compose/compose.source.yml`, `scripts/lib/compose.sh` and `scripts/tests/test-compose.sh`. Verify the API loopback bind and internal database network using fixture variables. Inspect runtime secrets and volume declarations without printing values. Rehearse health gating and persistent volume retention using a disposable Compose project.
