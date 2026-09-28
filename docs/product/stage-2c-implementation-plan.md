# Stage 2C Implementation Plan

Status: BLOCKED - awaiting implementation-plan approval

## Objective

Replace desktop demo authentication with real Backend authentication and stable
device identity while preserving existing diagnostics and networking features.

This plan does not implement SMS delivery, payments, Admin Panel, VPN peer
provisioning, Android, or the Windows privileged service.

## Exact Files

Modify:

- `backend/src/auth.ts`
- `backend/src/security.ts`
- `backend/src/config.ts`
- `backend/src/app.ts`
- `backend/.env.example`
- `deploy/backend.env.example`
- `deploy/templates/backend.env.template`
- `deploy/compose/compose.source.yml` when new variables are required
- `backend/tests/setup.ts`
- `electron/main.cjs`
- `electron/preload.cjs`
- `src/App.tsx`
- `src/App.css`
- `src/electron.d.ts`

Add:

- `backend/migrations/002_stage2c_auth_devices.sql`
- `backend/src/device-proof.ts`
- `backend/src/policy-events.ts`
- `backend/tests/auth.integration.test.ts`
- `backend/tests/device-proof.test.ts`
- `backend/tests/stage2c-migration.test.ts`
- `electron/auth-client.cjs`
- `electron/auth-store.cjs`
- `electron/device-identity.cjs`
- `electron/policy-channel.cjs`
- `src/auth/AuthGate.tsx`
- `src/auth/types.ts`

No Admin, payment, VPN-node, Android, WireGuard, or Windows Service source is
added in Stage 2C.

## PostgreSQL Migration

Create `002_stage2c_auth_devices.sql`.

Change `users`:

- Add `phone` and canonical `phone_normalized`.
- Add `phone_verified_at`.
- Add `banned_at` and `ban_reason`.
- Add `banned` to `user_status`.
- Add a partial unique index for non-null normalized phone values.
- Preserve optional email verification; phone OTP remains Stage 3.

Change `devices`:

- Add platform, OS version, architecture, and device-name metadata.
- Add Ed25519 public key in canonical SPKI form.
- Add SHA-256 key fingerprint and unique index.
- Add key algorithm and proof-verification timestamp.
- Add device ban timestamp and reason.
- Preserve existing revocation fields and existing device rows.

Change `sessions`:

- Add proof-verification timestamp.
- Preserve existing family, parent, replacement, reuse, and revocation fields.

Add `device_challenges`:

- UUID identifier.
- User and optional device binding.
- Purpose: enrollment, login, refresh, or key rotation.
- Device UID and key-fingerprint binding.
- Hashed random nonce; never store a reusable plaintext challenge.
- Issued, expiry, consumed, and invalidated timestamps.
- Failed-attempt count and maximum-attempt enforcement.
- Indexes for active challenge lookup and expiry cleanup.

Add `device_limit_violations`:

- User, attempted device metadata, effective limit, decision, IP, user agent,
  audit context, and timestamps.

Add `policy_events`:

- Monotonic identity.
- User, optional device, and optional session scope.
- Event type, reason, account authorization version, payload, creation time,
  and expiry.
- Index for resumable per-user event delivery.

Migration must support a fresh `001 + 002` database and upgrade of a populated
`001` database without inventing device keys.

## Backend Endpoints

