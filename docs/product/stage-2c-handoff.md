Continue HoaxConnect Stage 2C from the public repository:

https://github.com/devprogrmer/HoaxConnect

Repository:

- Branch: main
- Required implementation baseline:
  `d7514fc67c390c87fdf069accb55e782427f941e`
- The current HEAD may be newer because documentation-only commits can follow.
- Verify the baseline before continuing:
  `git merge-base --is-ancestor d7514fc67c390c87fdf069accb55e782427f941e HEAD`
- Latest completed product-code slice:
  `feat: secure refresh token rotation`

PRODUCT MODEL

HoaxConnect is a controlled VPN platform and complete VPN client.
It is not a WireGuard configuration-selling panel.

Users only choose a location and press CONNECT.
Raw WireGuard configs, QR codes and manual peer management must never be
exposed to users.

CURRENT STAGE

Stage 2C:
Desktop Backend Authentication + Real Device Identity.

COMPLETED AND PUSHED

1. Authentication foundation
   Commit:
   a87f45910ef180fa08fe6f1cbe5339de8ad680f1

   Includes:
   - PostgreSQL Stage 2C schema
   - JWT issuer/audience binding
   - device challenge foundation
   - per-device public-key proof
   - configuration templates
   - isolated migration verification

2. Device-proof authentication flow
   Commit:
   eb5511db2394ecbc23d964b42aa9413bd753f0b0

   Includes:
   - real registration/login Backend flow
   - no tokens before device proof
   - Ed25519 device proof
   - one-time challenges
   - atomic device-limit enforcement
   - invalid/replay proof rejection
   - password-change concurrency protection
   - isolated auth-flow integration tests

3. Secure refresh-token rotation
   Commit:
   d7514fc67c390c87fdf069accb55e782427f941e

   Includes:
   - POST /api/v1/auth/refresh/challenge
   - session-bound device proof for refresh
   - atomic refresh rotation
   - refresh-token reuse detection
   - encrypted crash-recovery response
   - recovery secret hashing
   - one-time recovery consumption
   - expiry and concurrency protection
   - AES-256-GCM response encryption with AAD binding
   - request-log secret redaction
   - installer-generated recovery encryption key
   - installer reinstall secret preservation

VERIFIED

- Backend TypeScript build passed.
- Standard Backend test suite passed.
- Fresh migrations 001 + 002 passed in isolated PostgreSQL.
- Device authentication integration tests passed in isolated PostgreSQL.
- Six refresh integration tests passed:
  - invalid refresh-token challenge
  - valid session-bound challenge
  - signed atomic rotation
  - wrong recovery-secret handling
  - expired recovery handling
  - concurrent recovery handling
- Installer configuration tests passed.
- Installer dry-run tests passed.
- Installer transaction tests passed.
- Local and origin/main matched after push.

PRODUCTION STATE

- Production Backend remained healthy.
- Production PostgreSQL volume remained unchanged:
  hoaxconnect_pgdata
- Stage 2C migration has NOT been applied to Production.
- New Backend code has NOT been deployed to Production.
- Do not deploy or apply the migration without explicit approval.

NEXT SLICE

Stage 2C Electron Secure Authentication.

Before modifying anything, perform read-only repository inspection of:

- package.json and package scripts
- Electron Main entry files
- preload files
- contextBridge API
- IPC handlers
- React authentication screens
- frontend stores/services
- packaging configuration
- existing tests
- every occurrence of:
  demo
  demo123
  Test Mode
  login
  register
  token
  refresh
  logout
  safeStorage
  ipcMain
  ipcRenderer
  contextBridge

The inspection must identify:

- Current Main/preload/Renderer boundaries.
- Existing fake/demo authentication behavior.
- Existing persistence mechanisms.
- Existing API URL configuration.
- Existing packaged Windows behavior.
- Real functionality that must be preserved.

EXPECTED ELECTRON ARCHITECTURE

Electron Renderer:
- May temporarily contain the password while entered/submitted.
- Must never persist or log the password.
- Must clear password state promptly.
- Must never receive refresh tokens.
- Must never receive device private keys.
- Must never choose an arbitrary Backend URL.
- May receive sanitized account/device/policy/auth-state DTOs.

Electron Main:
- Owns Backend communication.
- Owns access and refresh credentials.
- Owns device key generation and challenge signing.
- Owns refresh rotation and crash recovery.
- Exposes narrow typed IPC only.
- Uses bounded timeouts/retries and stable error mapping.

Protected persistence:
- Require safeStorage.isEncryptionAvailable().
- Fail closed if encryption is unavailable.
- Never fall back to plaintext.
- Preserve a valid device key across normal application reinstall.
- Store state atomically under Electron userData.
- Detect corrupt or undecryptable protected state safely.

Backend endpoint policy:
- Production HTTPS only.
- Normal certificate and hostname validation.
- No rejectUnauthorized=false.
- No HTTP fallback.
- No production raw-IP endpoint.
- Development local endpoint must be explicitly separate.

ELECTRON AUTHENTICATION STATUS

