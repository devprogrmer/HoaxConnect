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

---

## Approved Product Requirements Amendment

This amendment is authoritative where older roadmap wording conflicts with the
approved HoaxConnect product definition. HoaxConnect is the complete VPN client
and control platform, not a raw VPN configuration distribution panel.

## Stage 2C: Real Authentication and Device Identity

Stage 2C must deliver real Backend authentication for the existing Electron
desktop client:

- Real registration and login with email, phone number, and password.
- Backend user profile and account-policy state.
- Rotating refresh sessions, logout, and logout-all.
- Ban, suspension, expiry, and revoked-device screens with the Admin reason.
- Removal of `demo`, `demo123`, Demo Gamer, UI Test Mode, and fake entitlement.
- Tokens, refresh sessions, and device private keys must never reach the
  renderer.

### Device Proof of Possession

Each installation generates an asymmetric device keypair.

- Electron main generates and uses the private key.
- Windows stores it using DPAPI-backed protected storage.
- The Backend stores only the public key and device metadata.
- Enrollment uses a short-lived, single-use Backend challenge.
- The device signs the challenge and the Backend verifies the signature.
- Subsequent login and refresh operations require fresh signed challenges.
- Challenges expire and cannot be replayed.
- Key rotation revokes sessions and authorization bound to the old key.
- Reinstallation is treated as a new device and cannot bypass device limits.
- Lost-device recovery revokes the previous device identity.
- Revoked or banned devices cannot silently re-enroll.
- Stage 3 adds OTP approval for new-device enrollment and recovery.

### Device and Session Limits

Device limit and concurrent-session limit are separate controls.

- Device limits apply account-wide across Windows and Android.
- A two-device plan may contain one Windows PC and one Android phone.
- A third device is rejected by default.
- Rejection records device metadata, an audit event, a security event, and an
  Admin alert.
- Existing accepted devices are not automatically banned.
- Admin may later allow the device, revoke one device, revoke all devices, or
  permanently ban selected devices.

### Electron Security Boundary

- Renderer displays UI and receives only sanitized account/policy data.
- Preload exposes narrow typed authentication methods.
- Preload exposes no generic IPC escape hatch.
- Electron main performs Backend requests and owns tokens and device keys.
- Access tokens remain in memory where practical.
- Refresh material is stored using protected operating-system storage.
- Context isolation remains enabled.
- Unexpected navigation, window creation, and unsafe external URLs are denied.

### Real-Time Policy Revocation

Stage 2C establishes an authenticated SSE or WebSocket policy channel with
bounded polling fallback.

- Account ban, suspension, logout-all, session revocation, and device
  revocation invalidate Backend authorization immediately.
- Short-lived access tokens limit stale authorization.
- Clients clear authorization and show the correct locked state and reason.
- The Backend remains authoritative if a client misses an event.
- Stage 5 extends revocation to active VPN peers.
- Stage 7 extends it to subscription and authoritative traffic enforcement.
- A banned client may launch locally but cannot authenticate or establish VPN.
## Stage 2D: Admin API and Security Foundation

### Admin Authentication

- No default or publicly generated Admin password.
- Create the first superadmin through a local one-time bootstrap operation.
- Disable bootstrap after the first superadmin exists.
- Use secure `HttpOnly`, `Secure`, restricted `SameSite` cookies and CSRF
  protection for the browser Admin Panel.
- Support Admin session expiry, rotation, individual revocation, and
  account-wide revocation.
- Record successful and failed Admin login history.
- Apply login rate limits, backoff, and security alerts.
- Prepare MFA architecture for privileged roles; Stage 3 activates it.

### RBAC Matrix

`superadmin`:

- Full users, devices, sessions, plans, subscriptions, traffic, nodes,
  providers, audit, retention, and security access.
- Manage Admin accounts and roles.
- Configure and rotate provider credentials.
- Sensitive reads and all mutations are audited.

`admin`:

