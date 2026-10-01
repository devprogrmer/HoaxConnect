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

Stage 2F client presence and opt-in device reporting.
Stage 2D API deployment and migration 004 are confirmed by the user's server
output. The latest local verification/deployment boundaries are recorded in
the Stage 2F checkpoint below; earlier checkpoints are historical evidence.

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

Status: complete for the desktop authentication slice. The Stage 2C Backend was
deployed in the earlier checkpoint; deployment claims below distinguish direct
verification from later user-reported behavior.

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
- The desktop preserves one device key per installation. Backend device-key
  uniqueness is now scoped to an account, allowing separate accounts to enroll
  from the same installation after migration 003 is deployed.

Verification performed:

- `npm run test:electron`: 28 passed, 0 failed.
- `npm run build`: passed.
- `npm --prefix backend run build`: passed.
- `npm run lint`: 0 errors; 16 existing warnings remain.
- `npm --prefix backend test` without a database: 11 passed, 0 failed, 14
  database-dependent tests skipped.
- Account-scoped device-key migration contract test passes. The real two-account
  registration regression is database-dependent and skipped because no isolated
  PostgreSQL instance is available in this checkout.
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
- After the earlier checkpoint, the user reported successful new-account
  registration, sign-out, and sign-in again from the same desktop installation.
  The production migration ledger for migration 003 was not independently
  queried in this checkout; preserve this as user-reported runtime evidence.
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

- Re-run the same-device multi-account registration regression against isolated
  PostgreSQL and query the production migration ledger before treating migration
  003 as independently verified.
- Complete and exercise suspended, banned, revoked-device, and email-verification
  account/device policy flows.
- Review recovery behavior if the one-time recovery response itself is lost;
  keep Backend refresh-token reuse detection unchanged.
- Implement real VPN control plane and node agent, followed by the Windows
  privileged tunnel service, according to the product roadmap.

Next starting point:

- Stage 2D/2E Admin API and console have been implemented locally; run the
  database-backed acceptance suite against isolated PostgreSQL before real
  Admin testing or deployment.
- Stage 2E SMS template, send-test, and delivery-log workflows are not present;
  provider credentials are encrypted and displayed as inactive only. Keep actual
  SMS delivery and Admin MFA in Stage 3.
- VPN node agent, verified live traffic counters, and real tunnel connection are
  not implemented. Keep CONNECT explicitly marked as simulated.

AUTHENTICATION SLICE EXIT CHECK

1. Desktop auth source tests/build pass and the packaged Windows flow was
   manually verified.
2. Production Stage 2C migrations 001 and 002 were applied and API health was
   verified in the earlier deployment; the user later reported successful
   multi-account signup, while migration 003's production ledger remains
   independently unverified in this checkout.
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

STAGE 2D/2E HISTORICAL LOCAL CHECKPOINT (SUPERSEDED BELOW)

Implemented locally:

- Separate React Admin console with API-backed overview, users and account
  detail, sessions, plans, subscriptions, node inventory, payments, audit and
  access, integrations, Admin accounts, alerts, and traffic usage.
- Backend Admin accounts/sessions, cookie and CSRF protection, HTTPS/origin
  checks, login lockout/history, role enforcement, reasoned audit mutations,
  encrypted provider-secret storage, and a one-time superadmin bootstrap.
- Traffic reads are restricted to `admin`/`superadmin`, paginated, limited to a
  90-day range, and audited. User-detail, Admin-login-history, and Admin-account
  reads are audited as sensitive access.
- VPN nodes cannot be represented as online without an authenticated agent;
  traffic is labeled as accounting records, not verified live tunnel telemetry.

Verification performed in this checkout:

- `npm run build`: passed.
- `npm run build:admin`: passed.
- `npm --prefix backend run build`: passed.
- `npm run lint`: 0 errors; 16 warnings remain in pre-existing desktop files.
- Targeted Oxlint over Admin and Stage 2D files: passed with no findings.
- `npm run test:electron`: 28 passed, 0 failed.
- `npm --prefix backend test`: 17 passed, 0 failed, 22 skipped because no
  isolated PostgreSQL URL/service is available; skipped coverage includes all
  database-backed Admin acceptance tests.
- The first isolated-PostgreSQL run on `68c0b13` executed all 39 Backend tests:
  29 passed and 10 failed. The failures exposed a string-valued traffic count,
  shared client IPs exhausting the test login rate limit, and a missing test-only
  refresh recovery key. After the fixes on `8f077e0`, the isolated database
  rerun passed all 39 tests with no failures or skips.
- On a fresh isolated database, migrations 001 through 004 applied. The
  interactive superadmin bootstrap then exposed a PostgreSQL parameter-type
  error in its audit insert. This branch fixes that insert and adds a
  database-backed bootstrap regression test; its isolated rerun is pending.
- `git diff --check`: passed.

Not done in this checkout:

- Stage 2D migration 004 was applied only to disposable test databases, not
  to Production.
- No production database, API deployment, Nginx static hosting, or server files
  were changed.
- Admin UI was not browser-verified here. Local PostgreSQL, Docker/Podman, and
  WSL distro are unavailable in this environment.