Status: complete for the desktop authentication slice. The code and this
checkpoint are being committed together; the Stage 2C Backend is deployed and
the production migration is applied.

Completed:

- Protected storage uses Electron safeStorage and fails closed when encryption
  is unavailable.
- Main owns Backend calls, device identity, proof signing, access token memory,
  protected refresh persistence, and refresh recovery.
- Preload exposes guarded auth IPC for state, login, registration, session
  restoration, local logout, and logout-all.
- Renderer login and registration call the auth bridge; password state is
  cleared immediately after submission and secrets are not returned by Main.
- Startup attempts to restore a saved session. Before refresh rotation, Main
  persists the exact retry payload, including recovery credentials, in
  protected storage.
- A simulated lost rotation response is retried with the same payload after
  restoration; successful rotation replaces the saved refresh token and clears
  pending recovery state.
- Local logout and logout-all revoke through the Backend when possible, clear
  local session credentials, and retain the protected device identity. An
  unconfirmed remote revocation is reported to the user.
- Unverified phone claims remain untrusted; Backend uniqueness applies only to
  verified phone numbers, and phone login is not enabled.
- Duplicate registration for an existing email or username is rejected; the
  desktop reports that the user should sign in instead.

Verification performed:

- `npm run test:electron`: 28 passed, 0 failed.
- `npm run build`: passed.
- `npm --prefix backend run build`: passed.
- `npm run lint`: 0 errors; 15 existing warnings remain.
- `npm --prefix backend test` without a database: 10 passed, 0 failed, 13
  database-dependent tests skipped.
- Refresh restore test simulates a lost response and verifies the exact protected
  request is retried.
- Electron Auth Owner real-Backend integration test passed against isolated
  PostgreSQL over loopback HTTP; registration, device proof, and refresh rotation
  were exercised.
- Packaged Windows app was manually verified against production: sign-in,
  session restoration after app restart, and logout/re-login succeeded.

Deployment and migration:

- Production API was rebuilt from this repository's Stage 2C source and restarted
  with the existing Docker Compose deployment.
- `002_stage2c_auth_devices.sql` was applied to production; `001_initial.sql` was
  already applied.
- `https://hoaxnet.ir/api/v1/health/ready` returned ready after deployment.
- A verified PostgreSQL backup was created on the production host before
  migration.
- Production-only JWT issuer, audience, and refresh-recovery key were configured
  in `deploy/backend.env`; secret values are not stored in Git.

Important connection boundary:

- VPN connection is not implemented. `src/App.tsx` currently changes the
  renderer state to `connected` after a simulated delay. No VPN provisioning
  endpoint, node agent, or privileged Windows tunnel service is wired to it.
- The app must not be described as connected to a real VPN until a real tunnel
  is established and independently verified.

Remaining work:

- Complete and exercise suspended, banned, revoked-device, and email-verification
  account/device policy flows.
- Review recovery behavior if the one-time recovery response itself is lost;
  keep Backend refresh-token reuse detection unchanged.
- Implement real VPN control plane and node agent, followed by the Windows
  privileged tunnel service, according to the product roadmap.

Next starting point:

- Authentication and production Stage 2C migration are verified; do not rerun
  the production migration as routine work.
- The user-visible priority is a real VPN connection. Start by designing the
  Stage 5 Backend control plane and node agent, then Stage 6 Windows service.
- Stage 3 SMS verification and Stage 4 plans/payments remain planned in the
  roadmap; reconcile milestone sequencing before expanding scope.
- Keep CONNECT explicitly marked as simulated until real tunnel verification.

AUTHENTICATION SLICE EXIT CHECK

1. Desktop auth source tests/build pass and the packaged Windows flow was
   manually verified.
2. Production Stage 2C migration is applied and API health is ready.
3. Real VPN tunnel is explicitly not implemented; see the boundary above.

WORKING RULES

HANDOFF MAINTENANCE

- Every product-code commit must update this Handoff in the same commit.
- Do not use a later documentation-only commit to record product progress.
- Each update must record the completed slice, exact verification performed,
  deployment and migration state, remaining risks, and the next starting point.
- Do not describe unverified behavior as completed.
- Keep the required implementation baseline unchanged unless the architecture
  baseline itself is intentionally replaced.
- Before committing, verify that the staged files include this Handoff whenever
  product code, migrations, configuration, Electron, or tests have changed.


- Inspect actual files before patching.
- Do not assume old file contents.
- Preserve existing real features.
- Do not silently introduce mocks.
- Do not weaken tests.
- Do not expose tokens or private keys to Renderer.
- Treat source tests, isolated integration tests, packaged Windows tests,
  deployment and Production verification as separate states.
- Provide complete copy/paste commands in manageable pieces.
- Wait for real command output before continuing.
- Never apply migrations to Production without explicit approval.

CURRENT CHECKPOINT: Stage 2C desktop authentication is committed with this
Handoff update; production migration and packaged login/session/logout flows
are verified. Real VPN connectivity remains unimplemented.
