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

ELECTRON PROTECTED AUTH FOUNDATION

Status: implemented and locally verified, but not wired into the running
Electron authentication flow yet.

Completed:

- Added fail-closed protected authentication storage using Electron safeStorage.
- Added protected credential replacement and clearing, with controlled errors
  for unavailable encryption, encryption/decryption failures, and corrupt data.
- Added a Renderer-safe authentication state allowlist that excludes tokens,
  passwords, and device private keys.
- Added the `test:electron` package script.

Verification:

- `npm run test:electron`: 8 passed, 0 failed.
- `npm run build`: passed.
- `npm run lint`: 0 errors and 16 existing warnings.
- Packaged Windows runtime testing has not been performed.

Deployment and migration:

- No production deployment was performed.
- The Stage 2C migration remains unapplied to production.
- Production Backend and database were not changed.

Remaining work:

- The protected store is not yet connected to Electron Main, preload, Renderer
  login, Backend API requests, device-key generation, session restoration, or
  refresh rotation.
- Do not describe desktop authentication as operational until those flows and
  the packaged Windows runtime are verified.

Next starting point:

- Add the Electron Main authentication owner and Backend API endpoint policy.
- Generate and preserve device identity in Main and connect it to real
  Electron safeStorage.
- Expose only narrow typed authentication commands and sanitized state through
  preload.
- Preserve the existing scanner, split-tunnel, diagnostics, traffic,
  network-doctor, and updater IPC behavior.

EXPECTED NEXT IMPLEMENTATION ORDER

1. Read-only Electron repository inspection.
2. Report exact files and current fake/real boundaries.
3. Add RED tests for protected storage and IPC boundaries.
4. Implement secure device identity in Electron Main.
5. Implement typed preload IPC.
6. Implement real register/login flow.
7. Implement device-challenge signing.
8. Implement secure session persistence/restoration.
9. Implement refresh challenge/rotation/crash recovery.
10. Implement logout and logout-all.
11. Implement banned, suspended and revoked-device states.
12. Remove demo/demo123 and UI Test Mode.
13. Run source tests.
14. Run packaged Windows runtime tests.
15. Do not deploy until separately approved.

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

START NOW WITH READ-ONLY ELECTRON INSPECTION ONLY.
DO NOT MODIFY FILES YET.
