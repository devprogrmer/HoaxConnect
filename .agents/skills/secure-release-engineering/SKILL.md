---
name: secure-release-engineering
description: "Review HoaxConnect portable source releases and Electron update or Windows installer readiness."
---

# Secure Release Engineering

Use `README.md`, `docs/product/implementation-roadmap.md`, `package.json` and `electron/updater.cjs`. Identify the current release channel and roadmap stage. For Ubuntu, verify the commit ref, candidate activation and backup compatibility. For a requested Windows release, verify the packaging target first, then review signing, update feed origin, artifact integrity and compatible rollback on a disposable Windows host. Keep signing credentials outside the renderer and logs. Avoid publishing builds during local verification.
