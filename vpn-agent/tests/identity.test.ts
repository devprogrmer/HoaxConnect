import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentConfig } from "../src/config.js";
import { loadOrEnrollIdentity } from "../src/identity.js";

test("identity enrolls once and persists private material with mode 0600", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hc-agent-identity-"));
  const config: AgentConfig = {
    backendUrl: "https://api.example.test", nodeId: "11111111-1111-4111-8111-111111111111",
    enrollmentToken: "enrollment-token", stateDir,
    identityPath: join(stateDir, "identity.json"), managedPeersPath: join(stateDir, "peers.json"),
    interface: { name: "hcx0", address: "10.88.0.1/24", listenPort: 51820,
      privateKeyPath: join(stateDir, "wg.key"), egressInterface: "eth0" },
    publicEndpoint: "198.51.100.20:51820", capacityPeers: 100, intervalMs: 15_000, dryRun: false,
  };
  let enrollments = 0;
  const enroll = async () => {
    enrollments += 1;
    return new Response(JSON.stringify({ data: { credential_id: "22222222-2222-4222-8222-222222222222" } }),
      { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const first = await loadOrEnrollIdentity(config, enroll as typeof fetch);
    const second = await loadOrEnrollIdentity(config, async () => { throw new Error("must not enroll twice"); });
    assert.equal(first.credentialId, second.credentialId);
    assert.equal(enrollments, 1);
    if (process.platform !== "win32") {
      assert.equal((await stat(config.identityPath)).mode & 0o777, 0o600);
    }
    assert.equal(first.privateKey.type, "private");
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

