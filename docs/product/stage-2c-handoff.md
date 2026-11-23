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
- `npm run dist:win`: rebuilt the 0.3.10 installer with an HTTPS update feed
  for subsequent releases. Packaged reporter/IPC code and traffic-helper
  source/package hashes checked. Installer SHA-256:
  `86F9DD927593B5B0BEB02012C508647852CA44C21FA4B69BC7BF71BE87747436`.
- At the initial build checkpoint, the legacy HTTP port 8090 still advertised
  0.3.9. The release archive was kept out of Git; later publication and the
  installed-client result are recorded below.
- `npm run test:update-artifacts`: 4 passed; the release artifact verifier also
  passed on the actual installer. The publication script passed Bash syntax
  checking and was later run on the production update host.
- Neither version has an Authenticode signature. The old HTTP metadata path
  cannot be made tamper-proof from a 0.3.10 code change; this is a one-time
  bootstrap risk. The new build uses HTTPS, but signed artifacts and signed
  metadata remain release-readiness work.
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

Later production and updater evidence (2026-10-01):

- The Stage 2F production deployment was reported successful after this local
  checkpoint. External API health and Admin page both returned 200 on HTTPS.
- The Windows publication script reported `WINDOWS_UPDATE_PUBLISHED` for
  0.3.10. The public HTTPS manifest advertised 0.3.10, and a full external
  installer download matched its SHA-512 and 141660692-byte manifest size.
- The installed 0.3.9 client downloaded 0.3.10 to 100% and relaunched after
  **Restart & Update**. The installed executable reported file version 0.3.10,
  and a HoaxConnect process was running after relaunch.

Stage 2G account-moderation checkpoint (2026-11-22):

- Admin account detail now makes Unsuspend and Unban explicit and displays the
  current suspension/ban message. Ban and suspension reasons are identified as
  messages shown to the affected user; restore reasons remain audit-only.
- Banned and suspended accounts receive the bounded Backend policy message on
  login, refresh restoration, and the next running-client device report. The
  desktop returns to the sign-in screen when that live policy event arrives.
- Unban and unsuspend now bind only the SQL parameters their statements use.
  The isolated integration test caught the previous extra-parameter failure.
- Targeted Admin integration suite against disposable PostgreSQL 18: 8 passed,
  0 failed. Full Backend suite: 53 passed, 0 failed, 0 skipped; migrations 001
  through 005 were applied only to the disposable database.
- Desktop build, Admin build, and Backend build passed. Electron tests: 35
  passed, 0 failed. Lint completed with 0 errors and the 16 previously recorded
  desktop warnings.
- The disposable database and test containers used loopback/dynamic ports and
  were removed after each run. The unrelated workload on the test VPS was not
  changed. No production deployment, migration, push, or release was performed
  at this checkpoint.

Stage 5 VPN control-plane persistence checkpoint (2026-11-22):

- Migration 006 adds node enrollment tokens, enrolled Ed25519 credential
  metadata, signed-request replay nonces, node tunnel settings, and renewable
  per-device VPN-session leases. It does not expose or store node/client private
  keys and does not delete or rewrite existing VPN/accounting rows.
- Partial unique indexes enforce one live VPN session per device, one live
  address per node, and one live session per peer. Database checks constrain
  key fingerprints, WireGuard public keys, IPv4 leases, ports, CIDRs, nonce
  values, lease expiry, and terminal-session timestamps.
- The schema integration test was observed RED before migration 006 and GREEN
  after it. Full Backend suite against disposable PostgreSQL 18: 54 passed,
  0 failed, 0 skipped; migrations 001 through 006 applied.

Stage 5 VPN node-agent authentication checkpoint (2026-11-22):

- Migration 007 adds bounded agent version/load telemetry and last-agent address
  metadata without changing migration 006.
- The one-time bootstrap command stores only a SHA-256 enrollment-token hash.
  Enrollment accepts a canonical Ed25519 SPKI public key, returns only public
  credential metadata, and permanently consumes the token.
- Agent heartbeat requests use an Ed25519 signature over a versioned canonical
  request, a bounded timestamp, and a transactionally consumed nonce. Replays,
  wrong-node credentials, invalid signatures, expired requests, and revoked
  credentials are rejected.
- The agent-auth integration test was observed RED at the missing enrollment
  route and GREEN after implementation. The targeted test passed 1/1; the full
  Backend suite against disposable PostgreSQL 18 passed 55/55 with migrations
  001 through 007 applied. Backend TypeScript build and `git diff --check`
  passed. No production deployment or migration was performed.
- The test database used a loopback dynamic port and was removed after the run.
  The other project and its healthy containers on the VPS were not changed.
  Migration 006 has not been applied to any production database.

Stage 5 per-device VPN authorization checkpoint (2026-11-22):

- Migration 008 replaces permanent peer IP/key uniqueness with partial unique
  indexes for pending and active peers, so disconnected addresses can be safely
  reused without weakening live-session uniqueness.
- Authenticated clients can request a five-minute renewable lease. The Backend
  checks account/device state, subscription dates and quota, concurrency, node
  heartbeat freshness/capacity, and allocates a node address transactionally.
  Concurrent reconnects for the same device/key return the same lease.
- The Backend returns only public tunnel material; client private keys remain
  outside the Backend. Signed node desired-state reads expose active peers and
  bounded recent revocations for reconciliation.