- Manage users, plans, subscriptions, traffic, devices, sessions, nodes, bans,
  and suspensions.
- Review payment and SMS operational status.
- Cannot reveal saved provider secrets.
- Cannot manage superadmin identities.
- Cannot bypass consent or retention rules.

`support`:

- View user, subscription, device, session, and non-sensitive diagnostics.
- Perform explicitly permitted recovery, disconnect, and revocation actions.
- Cannot edit prices, plans, nodes, providers, Admin roles, or retention.

`read_only`:

- Read non-sensitive operational information.
- Cannot mutate product state.
- Cannot access secrets or sensitive consent-gated telemetry.

Backend permission checks are authoritative; hidden UI controls are not an
authorization mechanism.

### Admin User Detail

The API must expose:

- Account state, email, phone, and phone-verification status.
- Plan, subscription dates, quota, authoritative usage, and remaining traffic.
- Devices, platform metadata, sessions, VPN sessions, and violation history.
- Ban, suspension, revocation, and security-event history.
- Consent state and only telemetry permitted by that consent.
- Payments and complete Admin audit history.

Authorized actions include:

- Add traffic, extend subscription, and change plan.
- Allow or reject a pending device.
- Revoke or ban one or all devices.
- Disconnect a session or VPN session.
- Revoke all sessions.
- Suspend, unsuspend, ban, and unban an account.
- Require a reason for bans and destructive security actions.

### Provider Secret Storage

- Encrypt SMS and payment credentials at rest.
- Keep the master encryption key outside PostgreSQL.
- Never return saved credentials unmasked.
- Expose only masked metadata, enabled state, and test status.
- Audit creation, replacement, rotation, testing, and deletion.

### Telemetry Governance

- Diagnostics remain opt-in.
- Consent records include version, time, client, and enabled categories.
- Admin APIs omit fields outside current consent.
- Allowed data may include HoaxConnect session identity, device metadata,
  client version, VPN node/session, RX/TX, ping, jitter, loss, detected game,
  network-active process names, and best-effort hostname metadata.
- Never collect passwords, messages, HTTPS content, keystrokes, cookies,
  full browsing history, third-party tokens, contacts, or TLS-intercepted data.
- Define retention periods per category.
- Support consent withdrawal and deletion.
- Audit access to sensitive telemetry.

## Stage 2E: React Admin Control Center

Build the real React and TypeScript Admin Panel against Stage 2D APIs.

Required views:

- Dashboard for users, sessions, traffic, nodes, subscriptions, violations,
  bans, payments, and alerts.
- Users with search, filters, full detail, devices, sessions, actions, and
  audit trail.
- Plans with duration, quota, device limit, concurrent-session limit, integer
  IRR price, TOMAN display, and enabled state.
- VPN Nodes with location, endpoint, status, capacity, load, peers, and traffic.
- Payments with provider, reference, amount, state, verification, and history.
- SMS with SMS.ir configuration, templates, test status, and delivery logs.
- Security/Audit with Admin logins, actions, bans, revocations, and sensitive
  telemetry access.

Remove static totals, sample users, fake transactions, fake nodes, and UI-only
mutation success.

## Stage 3: SMS.ir OTP and Admin MFA

SMS.ir configuration must support:

- API key and required credentials.
- Sender/originator.
- Template or pattern identifiers by OTP purpose.
- Enable/disable state.
- Explicit test SMS and delivery status.
- Masked reads and audited credential rotation.

OTP controls:

- Canonical phone normalization.
- Short expiry and one-time consumption.
- Replay prevention.
- Maximum verification attempts.
- Per-account, phone, IP, and device rate limits.
- Resend cooldown and rolling delivery limits.
- Brute-force backoff and security events.
- Invalidate older codes when a replacement is issued.
- Never log plaintext OTP values.

Use OTP for registration, phone verification, first/new-device enrollment,
recovery, and sensitive security operations.

Add TOTP or WebAuthn-ready MFA for privileged Admin accounts, recovery codes,
audited reset, and mandatory MFA policy for superadmin.

