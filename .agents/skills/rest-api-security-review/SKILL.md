---
name: rest-api-security-review
description: "Review HoaxConnect REST authentication, device identity and per-account authorization."
---

# Rest Api Security Review

Trace `backend/src/auth.ts`, `backend/src/server.ts` and `backend/migrations/003_account_scoped_device_keys.sql`. Verify each operation binds device identity to the authenticated account. Keep tokens in the Electron main process through the established `electron/auth/` boundaries. Add local HTTP tests for expired sessions, revoked sessions, and an authenticated request against another synthetic account. Check response payload and log redaction.
