# VPN Control Plane and Node Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real HoaxConnect VPN path: Backend authorization, an authenticated Linux node agent, per-device WireGuard peers, revocation, and a Linux network-namespace end-to-end proof on the isolated VPS.

**Architecture:** The Backend remains the authority for accounts, subscriptions, devices, nodes, leases, and peer state. A Linux node agent owns WireGuard and NAT, authenticates every control-plane request with its enrolled Ed25519 identity over HTTPS, and reconciles desired peers idempotently. The client generates its WireGuard private key locally and sends only the public key; raw reusable configurations never enter Renderer or Admin APIs.

**Tech Stack:** Node.js 22+, TypeScript, Fastify, PostgreSQL, Linux WireGuard, nftables, Docker Compose for isolated deployment tests.

**Spec:** `docs/product/implementation-roadmap.md` (Stage 5: VPN Control Plane and VPN Node Agent)

## Global Constraints

- Preserve the existing Electron/React desktop application and Backend authentication model.
- Never expose client private keys, node private keys, reusable raw WireGuard configurations, or bootstrap secrets through Renderer, Admin responses, or logs.
- Every accepted device gets an independent peer; shared static client credentials are forbidden.
- Node commands and reports require an enrolled identity, timestamp, expiry, nonce, body digest, and replay protection.
- VPN authorization must verify account/device policy, active subscription, remaining traffic, node freshness/capacity, and concurrent-session limits in one transaction.
- Provisioning and revocation must be idempotent and survive Backend/agent restarts.
- The test VPS at `194.26.64.241` also hosts an unrelated workload. Do not modify its Nginx configuration, ports 80/443, existing Docker Compose project, volumes, or credentials.
- HoaxConnect test services use unique names, loopback dynamic TCP ports, UDP 51820 only after a free-port check, and explicit CPU/memory limits.
- Update `docs/product/stage-2c-handoff.md` in every product-code commit.
- Stage 6 Windows service and Stage 9 WFP split tunneling are separate plans; do not claim Windows VPN completion in this stage.

## Review Focus

- A stolen, expired, replayed, or future-dated node request must be rejected without revealing enrollment material.
- Concurrent authorization for the same device must produce at most one active lease and one unique tunnel address.
- A ban, suspension, device revocation, expired subscription, or exhausted quota must prevent authorization and revoke desired peer state.
- Agent restart or duplicate reconcile output must not duplicate peers, NAT rules, addresses, or accounting state.
- Node staleness, full capacity, or partial WireGuard failure must fail closed and leave the host's pre-existing networking intact.

---

### Task 1: Persist Node Identities, Peer Leases, and Replay State

**Files:**
- Create: `backend/migrations/006_vpn_control_plane.sql`
- Create: `backend/tests/vpn-control-schema.integration.test.ts`
- Modify: `docs/product/stage-2c-handoff.md`

**Interfaces:**
- Produces: `vpn_node_credentials`, `vpn_node_request_nonces`, and `vpn_sessions`; node tunnel CIDR/listen-port fields; one-active-session and address uniqueness constraints.
- Consumes: existing `vpn_nodes`, `vpn_peers`, `users`, `devices`, `subscriptions`, and `sessions` tables.

- [ ] Write a database integration test that applies migrations 001-006 and asserts the new constraints reject duplicate active device leases, duplicate node addresses, duplicate nonces, and malformed public-key fingerprints.
- [ ] Run `HC_STAGE5_TEST_DATABASE_URL=... node --import tsx --test tests/vpn-control-schema.integration.test.ts` and verify RED because migration 006 is absent.
- [ ] Add migration 006 with reversible-safe additive schema only; do not rewrite existing peer/accounting history.
- [ ] Run the targeted test and verify PASS.
- [ ] Run the full Backend suite against disposable PostgreSQL and verify all tests pass with zero skips.
- [ ] Update the Handoff and commit `feat: add VPN control-plane persistence`.

### Task 2: Enroll and Authenticate VPN Node Agents