Remove fixed OTP values, fake verification toggles, and fake SMS success.

## Stage 4: Plans, Subscriptions, Quotas, and Payments

- Store money as integer IRR and convert explicitly for TOMAN display.
- Plans define duration, traffic quota, device limit, concurrent-session limit,
  enabled state, and renewal rules.
- Remove hardcoded client plans, local `activePlan`, and renderer-controlled
  entitlement.

Payment adapters:

- Zarinpal.
- Zibal.
- Behpardakht Mellat.
- SEP.
- Future providers through the same interface.

Payment security:

- Backend creates the payment intent and unique order/attempt identifiers.
- Bind callbacks to user, order, provider, amount, and currency.
- Never trust client-side payment success.
- Verify payment server-to-server before granting entitlement.
- Make verification idempotent.
- Reject amount, merchant, order, and reference mismatches.
- Prevent callback replay and duplicate subscription credit.
- Track pending, verified, failed, cancelled, expired, and refunded states.
- Reconcile interrupted callbacks and uncertain provider responses.
- Keep immutable payment and audit history.
- Apply entitlement only through the verified Backend transaction.

Remove fake checkout, local payment success, and hardcoded provider responses.
## Stage 5: VPN Control Plane and VPN Node Agent

HoaxConnect remains the complete VPN client.

Users select a simple location and press CONNECT. They never receive raw
WireGuard configuration, QR codes, private keys, manual peer controls, or a
requirement to install the WireGuard desktop application.

### VPN Authorization

Before authorizing a VPN session, Backend verifies:

- Authenticated account and registered device.
- Device proof of possession.
- Active subscription.
- Remaining authoritative traffic.
- Account and device ban/suspension state.
- Device and concurrent-session limits.
- Requested location and node availability.

Every accepted device receives an independent server-authorized peer.
Shared static WireGuard credentials are forbidden.

### VPN Node Agent Security

- Node enrollment uses a one-time bootstrap credential.
- Each node receives a unique cryptographic identity.
- Node communication uses mutual TLS or an equivalently strong authenticated
  channel.
- Node credentials are individually rotatable and revocable.
- Commands include request identity, timestamp, expiry, and replay protection.
- Agent accepts commands only from the authorized control plane.
- WireGuard operations run with least privilege.
- Node private keys never appear in Admin APIs or logs.

### VPN Node Operations

- Register node version, location, endpoint, capacity, load, and health.
- Provision and revoke per-device peers.
- Disconnect active VPN sessions.
- Report authoritative peer RX/TX counters.
- Reconcile desired peers after Backend or Agent restart.
- Make provisioning and revocation idempotent.
- Immediately revoke peers after bans, revocations, expiry, or quota action.
- Audit commands, results, retries, and failures.

Remove hardcoded servers, fake locations, generated latency/load, fake connect
results, and manually distributed WireGuard configurations.

## Stage 6: Windows Privileged Service

Build `HoaxConnectService.exe` with C# and .NET.

Responsibilities:

- Authenticated secure IPC with Electron.
- WireGuardNT or embedded platform-supported WireGuard control.
- Privileged route, DNS, firewall, and tunnel lifecycle operations.
- Connect, disconnect, reconnect, failure cleanup, and policy disconnect.
- Receive only Backend-authorized tunnel material.
- Return sanitized status and errors to Electron.

Security requirements:

- Restrict IPC to the intended local user and service.
- Authenticate message origin and validate every command.
- Never expose reusable raw VPN configuration to renderer or user.
- Protect transient tunnel material and remove it after use.
- Restore routes, DNS, and firewall state after interrupted operations.
- Verify Electron and service version compatibility.

Remove simulated connection delays, renderer-only connected state, fake tunnel
statistics, and dependency on external WireGuard UI.

## Stage 7: Authoritative Traffic Accounting

VPN node peer counters are the source of truth.

### Accounting Protocol

