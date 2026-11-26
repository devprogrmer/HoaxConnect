# Windows Application Split Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a real selected-application Windows tunnel controlled by HoaxConnect Electron and backed by the Stage 5 VPN control plane.

**Architecture:** Electron remains unprivileged and coordinates Backend authorization with an ACL-restricted LocalSystem service. The service owns keys, a pinned sing-box Windows TUN/WireGuard engine, lease enforcement and recovery; platform-neutral contracts make safety behavior testable before Windows E2E.

**Tech Stack:** Electron/CommonJS, React/TypeScript, Node test runner, .NET 8 Windows Service, pinned sing-box, Windows TUN/WFP support supplied by the engine, NSIS/electron-builder.

**Spec:** `docs/superpowers/specs/2026-11-24-windows-app-split-tunnel-design.md`

## Global Constraints

- Windows 10/11 x64 only; selected application routing is the primary mode.
- No networking privilege or private key material in the renderer.
- No simulated success, synthetic route measurement or silent full-tunnel fallback.
- Selected traffic fails closed after lease expiry; unselected traffic stays on the normal connection.
- Every owned system change is idempotent and recoverable after crash or reboot.

## Review Focus

- Symlinked, relative, missing and non-EXE application paths must not become privileged rules.
- Backend success followed by local-service failure must revoke or expire the remote session and clean local state.
- Duplicate connect/disconnect and stale generation commands must be harmless.
- Lease expiry during Backend outage must block selected traffic and remove the adapter.
- Electron or service crash must not leave an accidental full-device tunnel or foreign policy.

---

### Task 1: Electron VPN API and Connection Orchestrator

**Files:**
- Create: `electron/vpn-api.cjs`
- Create: `electron/vpn-connection.cjs`
- Test: `electron/tests/vpn-api.test.cjs`
- Test: `electron/tests/vpn-connection.test.cjs`
- Modify: `electron/auth/auth-owner.cjs`

**Interfaces:**
- Consumes: authenticated Backend base URL and access-token refresh behavior from `createElectronAuthOwner`.
- Produces: `authorizeVpn(input)`, `disconnectVpn()`, and `createVpnConnection({ api, service, clock })` with `connect`, `disconnect`, `getState`.

- [ ] Write tests for authenticated authorization, token refresh, input validation, local apply failure cleanup, idempotent disconnect and lease expiry.
- [ ] Run the new tests and verify they fail because the modules and methods do not exist.
- [ ] Implement the minimal API and orchestrator contracts.
- [ ] Run new tests, then all Electron tests.
- [ ] Commit `feat: add Windows VPN connection orchestrator`.

### Task 2: Local Service Protocol and Electron IPC

**Files:**
- Create: `electron/vpn-service-client.cjs`
- Test: `electron/tests/vpn-service-client.test.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Modify: `src/electron.d.ts`

**Interfaces:**
- Consumes: Task 1 connection orchestrator.
- Produces: length-bounded versioned named-pipe messages and renderer `vpn.status/connect/disconnect` APIs.

- [ ] Write failing tests for message framing, timeout, invalid response, disconnected service and untrusted IPC sender.
- [ ] Implement the named-pipe client and guarded IPC handlers.
- [ ] Run targeted and full Electron tests.
- [ ] Commit `feat: connect Electron to the Windows tunnel service`.

### Task 3: Privileged Service Core

**Files:**
- Create: `native/HoaxConnect.Service/HoaxConnect.Service.csproj`
- Create: focused service, protocol, validation, state and recovery `.cs` files.
- Create: `native/HoaxConnect.Service.Tests/HoaxConnect.Service.Tests.csproj`
- Test: service unit tests.

**Interfaces:**
- Consumes: Task 2 protocol version and command schemas.
- Produces: LocalSystem named-pipe server implementing `status`, `identity`, `connect`, `disconnect` and `renew`.

- [ ] Write failing tests for ACL identity, path validation, generation ordering, idempotency, encrypted key persistence and startup cleanup.
- [ ] Implement the platform-neutral service core and fake tunnel platform.
- [ ] Run all .NET tests on Windows and build `win-x64` service artifacts.
- [ ] Commit `feat: add privileged Windows tunnel service`.

### Task 4: TUN/WireGuard Selected-App Enforcement

**Files:**
- Create: sing-box configuration, process supervision and integrity files under `native/HoaxConnect.Service/Platform/Windows`.
- Test: Windows integration harness under `native/HoaxConnect.Service.IntegrationTests`.

**Interfaces:**
- Consumes: Task 3 tunnel platform abstraction.
- Produces: strict TUN lifecycle and per-executable IPv4, IPv6 and DNS routing with owned-process cleanup.

- [ ] Write Windows integration tests that initially fail with the fake platform.
- [ ] Implement pinned-engine integrity checking, configuration generation and fail-closed selected-process policy.
- [ ] Prove selected and unselected processes take different egress paths and that DNS/IPv6 do not leak.
- [ ] Commit `feat: enforce selected-app routing with the Windows TUN engine`.

### Task 5: Replace Simulated UI Connection

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/SplitTunnel.tsx`
- Modify: relevant CSS and UI tests.

**Interfaces:**
- Consumes: Task 2 renderer VPN API.
- Produces: honest Auto/manual connect flow, state, errors, lease and selected-app presentation.

- [ ] Write failing UI tests proving Connect cannot succeed without selected apps or service confirmation.
- [ ] Remove sleeps, `makeResult` route decisions and simulated connected state from production flow.
- [ ] Implement Auto/manual location request and live status rendering.
- [ ] Run UI build, lint and Electron tests.
- [ ] Commit `feat: wire the desktop UI to real split tunneling`.

### Task 6: Installer, Recovery and Windows E2E

**Files:**
- Modify: `package.json` and NSIS resources.
- Create: service install/uninstall scripts and Windows E2E scripts.
- Modify: deployment and handoff documentation.

**Interfaces:**
- Consumes: Tasks 3-5 Windows artifacts.
- Produces: signed-install-ready package with service rollback and repeatable Windows acceptance test.

- [ ] Write installer verification tests for bundled service/driver, service ACL and uninstall cleanup.
- [ ] Package and install in a clean Windows VM.
- [ ] Run selected-vs-unselected egress, disconnect, crash, reboot and update acceptance tests.
- [ ] Run all repository suites and perform a final whole-branch review.
- [ ] Commit `test: prove Windows application split tunneling end to end`.

