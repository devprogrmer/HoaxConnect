import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";

import { ControlClient } from "../src/control-client.js";

test("control client retries bounded Backend outages and signs every attempt with a fresh nonce", async () => {
  const keys = generateKeyPairSync("ed25519");
  const headers: string[] = [];
  let attempts = 0;
  const client = new ControlClient({
    backendUrl: "https://api.example.test", nodeId: randomUUID(), credentialId: randomUUID(),
    privateKey: keys.privateKey, maxAttempts: 3, baseDelayMs: 1,
    fetchImpl: async (_url, init) => {
      attempts += 1;
      headers.push(new Headers(init?.headers).get("x-hc-nonce") ?? "");
      if (attempts < 3) throw new Error("Backend unavailable");
      return new Response(JSON.stringify({ data: { peers: [], revocations: [], config_version: "1" } }),
        { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.desiredState();
  assert.deepEqual(result.peers, []);
  assert.equal(attempts, 3);
  assert.equal(new Set(headers).size, 3);
});

test("control client stops after its bounded retry budget", async () => {
  const keys = generateKeyPairSync("ed25519");
  let attempts = 0;
  const client = new ControlClient({
    backendUrl: "https://api.example.test", nodeId: randomUUID(), credentialId: randomUUID(),
    privateKey: keys.privateKey, maxAttempts: 2, baseDelayMs: 1,
    fetchImpl: async () => { attempts += 1; throw new Error("offline"); },
  });
  await assert.rejects(() => client.desiredState(), /offline/);
  assert.equal(attempts, 2);
});
