# HoaxConnect Product Definition

## Authority

This document defines the current HoaxConnect product. Historical deployment
documents remain useful records, but their old stage names do not define the
current product roadmap. In particular, further GHCR, bootstrap installer,
backup-framework, and generic deployment work is frozen until Stage 10.

## Product

HoaxConnect is a controlled VPN platform consisting of:

- HoaxConnect Windows and Android clients
- Backend account, subscription, device, payment, and policy services
- React and TypeScript Admin Panel
- VPN control plane and VPN Node Agents
- Per-device WireGuard authorization
- Server-authoritative traffic accounting

It is not a raw VPN configuration marketplace or a generic WireGuard panel.

## User Experience

Users sign in, choose a location such as Frankfurt, Turkey, or Netherlands,
and press CONNECT. All VPN behavior remains inside HoaxConnect.

Users never interact with an external WireGuard application and never receive:

- WireGuard configuration files
- QR codes
- private keys
- manual peer-management controls

WireGuard is an internal tunnel implementation detail.

## VPN Authorization

Every registered device has a distinct identity and VPN peer or credential.
Static shared WireGuard private configurations are prohibited.

The Backend checks account, device, subscription, quota, session, and ban
state before authorizing VPN access. VPN Node Agents create, update, and revoke
per-device peers automatically.

Expiry, quota exhaustion, device revocation, suspension, and bans must not
require manual WireGuard cleanup by an administrator.

## Traffic Authority

VPN node peer RX and TX counters are authoritative. Client-side counters are
informational only and never grant entitlement.

Traffic flows through:

VPN peer -> VPN Node Agent -> Backend accounting -> subscription usage ->
policy decision.

At quota exhaustion, existing authorization is revoked according to policy,
reconnection fails, and the client displays TRAFFIC LIMIT REACHED.

## Accounts And Devices

Accounts support email, phone number, password, verification, sessions,
recovery, suspension, and permanent bans.

A device uses an application-generated identifier and keypair. Private device
keys use protected OS storage: Windows DPAPI and Android Keystore.

Stored device metadata is limited to operationally useful fields:

- device identifier and public key
- device name
- OS and OS version
- architecture and client version
- first seen and last seen
- revoked or banned state and reason

Raw hardware serial numbers are not the sole identity mechanism.

Device-limit violations create an audit event and Admin alert. They do not
automatically ban all existing devices.

## Client Enforcement

A banned account or device cannot authenticate, refresh a session, or receive
VPN authorization. All affected sessions and VPN peers are revoked.

The application may physically launch while blocked, but displays a dedicated
banned or suspended screen containing the administrator-provided reason.

## Authentication And SMS

OTP is used for registration, first or new-device login, sensitive operations,
and recovery where appropriate.

SMS providers use an extensible adapter interface. SMS.ir is the first required
provider. Superadmins configure and test it through the Admin Panel.

Provider secrets are encrypted at rest with a server-side master key stored
outside PostgreSQL. Saved credentials are never returned unmasked.

## Payments

Money is stored as integer IRR. The UI may display configurable TOMAN values.

Payment providers use an adapter interface supporting Zarinpal, Zibal,
Behpardakht Mellat, SEP, and future providers.

The Backend independently verifies payment before creating or extending a
subscription or adding traffic. Client-reported payment success is never
trusted. Transactions and verification attempts are retained for audit.

## Admin Control Center

RBAC roles are superadmin, admin, support, and read_only.

The Admin Panel manages users, devices, sessions, plans, subscriptions,
traffic, bans, audit events, VPN nodes, payments, SMS settings, and alerts.

Administrators may add traffic, extend subscriptions, change plans, revoke
devices or sessions, suspend or ban accounts, and inspect the audit trail.

The Admin Panel is not a raw VPN-config distribution interface.

## Privacy And Telemetry

Diagnostics require explicit consent. Permitted fields include HoaxConnect
session identifiers, device metadata, client version, VPN session and node,
RX/TX, ping, jitter, loss, detected games, network-active process names, and
best-effort remote hostname metadata.

HoaxConnect does not collect passwords, messages, HTTPS content, keystrokes,
full browsing history, cookies, third-party tokens, or contacts. It performs
no TLS interception.

Telemetry has retention controls, consent versioning, and audited access.

## Technology

- Backend: Node.js, TypeScript, Fastify, PostgreSQL
- Admin Panel: React and TypeScript
- Windows UI: existing Electron, React, and TypeScript
- Windows privileged service: C# and .NET
- Android: Kotlin, Jetpack Compose, Android VpnService
- VPN: WireGuardNT and platform-supported WireGuard components

Rust is not part of the current plan.

## Windows Boundary

The existing Electron UI is preserved.

HoaxConnect.exe communicates through authenticated, restricted IPC with
HoaxConnectService.exe. The service owns WireGuard lifecycle, WFP, DNS,
ETW/network monitoring, routes, firewall operations, and VPN session control.

Tokens and device private keys are never exposed to the Renderer.

## Definition Of Complete

A feature is complete only when its real Backend behavior, client integration,
security boundary, migrations, automated tests, and relevant runtime or E2E
verification have passed.

UI-only, schema-only, mocked, or socket-only behavior must not be reported as
complete.