**Files:**
- Create: `backend/src/vpn-agent-auth.ts`
- Create: `backend/src/vpn-agent-routes.ts`
- Create: `backend/src/vpn-node-bootstrap.ts`
- Create: `backend/tests/vpn-agent-auth.integration.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/package.json`
- Modify: `docs/product/stage-2c-handoff.md`

**Interfaces:**
- Produces: `POST /api/v1/vpn-agent/enroll`, `POST /api/v1/vpn-agent/heartbeat`, and `authenticateVpnAgent(request)` returning `{ nodeId, credentialId }`.
- Consumes: Task 1 credential/nonce tables and an Ed25519 signature over `version + method + path + timestamp + nonce + SHA-256(body)`.

- [ ] Write failing tests for one-time enrollment, hashed bootstrap-token storage, valid signed heartbeat, bad signature, stale/future timestamp, nonce replay, disabled credential, wrong node, and sanitized logs/errors.
- [ ] Run the targeted test and verify RED because routes/authenticator do not exist.
- [ ] Implement the bootstrap CLI, enrollment transaction, canonical request framing, Ed25519 verification, five-minute clock window, and nonce insertion-before-action.
- [ ] Implement heartbeat updates for version, endpoint, server public key, capacity, load, and `last_seen_at`; never accept `online` from an unauthenticated source.
- [ ] Run targeted and full Backend suites and verify PASS.
- [ ] Update the Handoff and commit `feat: authenticate VPN node agents`.

### Task 3: Authorize and Revoke Per-Device VPN Sessions

**Files:**
- Create: `backend/src/vpn-control.ts`
- Create: `backend/src/vpn-routes.ts`
- Create: `backend/tests/vpn-authorization.integration.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/admin.ts`
- Modify: `backend/src/auth.ts`
- Modify: `docs/product/stage-2c-handoff.md`

**Interfaces:**
- Produces: `POST /api/v1/vpn/authorize`, `POST /api/v1/vpn/disconnect`, and authenticated agent desired-state/revocation reads.
- Authorization response to Main only: `{ vpn_session_id, node: { id, endpoint, public_key }, client: { assigned_ip, dns_servers }, lease_expires_at }`.
- Consumes: authenticated device context, client WireGuard public key, requested country/region, Task 1 schema, and Task 2 node freshness.

- [ ] Write failing tests for active entitlement, no subscription, expired subscription, quota exhausted, banned/suspended account, revoked/banned device, stale/disabled/full node, invalid key, concurrent authorization, reconnect idempotency, disconnect idempotency, and policy-triggered revocation.
- [ ] Run the targeted suite and verify RED because VPN routes do not exist.
- [ ] Implement transaction-safe node selection, address allocation, lease creation/renewal, peer desired state, and disconnect/revocation.
- [ ] Return structured tunnel material only to authenticated Main-process callers; keep private key generation outside Backend.
- [ ] Extend account/device moderation and logout-all paths to revoke active VPN leases atomically.
- [ ] Run targeted and full Backend suites and verify PASS.
- [ ] Update the Handoff and commit `feat: authorize per-device VPN sessions`.

### Task 4: Build the Idempotent Linux VPN Node Agent

**Files:**
- Create: `vpn-agent/package.json`
- Create: `vpn-agent/tsconfig.json`
- Create: `vpn-agent/src/config.ts`
- Create: `vpn-agent/src/identity.ts`
- Create: `vpn-agent/src/control-client.ts`
- Create: `vpn-agent/src/wireguard.ts`
- Create: `vpn-agent/src/reconciler.ts`
- Create: `vpn-agent/src/main.ts`
- Create: `vpn-agent/tests/*.test.ts`
- Create: `vpn-agent/Dockerfile`
- Create: `deploy/vpn-node.compose.yml`
- Modify: `docs/product/stage-2c-handoff.md`