1. Node Agent reads per-peer RX/TX counters.
2. Agent reports node, peer, VPN session, counter epoch, sequence/checkpoint,
   timestamp, RX, and TX.
3. Backend authenticates the node and validates report ordering.
4. Backend applies only new positive deltas.
5. Checkpoint and subscription usage update in one transaction.
6. Backend acknowledges the accepted checkpoint.
7. Agent retries unacknowledged reports without double counting.

Correctness requirements:

- Survive Agent and Backend restarts.
- Handle WireGuard counter reset and peer recreation with a new epoch.
- Reject stale and out-of-order reports.
- Deduplicate repeated reports.
- Prevent negative deltas.
- Preserve monotonic subscription usage.
- Handle delayed reports and temporary network partitions.
- Reconcile active peers after recovery.
- Retain checkpoint history for audit and diagnosis.

### Automatic Enforcement

When authoritative usage reaches quota:

- Mark entitlement exhausted transactionally.
- Reject reconnect and new VPN authorization.
- Revoke active peers through the Node Agent.
- Notify/disconnect clients through the policy channel.
- Display `TRAFFIC LIMIT REACHED`.
- Re-enable only after authorized renewal or traffic addition.

Apply equivalent revocation for subscription expiry, account suspension,
account ban, device revocation, and device ban.

Client counters are UX-only and never grant entitlement.

Remove generated traffic, renderer-owned remaining quota, and Admin traffic
values lacking node-counter evidence.

## Stage 8: Android Client

Build the Android client using Kotlin, Jetpack Compose, and Android VpnService.

- Use the same Backend account, subscription, device, ban, and quota policy.
- Generate a device keypair stored in Android Keystore.
- Use the same challenge-based device proof architecture.
- Keep VPN connection fully inside HoaxConnect.
- Do not expose raw WireGuard configuration or manual import.
- Respect account-wide cross-platform device limits.
- Support real-time policy revocation and locked states.

## Stage 9: WFP Split Tunneling and Advanced Diagnostics

- Add Windows Filtering Platform controls through the privileged service.
- Implement per-application routing with explicit user controls.
- Preserve full-tunnel safety when split-tunnel policy fails.
- Add Network Doctor diagnostics with clear privacy consent.
- Keep domain visibility best-effort without TLS interception.
- Never collect prohibited content or credentials.
- Remove fake process, game, latency, loss, and diagnostic results.

## Stage 10: Production Hardening and Release

### Backup and Recovery

- Encrypted PostgreSQL backups and retention policy.
- Isolated restore drills.
- Defined recovery-point and recovery-time objectives.
- Provider-settings and audit-history recovery verification.
- Node and peer reconciliation after Backend recovery.

### Key and Secret Rotation

- Backend master encryption-key rotation.
- SMS and payment credential rotation.
- Admin session-signing key rotation.
- Node mTLS identity rotation and revocation.
- Device-key recovery and replacement.
- WireGuard node-key rotation with controlled peer migration.

### Observability

- Structured logs without credentials, OTPs, tokens, or tunnel secrets.
- Metrics for authentication, OTP, payments, device limits, nodes, peers,
  traffic ingestion, revocation, and client failures.
- Shared request and operation identifiers.
- Alerts for accounting stalls, node loss, provider failures, payment
  uncertainty, unusual Admin actions, and backup failures.

### Abuse and Incident Controls

- API, Admin, OTP, enrollment, payment, and node rate limits.
- Credential-stuffing and brute-force detection.
- Replay and duplicate-command detection.
- Device-enrollment abuse alerts.
- Payment anomaly detection.
- Incident procedures for account, node, provider, payment, accounting, and
  sensitive-data compromise.
- Rapid node credential and account-session revocation.
- Controlled preservation of audit evidence.

### Release Safety

- Signed Windows application and service artifacts.
- Reproducible versioned builds.
- Signed update metadata and rollback-safe updates.
- Compatibility checks among Electron, Windows Service, Backend, and Node Agent.
- Staged rollout and rollback policy.
- Disposable-host end-to-end verification before production.
- Android signing and release controls when Stage 8 is active.

