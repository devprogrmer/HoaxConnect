import assert from "node:assert/strict";
import { test } from "node:test";
import { PathFailover } from "../src/path-failover.js";

const healthy = { lossPercent: 0 };
const degraded = { lossPercent: 20 };

test("ignores a transient loss round, switches to a healthy relay, and waits before reverting", async () => {
  const changes: string[] = [];
  const policy = new PathFailover(async (path) => { changes.push(path); });
  assert.equal(await policy.observe(degraded, healthy), "primary");
  assert.equal(await policy.observe(healthy, healthy), "primary");
  assert.equal(await policy.observe(degraded, healthy), "primary");
  assert.equal(await policy.observe(degraded, healthy), "relay");
  for (let round = 0; round < 4; round += 1) {
    assert.equal(await policy.observe(healthy, healthy), "relay");
  }
  assert.equal(await policy.observe(healthy, healthy), "primary");
  assert.deepEqual(changes, ["relay", "primary"]);
});

test("retains the current path if both fail and retries a rejected route update", async () => {
  let attempts = 0;
  const policy = new PathFailover(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("route update rejected");
  });
  assert.equal(await policy.observe(degraded, degraded), "primary");
  assert.equal(await policy.observe(degraded, degraded), "primary");
  await assert.rejects(policy.observe(degraded, healthy), /rejected/);
  assert.equal(await policy.observe(degraded, healthy), "relay");
  assert.equal(await policy.observe(healthy, degraded), "primary");
});