- Disconnect, logout, logout-all, account suspension/ban, and device
  revocation/ban revoke live VPN sessions and peer desired state in the same
  database transaction.
- The authorization suite was observed RED at the missing routes and GREEN
  after implementation: 7/7 targeted scenarios passed. The full Backend suite
  against disposable PostgreSQL 18 passed 62/62 with migrations 001 through
  008 applied. Backend TypeScript build and `git diff --check` passed. No
  production deployment or migration was performed.

Stage 5 Linux VPN node-agent checkpoint (2026-11-22):

- The containerized TypeScript agent enrolls once with an Ed25519 identity and
  stores private identity state with mode 0600. Every control request receives
  a fresh nonce/signature and bounded exponential retry.
- The reconciler converges desired peers idempotently, persists only
  HoaxConnect-managed peer ownership, recovers after restart, retries partial
  applies, and never removes unmanaged peers or interfaces.
- The Linux adapter invokes only fixed `wg`, `ip`, and `nft` binaries with
  argument arrays. It owns the `hcx0` interface and `inet hoaxconnect` nftables
  table and rejects unsafe names/addresses before command execution.
- Agent tests passed 7/7 on Windows and 7/7 inside a disposable Linux
  container, including the Linux 0600 assertion. TypeScript build passed. The
  image built successfully and passed a read-only, zero-capability dry-run.
  Its fixed launcher starts with only the capabilities needed to change UID,
  then runs as UID/GID 1000 with only `NET_ADMIN`. NAT and Docker forwarding
  rules are restricted to the configured tunnel CIDR and interfaces.
- The image build and dry-run did not start WireGuard, change nftables, migrate
  a database, deploy production, or modify the unrelated server workload.

Stage 5 isolated Linux tunnel checkpoint (2026-11-23):

- The E2E preflight was observed RED because host `wg` was absent. Only
  `wireguard-tools` was installed; a disposable WireGuard interface proved
  current-kernel support. Nginx and the unrelated Compose project were not
  changed.
- A disposable PostgreSQL 18 database, current Backend, node agent, account,
  subscription, device, and Linux network-namespace client exercised the real
  authorization and desired-state paths. No production database was used.
- The client received `10.99.0.2`, completed a real WireGuard handshake, reached
  the node tunnel address, completed a UDP DNS exchange, and made an HTTPS
  request through the tunnel. The independently observed public egress address
  was `194.26.64.241`.
- Backend disconnect removed the peer from desired state and the running agent;
  traffic from the revoked client then failed. This proves live revocation, not
  merely a database status change.
- The complete E2E passed twice. Each run removed its database/API/agent
  containers, namespace, interfaces, secrets, dedicated nftables table, and
  tagged forwarding rules. The four unrelated `hoaxnet-*` containers remained
  running/healthy and the Nginx configuration hash stayed unchanged.
- Agent tests passed 9/9 on Windows after the non-root capability,
  lease-expiry, and scoped-forwarding fixes. The full Backend suite passed 63/63 against
  disposable PostgreSQL 18 with migrations 001 through 008. Backend build and
  Agent build passed. The test did not deploy a persistent node or publish a
  desktop release.

Stage 5 final recovery and expiry checkpoint (2026-11-23):

- Expired VPN sessions no longer consume subscription concurrency, node
  capacity, device uniqueness, or tunnel addresses. Renewal of an existing
  healthy session remains valid when its node is at reported capacity.
- Authorization locks the active account row before device and subscription
  work, so moderation and VPN authorization serialize on the same account.
- The node agent persists lease deadlines, rejects already-expired desired
  peers, and removes expired managed peers even while the Backend is
  unavailable. It initializes its WireGuard interface before local fail-closed
  expiry checks on a fresh host.
- NAT and forwarding rule ownership includes the tunnel CIDR. Reconciliation
  removes only stale exact HoaxConnect-owned markers and preserves foreign or
  prefix-similar rules in shared Docker chains.
- The full Backend suite passed 63/63 on disposable PostgreSQL 18. Electron
  tests passed 35/35, Agent tests passed 9/9, UI/Admin/Backend/Agent builds
  passed, and the real WireGuard UDP/HTTPS/revoke E2E passed again with public
  egress `194.26.64.241`.
- `docs/product/vpn-node-deployment.md` now records host package installation,
  persistent IPv4 forwarding, exact rollback ownership, and total-node-loss
  recovery. It intentionally excludes all production secrets and private keys.

Still unverified / next starting point:

- Confirm an authenticated, consented report from the packaged 0.3.10 client
  is visible in the production Admin panel. API health and the Admin page alone
  do not prove that reporting workflow.
- Old clients have no report sender and must show "No app reports", not offline
  or invented hardware values. Existing proxy IP history cannot be recovered.
- See `docs/product/client-device-reporting.md` for consent, validation,
  deployment and rollback boundaries.
- Package and manually verify the Stage 2G policy message in the Windows app,
  then deploy through the normal backed-up production path.
- Linux node connectivity and revocation are proven only in the isolated VPS
  E2E. A persistent production node has not been deployed.
- The Windows desktop tunnel remains simulated until Stage 6 implements and
  packages the privileged service, protected client keys, route/DNS/firewall
  rollback, and Windows E2E. MFA enrollment and SMS delivery also remain
  outside this slice.