### Privacy Operations

- Automatically enforce telemetry retention.
- Support consent withdrawal, account deletion, and authorized export.
- Audit sensitive-data access.
- Verify prohibited data is never collected or logged.

## Implementation Gate

Before every stage:

1. Inspect the current repository read-only.
2. Identify real, fake, incomplete, and unavailable behavior.
3. Present the exact implementation plan.
4. Provide complete copy/paste patches and migration commands.
5. Provide build, test, and verification commands.
6. Wait for real test output before continuing.

UI, schema, mocks, source inspection, local tests, deployment, and real
end-to-end operation remain separate verification states.

Stage 2C must not begin until this revised roadmap is explicitly approved.

---

## Final Requirements Before Stage 2C

These requirements supplement the approved roadmap and are authoritative where
earlier wording is incomplete.

### Admin-Managed Payment Providers

Payment providers must be configured through the Admin Panel. Production
configuration must not require SSH access or manual environment-file editing.

Superadmin can configure:

- Zarinpal.
- Zibal.
- Behpardakht Mellat.
- SEP.

Each provider supports:

- Enabled or disabled state.
- Merchant identifier.
- API, terminal, or provider credentials where required.
- Callback configuration.
- Default-provider selection.
- Explicit `TEST CONFIGURATION` action.
- Masked credential display.
- Credential rotation with audit history.

Provider secrets remain encrypted using the external server master key. After
saving, neither Admin APIs nor Admin UI may reveal the original secret again.

### Real Gaming Route Measurement

Windows and Android clients measure real route quality from the user device to
available HoaxConnect nodes where technically possible:

- Latency.
- Jitter.
- Packet loss.
- Reachability.

Backend and Node Agent separately provide:

- Node health.
- Load.
- Capacity.
- Maintenance state.
- Draining state.

`AUTO SELECT BEST ROUTE` combines real client measurements with authoritative
Backend node availability and load.

UI and APIs must distinguish:

- `CLIENT MEASUREMENT`
- `SERVER/NODE HEALTH METADATA`

Do not generate deterministic, random, or fabricated latency, jitter, packet
loss, reachability, health, capacity, or load values.

### VPN Address Management

Stage 5 includes transaction-safe VPN IP address management.

For each peer:

- Allocate a unique tunnel address.
- Prevent duplicate allocation under concurrent requests.
- Persist the allocation.
- Release or reclaim it according to an explicit lifecycle policy.
- Preserve allocations across Backend and Node Agent restart.
- Reconcile persisted allocation against actual WireGuard peers.
- Audit allocation, release, reclaim, and conflict resolution.

Allocation must use database uniqueness constraints plus transactional locking
or an equivalent atomic design. Reconciliation must never silently assign one
address to multiple active peers.

### Node Heartbeats and Maintenance

Each Node Agent sends authenticated heartbeat and lease information.

Backend states:

- `online`
- `degraded`
- `offline`
- `maintenance`
- `draining`

Draining behavior:

- Reject new VPN sessions on the node.
- Allow existing sessions to continue according to Admin policy.
- Allow Admin to observe remaining sessions.
- Allow safe node evacuation before maintenance.

Heartbeat policy defines:

- Expected interval.
- Lease expiry.
- Degraded threshold.
- Offline threshold.
- Recovery transition.
- Alert generation.
- VPN authorization behavior when node state becomes stale.

### Bounded Quota Overshoot

Stage 7 uses practical accounting cadence rather than long periodic reporting
alone.

Node Agent performs:

- A regular time-based checkpoint.
- A checkpoint after a significant transferred-byte delta.
- A final flush on normal disconnect.
- Retry of unacknowledged reports.
- Durable checkpoint identity for deduplication.

Backend performs:

- Stale-accounting detection.
- Alerting and policy response for delayed node reports.
- Transactional usage and checkpoint updates.
- Bounded quota-overshoot policy.
- Fail-safe handling when authoritative accounting is unavailable.