Update:

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/logout-all`
- `GET /api/v1/client/me`
- `GET /api/v1/client/devices`
- `DELETE /api/v1/client/devices/:deviceId`

Add:

- `POST /api/v1/auth/device-proof`
- `POST /api/v1/auth/refresh/challenge`
- `GET /api/v1/client/policy`
- `GET /api/v1/client/policy/events`

Registration and login return a pending proof transaction, not usable tokens.
Only successful proof verification creates an authenticated session.

## Device Enrollment And Proof Of Possession

Electron main generates an Ed25519 keypair on first enrollment.

The signed payload uses a canonical versioned format containing:

- Protocol version.
- Challenge ID and purpose.
- Random nonce.
- User and device binding.
- Public-key fingerprint.
- Issued and expiry timestamps.

Backend verifies the nonce hash, expiry, purpose, bindings, attempt count and
signature inside one transaction. A challenge is consumed exactly once.
Renderer never receives the nonce, signature operation or private key.

Key rotation revokes sessions associated with the previous key. A normal
application reinstall preserves the same device identity when its protected
userData and device key remain available. New enrollment occurs only after an
intentional identity reset, protected-key loss, Windows profile or OS change,
device change, or explicit recovery. Identity loss never bypasses the device
limit. Lost-device recovery remains dependent on Stage 3 OTP or explicit
Admin action.

## Registration And Login

Registration:

1. Renderer submits form values through typed preload IPC.
2. Main sends email, phone, password, device metadata and public key.
3. Backend creates the account and pending device transactionally.
4. Backend issues an enrollment challenge.
5. Main signs it and submits proof.
6. Backend consumes proof and creates the first session.
7. Main stores protected refresh state and loads the profile.

Phone remains unverified until Stage 3. No fake OTP success is returned.

Login:

1. Main submits credentials and stable device UID.
2. Backend verifies password, account state and applicable policy.
3. Known device receives a login challenge.
4. New device supplies its public key and enters enrollment.
5. Backend locks the user device-allocation scope.
6. Backend computes the active subscription device limit, or the configured
   pre-subscription limit of one.
7. An excess device is rejected and a violation plus audit event is recorded.
8. Successful signed proof creates the session.

Transactional locking or an equivalent atomic operation prevents simultaneous
requests from exceeding the device limit.

## Refresh Rotation And Session Restore

Refresh is a two-step proof-backed operation:

1. Main submits the refresh token through the refresh-challenge endpoint; Backend
   authenticates its hash without rotating it. A session identifier alone is
   insufficient.
2. Backend issues a short-lived challenge bound to that session and device.
3. Main signs it and submits the refresh token plus proof.
4. Backend locks the session family, verifies proof and token, rotates the
   session, and invalidates the old token atomically.
5. Reuse revokes the whole family and emits a security policy event.

A short idempotent recovery record allows safe recovery if Backend committed
rotation but the application crashed before persisting the replacement.

On application restart:

- Main decrypts stored state.
- Requests and signs a refresh challenge.
- Rotates the session.
- Loads `/api/v1/client/me`.
- Starts the policy event channel.
- Sends only sanitized authenticated state to Renderer.

Unreadable or corrupt protected storage is quarantined. The application returns
to login without falsely claiming that the server session was revoked.

## Logout And Account Policy

Logout revokes the current session and clears local protected state.

Logout-all:

- Revokes every active session family.
- Advances account authorization version.
- Creates a policy event.
- Clears current local authorization.

Every protected Backend request validates:

- Access-token claims and authorization version.
- Active session.
- Active, non-revoked and non-banned device.
- Active, non-suspended and non-banned user.

Suspension, ban, device revocation and refresh-token compromise block API and
refresh access immediately and return stable machine-readable error codes plus
the permitted reason.

## Real-Time Policy Events

Use authenticated Server-Sent Events from
`GET /api/v1/client/policy/events`.

- Events have monotonic IDs.
- Reconnect resumes from the last acknowledged event.
- Main applies events; Renderer receives only sanitized state changes.
- Bounded polling of `GET /api/v1/client/policy` is the fallback.
- Short access-token lifetime limits stale authorization.
- Missed events never override Backend authorization checks.

Stage 2C handles API and desktop-session revocation. VPN peer revocation remains
Stage 5 and authoritative quota revocation remains Stage 7.

## Electron Security Boundary

Electron main:

- Owns Backend requests, tokens, device keys, refresh rotation and policy SSE.
- Keeps access tokens in memory where practical.
- Encrypts private key and refresh state with `safeStorage`.
- Stores ciphertext under Electron `userData` with restrictive permissions.

Preload:

- Exposes named typed methods for register, login, restore, logout, logout-all,
  profile, devices and policy subscription.
- Validates request and response shapes.
- Exposes no generic IPC send or invoke capability.

Renderer may receive:

- Sanitized profile.
- Phone-verification state.
- Account and device status.
- Session expiry.
- Safe device summaries.
- Ban, suspension or revocation reason.
- Stable error codes.

Renderer password boundary:

- Renderer may temporarily hold the plaintext password while the user enters
  and submits it.
- Pass it only through the narrow typed authentication IPC request to Main.
- Never persist, log, cache, echo, or include it in telemetry or durable state.
- Main and Backend never return the password to Renderer.
- Clear password form state as soon as practical after submission.
- Password hashes never cross into Renderer.

Renderer must never receive:

- Access or refresh tokens.
- Password hashes.
- Device private key.
- Raw challenges or signatures.
- DPAPI/safeStorage encryption material.
- Unrestricted Backend responses.

## Refresh Rotation Crash Recovery

Add table `refresh_rotation_recoveries`:

- `id uuid PRIMARY KEY`
- `session_family_id uuid NOT NULL`
- `previous_session_id uuid NOT NULL`
- `replacement_session_id uuid NOT NULL`
- `recovery_id uuid NOT NULL UNIQUE`
- `recovery_secret_hash char(64) NOT NULL`
- `response_ciphertext bytea NOT NULL`
- `expires_at timestamptz NOT NULL`
- `consumed_at timestamptz`
- `created_at timestamptz NOT NULL DEFAULT now()`

The client generates a random recovery ID and high-entropy recovery secret for
each refresh attempt. Only the recovery-secret hash is stored. The recovery
secret is transmitted inside the TLS-protected refresh request and is never
logged.

Inside one database transaction Backend:

1. Locks the current session and family.
2. Verifies refresh token and signed device challenge.
3. Rotates the refresh session.
4. Encrypts the replacement response with a dedicated server-side recovery encryption key supplied outside PostgreSQL.
5. Stores its recovery ID, secret hash, replacement IDs, ciphertext and expiry.
6. Commits rotation and recovery record together.

If the response is lost, the client retries with the same recovery ID and
secret. Backend verifies the hash using constant-time comparison and returns
the same replacement response once. Recovery is bound to the same session
family, device key and request purpose.

Recovery records:

- Expire within a short configured interval.
- Are single-use after successful recovery.
- Cannot rotate a session again.
- Cannot suppress reuse detection for another recovery ID or secret.
- Are deleted by bounded cleanup after expiry/consumption.
- Store no plaintext refresh token or recovery secret.

Tests cover lost response, Electron crash, valid recovery, wrong secret, wrong
device, expiry, replay after consumption, concurrent recovery, cleanup and
normal refresh-token reuse detection.

## Electron Backend Endpoint And TLS Policy

Electron Main obtains the API base URL from packaged application configuration
with an explicit development override.

Production policy:

- HTTPS is mandatory.
- Use normal certificate-chain and hostname validation.
- Never set `rejectUnauthorized=false`.
- Never fall back to HTTP.
- Never hardcode a production raw-IP endpoint.
- Renderer cannot supply or change the Backend URL.
- Apply connection and request timeouts.
- Retry only safe/idempotent operations with bounded attempts and backoff.
- Do not automatically retry password submission or non-idempotent mutations.
- Map timeout, DNS, TLS and unreachable failures to stable
  `BACKEND_UNAVAILABLE`-family errors without leaking internals.

Development mode may explicitly allow a loopback HTTP endpoint through a
development-only configuration that cannot be enabled in packaged production.

Any new configuration variable must be documented consistently in:

- `backend/.env.example`
- `deploy/backend.env.example`
- `deploy/templates/backend.env.template`
- Compose/deployment references that consume it

No runtime secret or production credential enters Git.

## Protected Storage Fail-Closed Policy

Before storing a device private key or refresh credential, Electron Main must
require `safeStorage.isEncryptionAvailable()`.

If secure encryption is unavailable:

- Never fall back to plaintext.
- Never persist reusable credentials.
- Never expose secrets to Renderer.
- Abort secure enrollment or persistence.
- Return `SECURE_STORAGE_UNAVAILABLE`.
- Show a controlled error without sensitive details.

Tests cover unavailable encryption, encryption/decryption failure, corrupt
ciphertext, interrupted atomic writes and successful recovery.

A normal reinstall preserves device identity while protected Electron
`userData` and the device key remain available. Installer and updater must not
delete a valid protected device identity.

## Unverified Phone Policy

Normalize accepted phone input to canonical E.164 before storage.

Until Stage 3 verification:

- Phone is an unverified contact claim.
- It is not trusted for login or recovery.
- Phone login is disabled.
- Responses report `phone_verified=false`.
- No OTP or verification success is simulated.

An unverified claim does not permanently reserve a phone number. Store it as an
expiring pending claim, or apply uniqueness only to verified numbers.

After successful Stage 3 OTP, promotion and verified-number uniqueness occur
atomically. Registration and recovery errors remain enumeration-safe.

## JWT Binding

Access-token signing and verification require:

- Algorithm `HS256`.
- Configured issuer.
- Configured audience.
- Existing strong JWT secret requirements.
- Short access-token TTL.
- Required user, session, device and authorization-version claims.

Verification rejects a missing or unexpected issuer, audience or algorithm.
Issuer and audience must be documented in every affected configuration
template.

## Endpoint Abuse Controls

Apply explicit rate limits to:

- Device-challenge creation.
- Device-proof submission.
- Refresh-challenge creation.
- Refresh rotation and recovery.
- SSE reconnect.
- Policy polling fallback.

Use per-IP and, when authenticated, per-account, per-session and per-device
limits.

Challenge endpoints must:

- Return enumeration-safe errors where practical.
- Require authentication or a short-lived flow credential.
- Reject use of a session, device or challenge identifier by itself.
- Prevent cross-account challenge consumption or invalidation.
- Scope failed attempts to the authenticated flow.
- Avoid revealing account or device existence.
- Apply bounded reconnect/polling backoff.

Tests cover rate boundaries, guessed identifiers, cross-account attempts,
proof-attempt exhaustion, separate principals and cooldown recovery.

## Failure And Recovery Cases

Handle explicitly:

- Expired, consumed, replayed or invalid challenges.
- Invalid device signatures and public-key mismatch.
- Concurrent enrollment and device-limit races.
- Network loss before and after refresh rotation commit.
- Refresh-token reuse and session-family compromise.
- Electron crash during protected-state replacement.
- DPAPI/safeStorage unavailable or undecryptable state.
- Corrupt local files and interrupted atomic writes.
- Client/server clock skew.
- SSE disconnect, event gap and fallback polling.
- User suspension or ban during an active session.
- Device revocation during an active session.
- Database failure and complete transaction rollback.

Protected local writes use temporary files, restrictive permissions, fsync where
supported, and atomic replacement.

## Backward Compatibility

- Preserve current users, devices, sessions and audit history.
- Do not fabricate public keys for existing devices.
- Existing valid sessions receive a bounded one-time secure enrollment path.
- After the compatibility window, proof is mandatory.
- Existing email verification and password-reset endpoints remain explicit
  unavailable responses until a real provider exists.
- Existing diagnostics, ETW process traffic, Network Doctor, split settings and
  updater behavior remain unchanged by Stage 2C.
- API errors remain stable and machine-readable.

## Automated Test Plan

Backend integration tests:

- Registration and enrollment success.
- Duplicate email, phone, device UID and key fingerprint.
- Known-device and new-device login.
- Wrong password and enumeration-safe errors.
- Challenge expiry, replay, wrong purpose and wrong binding.
- Invalid signature and attempt exhaustion.
- Device-limit enforcement under concurrent requests.
- Suspended, banned and revoked-device rejection.
- Refresh rotation, concurrent refresh and reuse-family revocation.
- Logout and logout-all.
- Session restoration.
- SSE authorization, event ordering, resume and polling fallback.
- Renderer-facing response redaction.

Electron tests:

- Key creation and stable reload.
- Protected store atomic replacement.
- No tokens or private keys cross preload.
- Restore state transitions.
- Locked-screen policy mapping.
- Corrupt-store recovery.

## Isolated Migration Tests

Use disposable PostgreSQL instances for:

1. Fresh application of `001_initial.sql` then migration `002`.
2. Upgrade from a populated Stage 2B database.
3. Existing users, devices, sessions and audit-log preservation.
4. New constraints and unique indexes.
5. Concurrent device-allocation transactions.
6. Challenge consumption and policy-event indexes.
7. Application startup and health after migration.
8. Database-backup restoration as the migration rollback procedure.

No production database is used for migration development tests.

## Packaged Windows Runtime Tests

Build the real NSIS package and verify on an isolated Windows machine:

- Clean install and first registration.
- Real Backend login.
- DPAPI persistence across application restart and Windows sign-out.
- Session restoration and refresh rotation.
- Renderer inspection confirms no token or private-key exposure.
- Offline startup and later recovery.
- SSE disconnect and polling fallback.
- Logout and logout-all.
- Suspended, banned and revoked-device screens.
- Reinstallation creates a new enrollment subject to device limits.
- Existing diagnostics and HoaxTraffic ETW behavior still work.
- Uninstall does not claim to revoke a server session unless logout succeeded.

Compilation or UI screenshots alone do not satisfy runtime verification.

## Production Deployment Order

1. Confirm clean reviewed commit and take a verified PostgreSQL backup.
2. Apply migration `002`.
3. Deploy the backward-compatible Backend.
4. Verify health, existing-session compatibility and audit writes.
5. Release the Stage 2C desktop package to a controlled test cohort.
6. Verify enrollment, login, refresh, restoration and policy events.
7. Expand rollout gradually.
8. End the legacy enrollment window only after adoption evidence.
9. Keep Stage 2C status separate as implemented, automated-test verified,
   packaged-runtime verified and production verified.

## Rollback Plan

- Stop rollout and restore the previous desktop package.
- Restore the previous Backend artifact if its schema compatibility is intact.
- Keep additive migration columns and tables when harmless.
- Revoke sessions created by a defective release when required.
- Restore the verified pre-migration database backup only if migration integrity
  fails and after preserving forensic/audit evidence.
- Never silently discard newer production authentication records.

## Fake Behavior Removed

Remove in Stage 2C:

- `demo` identity and `demo123` password.
- Demo Gamer identity.
- UI Test Mode login notice.
- Renderer-local `loggedIn` authorization.
- Fake registration success.
- Fake password-recovery success.
- UI-only logout.
- UI-only saved-settings success where it claims Backend persistence.
- Local plan selection where it claims entitlement.
- Any authentication success not backed by Backend session state.

Do not remove real diagnostics, game detection, ETW process traffic, Network
Doctor, split-tunnel settings or updater functionality.

## Acceptance Gate

The Stage report must list:

- Fake behavior removed.
- Real replacement.
- Automated verification.
- Packaged runtime verification.
- Remaining unverified behavior.

Stage 2C stays BLOCKED until this document is reviewed and explicitly approved.
No product code or migration is created by this planning document.
