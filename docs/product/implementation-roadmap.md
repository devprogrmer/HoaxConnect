# HoaxConnect Product Implementation Roadmap

## Authority And Status Rules

This roadmap follows `hoaxconnect-product-definition.md` and supersedes the
future-stage naming in historical portable-deployment documents.

Status values:

- VERIFIED: implemented, tested, delivered, and runtime-verified where required
- IN PROGRESS: approved work has started but acceptance is incomplete
- PLANNED: defined but implementation has not started
- BLOCKED: progress requires an external dependency or decision
- FROZEN: intentionally deferred

A stage is not VERIFIED from UI, schema, mocks, compilation, or a socket probe
alone. Evidence must include tests appropriate to the behavior.

## Current Snapshot

Repository branch: `main`

Baseline commit before product-first work:

`39e53d1db7897e547cfca91483e870ce442659c2`

Current production Backend health and PostgreSQL readiness were verified after
that commit. Runtime secrets, databases, backups, SSH keys, and TLS private
keys are intentionally not stored in Git.

## Delivered Foundation

### Stage 2B-B: Portable Backend Operations

Status: VERIFIED

Delivered capabilities:

- transactional source installation
- preserved secret configuration
- loopback-only API publication
- PostgreSQL persistent volume
- Nginx and Let's Encrypt TLS
- health-gated update and rollback
- verified backup and transactional restore
- status and safe uninstall commands
- disposable-host end-to-end workflow

Delivery commits:

- `905925b` transactional Nginx and TLS setup
- `ddc62a2` idempotent source installer
- `e05fb87` verified backup and restore
- `70e26f6` health-gated source updates
- `39e53d1` status, safe uninstall, and complete disposable-host E2E

Final E2E proved clean install, reinstall, HTTPS health, authentication
boundary, failed-update rollback, successful update, backup/restore, safe
uninstall, preserved database volume, and unchanged production state.

Additional generic deployment work is now FROZEN until Stage 10.

## Existing Product Code Reality

The Backend already contains real foundations for:

- Argon2 password hashing
- JWT access tokens
- hashed rotating refresh tokens
- refresh-token reuse detection and family revocation
- logout and logout-all
- user, device, and session records
- device revocation
- profile and device endpoints
- RBAC role schema
- plans, subscriptions, payments, nodes, peers, traffic, telemetry, and audit
  database tables

The Windows application already contains substantial Electron and React UI,
diagnostics, game detection, process traffic, split-tunnel UI, and updater
functionality.

The following are not yet real:

- Electron-to-Backend authentication
- secure desktop token persistence
- cryptographic device identity
- phone verification and OTP
- email delivery and recovery
- Admin API and Admin Panel
- payment-provider integration
- VPN Node Agent and per-device peer provisioning
- real HoaxConnect-controlled VPN tunnel
- authoritative node traffic enforcement
- Android client

The current Renderer login is UI Test Mode and accepts the demonstration
password `demo123`. This must be removed during Stage 2C.

## Stage 2C: Desktop Backend Authentication

Status: IN PROGRESS

Completed:

- read-only repository inspection
- current auth, database, Electron, preload, and Renderer boundaries identified
- implementation architecture approved
- product definition and roadmap documentation started

Implementation scope:

- real Electron login and registration
- phone-number foundation
- stable generated device identifier and Ed25519 keypair
- Windows DPAPI storage through Electron safeStorage
- access tokens held only in Electron main memory
- encrypted refresh-token and private-key persistence
- Backend device public-key registration
- refresh and session restoration
- logout and logout-all
- real Backend profile
- banned, suspended, revoked-device, and expired-session states
- removal of `demo123` and authentication UI Test Mode

Explicitly deferred:

- SMS.ir OTP delivery to Stage 3
- payment processing to Stage 4
- VPN peer provisioning to Stage 5
- real tunnel lifecycle to Stage 6
- authoritative quota enforcement to Stage 7

Acceptance evidence:

- migration tested on an isolated PostgreSQL database
- Backend auth integration tests
- refresh rotation and reuse tests
- device identity and signature tests
- Electron IPC boundary tests
- proof that Renderer receives no tokens or private keys
- packaged Windows login, restart restoration, logout, and blocked-state tests
- production migration and deployment only after backup and review

## Stage 2D: Admin API

Status: PLANNED

Scope includes users, devices, sessions, plans, subscriptions, traffic, bans,
audit, alerts, RBAC enforcement, and VPN-node management foundations.

Acceptance requires authorization tests for every role and auditable mutations.

## Stage 2E: React Admin Panel

Status: PLANNED

The Admin Panel is an operational control center, not a raw VPN configuration
panel. It consumes only the authenticated Admin API.

Acceptance requires real API-backed workflows and role-specific UI behavior.

## Stage 3: SMS And Verification

Status: PLANNED

Scope includes SMS.ir provider settings, encrypted credentials, OTP templates,
registration verification, new-device verification, sensitive-operation OTP,
delivery status, throttling, expiry, and abuse controls.

## Stage 4: Plans, Subscriptions, Quotas, And Payments

Status: PLANNED

Scope includes plan enforcement, integer IRR accounting, TOMAN display,
provider abstraction, and the first verified Iranian payment adapter.

No subscription changes occur until server-side provider verification succeeds.

## Stage 5: VPN Control Plane And Node Agent

Status: PLANNED

Scope includes location selection, VPN nodes, Node Agent authentication,
per-device WireGuard peer provisioning, automatic peer revocation, and initial
Frankfurt and Turkey node workflows.

No raw configuration is exposed to users.

## Stage 6: Windows Privileged Service

Status: PLANNED

A C# and .NET `HoaxConnectService.exe` controls WireGuardNT, routes, DNS,
firewall operations, and VPN session lifecycle through restricted IPC.

The existing Electron and React UI remains the user-facing application.

## Stage 7: Authoritative Traffic Enforcement

Status: PLANNED

VPN node peer counters feed Backend accounting. Quota, subscription, device,
and ban decisions automatically revoke or deny VPN authorization.

Client counters remain informational.

## Stage 8: Android Client

Status: PLANNED

Kotlin, Jetpack Compose, Android Keystore, and Android VpnService use the same
Backend account, device, subscription, and policy model.

## Stage 9: Advanced Windows Networking

Status: PLANNED

Scope includes WFP split tunneling and consent-aware Network Doctor impact
controls integrated with the privileged Windows service.

## Stage 10: Production Hardening And Release Automation

Status: FROZEN

Only after product behavior is real and verified may work resume on GHCR,
bootstrap installers, broader CI/CD, release automation, and additional
deployment abstractions.

## Progress Update Procedure

At the end of every stage:

1. record the final commit and delivery state
2. record automated test commands and results
3. record runtime or E2E evidence
4. list remaining unverified behavior
5. update the stage status
6. never mark a stage VERIFIED while required evidence is missing