The selected reporting interval and byte threshold must establish an explicit
maximum expected overshoot bound. The product must not claim exact quota
enforcement while its reporting design permits unbounded additional traffic.
### Transaction-Safe Concurrency Limits

Device enrollment and concurrent VPN-session authorization must be atomic.

For a limit of two, simultaneous extra-device or session requests must not both
succeed.

Use transactional row locking, advisory locking, serializable transactions, or
an equivalent atomic mechanism around:

- Accepted-device count.
- Active VPN-session leases.
- Plan limits.
- New device or session creation.
- Audit and violation creation.

VPN sessions use renewable leases. Define:

- Lease duration and heartbeat cadence.
- Cleanup after client, service, node, or Backend crash.
- Idempotent disconnect.
- Expired lease reclamation.
- Reconciliation with actual Node Agent peers.
- Protection against counting one session twice.

### Windows Standard-User UI

After `HoaxConnectService.exe` is installed, normal Electron operation must not
require permanent Administrator privileges.

Target architecture:

```text
Standard-user HoaxConnect.exe
        |
authenticated restricted IPC
        |
elevated HoaxConnectService.exe
The service owns WireGuard, routes, DNS, firewall, and privileged monitoring.
Service installation, repair, or update may require elevation. Normal login,
account management, location selection, connection, and diagnostics must run
as a standard user.
Stage 6 must migrate away from
requestedExecutionLevel=requireAdministrator and verify standard-user UI
operation plus privileged-service isolation.
### Consolidate Privileged Helpers

Do not retain competing privileged networking engines.

The existing HoaxTraffic ETW helper provides real process-traffic data and must
remain functional during migration.

When Windows Service supports ETW and network monitoring, either move that
functionality into the service or define a deliberate single-owner boundary.

Migration must:

- Preserve real ETW process-traffic behavior.
- Compare old and new runtime output.
- Avoid duplicate collection and conflicting operations.
- Remove the old helper only after packaged runtime verification.
- Never replace working telemetry with mocks.

### Email Account Policy

HoaxConnect selects policy A:

- Phone OTP is the primary required verification method.
- Phone OTP is the primary account and password recovery method.
- Email remains a supported account and contact identifier.
- Email verification is optional until a real provider stage is approved.
- No feature may require verified email without a delivery provider.
- Email verification and email password-reset schema must not pretend to be
  active behavior.
- Fake email delivery and fabricated verification success are forbidden.

Mandatory email verification later requires a real provider, delivery tracking,
expiry, replay protection, rate limits, masked credentials, and end-to-end
verification.
### Production Updater and Supply Chain

Stage 10 must replace development HTTP updating before production.

Requirements:

- HTTPS-only production auto-updater.
- Full TLS certificate and hostname validation.
- Signed update artifacts and metadata.
- Windows Authenticode verification.
- Reject invalid, unsigned, expired, or mismatched updates.
- Atomic installation and rollback-safe replacement.
- Differential-update tests across actual released versions.
- Full-update fallback and interrupted-update tests.
- Rollback tests.
- Dependency vulnerability scanning.
- Lockfile and dependency security review.
- SBOM and release manifest where practical.
- Artifact provenance, digest, version, and compatibility records.

The existing HTTP updater is development-only and cannot be the final
production updater.

### Acceptance Evidence for Every Future Stage

Every Stage completion report must list:

1. Fake behavior removed.
2. Real replacement implemented.
3. Automated verification completed.
4. Packaged or runtime verification completed.
5. Remaining unverified behavior.

A Stage is not `VERIFIED` from documentation, schema existence, compilation,
static checks, UI screenshots, mocks, or source inspection alone.

Use separate states:

- Documented.
- Implemented.
- Automated-test verified.
- Packaged-runtime verified.
- End-to-end verified.
- Production verified.

Stage 2C remains blocked until its detailed implementation plan is explicitly
approved.