- The Admin build artifact is not deployed at `https://hoaxnet.ir/admin`.
- SMS delivery/templates/logs, Admin MFA enrollment, VPN node agent, and real
  VPN connectivity remain unimplemented or unverified.

Next gate: run the bootstrap regression test with `HC_STAGE2D_TEST_DATABASE_URL`
pointing only to an isolated loopback PostgreSQL database whose name includes
`test`. Then verify the Admin UI against that Backend. Do not apply migration
004 to Production until after review, explicit approval, and a verified
database backup.

STAGE 2F CLIENT REPORTING CHECKPOINT - 2026-10-01

Completed in branch `codex/stage-2f-client-presence`:

- Account ID, installation ID, signing-key fingerprint and client-reported
  SHA-256 hardware ID are separate fields. Hardware IDs are not attestation
  and are not used to bypass device proof or enforce account ownership.
- Electron sends authenticated presence every 30 seconds. The Admin account
  detail distinguishes online, graceful close, inactive session, missing
  reports, and no recent contact after 90 seconds. It polls every 20 seconds.
- Hardware/model/CPU/RAM, network diagnostics, and visible-window application
  names are separate opt-ins, off by default. Window titles, file paths,
  command lines, raw firmware IDs and browsing history are not sent.
- Reports are session/device-bound on the server, limited in size/rate, and
  contain a server-observed IP, never a client-supplied IP. Only exact
  `TRUSTED_PROXY_IPS` can supply forwarded client addresses.
- Optional values are removed on the next successful withdrawal report.
  Only the latest report is stored. Reports older than 24 hours are hidden;
  an hourly/startup sweep removes expired rows (physical retention up to 25h).
- Sensitive report values require `telemetry.read` (admin/superadmin). Reads
  remain audited. Banned devices cannot authenticate for client APIs.
- The auth owner serializes rotation/login/logout/reporting and refreshes an
  expired access token once. Reports collected for another account are dropped.
- Network availability and Backend request time are measured, not a speed test,
  packet-loss/jitter measurement, VPN health claim, or proof of global Internet
  reachability. Missing heartbeats cannot distinguish a crash from lost access.

Verification in this checkout:

- Electron tests: 33 passed, 0 failed.
- Full Backend suite against isolated local PostgreSQL 16.14: 52 passed,
  0 failed, 0 skipped. Migrations 001 through 005 applied. The disposable
  database was bound to loopback; no production data was used.
- Regression coverage includes spoofed IP/IDs, consent withdrawal, role
  redaction, expiry/purge, banned devices, refresh rotation and account changes.
- `npm run build`, `npm run build:admin`, Backend build: passed.
- Lint: 0 errors, 16 pre-existing desktop warnings; no new report-code warnings.
- `npm run test:device-ui`: passed using real Electron/Windows collectors,
  a disposable local account and real isolated Backend. Verified Settings
  switches, hashed hardware/model/CPU/RAM, application names, report visibility,
  withdrawal and graceful-close state. Admin screenshots checked at 1440px and
  390px; no page overflow or browser runtime errors.
- `npm run dist:win`: built the new 0.3.10 installer (not auto-published).
  Packaged reporter/IPC code and traffic-helper source/package hashes checked.
  Installer SHA-256: `93F2A3DEAA777B6EA29318E47E1E2888E6A63AB95511B779B89B80CB3FA4E042`.
- `scripts/deploy-device-reports.sh`: Bash syntax checked, not run on production
  in this turn. Preserves credentials/volume, creates a checked dump, builds
  before API replacement, verifies migration/health/static assets, and restores
  the old image/config on failure without destructive database rollback.

Production evidence supplied by the user before this change:

- Migration ledger contained 001, 002 and 003; migration 004 then applied.
- Image `hoaxconnect-api:stage2d-6b30924` passed the nonroot runtime file check
  and became healthy. A fresh dump exists under
  `/root/hoaxconnect-stage2d-20260930-151912-1293261/retry-IzgQU8.dump`.
- The one-time production superadmin was created successfully. Do not rerun
  bootstrap, rotate existing encryption keys, or overwrite the dirty original
  checkout at `/opt/HoaxConnect`.
- The first Admin static publish got a 404 and rolled back; a retry was supplied
  but no definitive production static-byte check was received in this thread.

Not yet verified / next starting point:

- Migration 005, the updated Admin assets and new client are NOT deployed to
  production by this local work. Run the opt-in deployment script from a clean
  release clone, retain its backup and Compose override path, then verify normal
  external HTTPS and real device reports at `https://hoaxnet.ir/admin/`.
- The new installer was built and its content inspected; installation/upgrading
  the user's existing app and packaged production end-to-end reporting remain
  unverified. Source Electron runtime is not an installer upgrade test.
- Old clients have no report sender and must show "No app reports", not offline
  or invented hardware values. Existing proxy IP history cannot be recovered.
- See `docs/product/client-device-reporting.md` for consent, validation,
  deployment and rollback boundaries.
- Real VPN connectivity, node-agent traffic, MFA enrollment and SMS delivery
  remain outside this slice and must not be described as implemented.