**Interfaces:**
- Produces: a containerized agent that enrolls once, stores its private identity in a mode-0600 mounted path, heartbeats, reconciles desired peers, and reports command results.
- Consumes: Task 2 signed-agent protocol and Task 3 desired-state records.
- `WireGuardAdapter` methods: `ensureInterface(config)`, `listPeers()`, `upsertPeer(peer)`, `removePeer(publicKey)`, `ensureNat(egressInterface)`, and `snapshot()`.

- [ ] Write fake-adapter tests first for initial convergence, duplicate convergence, peer update, peer removal, restart recovery, Backend outage, partial apply failure, and no deletion of unmanaged interfaces/rules.
- [ ] Run the agent tests and verify RED because the agent is absent.
- [ ] Implement identity storage, signed control client, bounded retry/backoff, and reconciler against the fake adapter.
- [ ] Implement the Linux adapter using argument-array process execution for `wg`, `ip`, and `nft`; reject unsafe configuration rather than invoking a shell.
- [ ] Build a minimal nonroot-by-default image; grant only the runtime network capabilities required for WireGuard operations and mount only its state path.
- [ ] Run agent tests, Backend tests, image build, and a dry-run startup check.
- [ ] Update the Handoff and commit `feat: add Linux VPN node agent`.

### Task 5: Prove Real Linux Tunnel Traffic on the Isolated VPS

**Files:**
- Create: `scripts/test-vpn-node-e2e.sh`
- Create: `docs/product/vpn-node-deployment.md`
- Modify: `docs/product/stage-2c-handoff.md`

**Interfaces:**
- Consumes: Tasks 1-4, UDP 51820 after a listener/firewall check, and disposable Linux network namespaces.
- Produces: repeatable evidence that an authorized per-device peer handshakes, routes traffic through the VPS, loses access after revocation, and leaves the unrelated workload unchanged.

- [ ] Write the E2E script's preflight and expected assertions before applying host networking: exact HoaxConnect container names, loopback Backend port, free UDP port, existing-service snapshot, and cleanup trap.
- [ ] Run preflight and verify it stops because WireGuard prerequisites are not yet installed/configured.
- [ ] Install only the required WireGuard userspace tools, load the kernel module, and verify the host supports a disposable interface; do not alter Nginx or the other Compose project.
- [ ] Start disposable Backend/PostgreSQL/agent services with explicit limits, bootstrap a test node, create a disposable account/subscription/device, and authorize a peer.
- [ ] Create a disposable client namespace, apply the returned structured values, verify a WireGuard handshake and public egress through the VPS, then revoke and verify traffic stops.
- [ ] Run the E2E twice to prove cleanup and idempotency; verify the unrelated containers remain healthy and disk/memory stay within limits.
- [ ] Remove disposable namespaces, interfaces, rules, containers, secrets, and test data; retain only sanitized logs and commands in the Handoff.
- [ ] Commit `test: prove isolated VPN node traffic`.

### Task 6: Stage 5 Final Review and Delivery Boundary

**Files:**
- Modify: `docs/product/stage-2c-handoff.md`
- Create: `docs/superpowers/plans/2026-11-22-windows-vpn-service.md`

**Interfaces:**
- Consumes: all Stage 5 commits and verification evidence.
- Produces: reviewed Stage 5 branch and the separate Stage 6 Windows-service plan.

- [ ] Run Backend, agent, migration, lint, build, security-boundary, and isolated VPS E2E checks from clean checkouts.
- [ ] Review the full branch for secret exposure, replay behavior, race conditions, address exhaustion, rollback, and host-network isolation; fix Critical/Important findings with RED-to-GREEN tests.
- [ ] Record exact implemented/unimplemented boundaries: Linux tunnel proven; Windows desktop still simulated until Stage 6 passes.
- [ ] Write the Stage 6 plan for `HoaxConnectService.exe`, WireGuardNT, restricted IPC, protected client keys, route/DNS/firewall rollback, packaging, and Windows E2E.
- [ ] Push the Stage 5 branch. Do not merge, publish an updater feed, or create a public Release until Stage 6 packaged Windows E2E is complete.
