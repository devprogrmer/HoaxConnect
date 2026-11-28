import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { measurePath, openPathProbeResponder } from "../src/path-probe.ts";

test("measures real authenticated UDP round trips and records unanswered probes as loss", async (t) => {
  const key = randomBytes(32);
  const responder = await openPathProbeResponder("127.0.0.1", 0, key);
  t.after(() => responder.close());

  const options = {
    sourceAddress: "127.0.0.1",
    destinationAddress: "127.0.0.1",
    destinationPort: responder.address().port,
    key,
    count: 3,
  };
  const samples = await measurePath(options);
  assert.equal(samples.length, 3);
  assert.ok(samples.every((sample) => sample !== null && sample >= 0));
  assert.deepEqual(await measurePath({
    ...options,
    key: randomBytes(32),
    timeoutMs: 30,
  }), [null, null, null]);
});

test("rejects wildcard binding and unbounded requests", async () => {
  const key = randomBytes(32);
  await assert.rejects(openPathProbeResponder("0.0.0.0", 0, key), /explicit IPv4/);
  await assert.rejects(measurePath({
    sourceAddress: "127.0.0.1",
    destinationAddress: "127.0.0.1",
    destinationPort: 1234,
    key,
    count: 100,
  }), /probe bounds/);
});
