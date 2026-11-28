import assert from "node:assert/strict";
import { test } from "node:test";
import { MultiPathSelector, scorePath } from "../src/multi-path-selector.js";
import { parsePathConfig } from "../src/multi-path-cli.js";

const reading = (id: string, ...samples: (number | null)[]) => ({ id, samples });

test("scores latency, jitter, p95 and loss without treating a timed out probe as fast", () => {
  const stable = scorePath(reading("stable", 20, 21, 22));
  const unstable = scorePath(reading("unstable", 15, null, 70));
  assert.equal(stable.healthy, true);
  assert.equal(unstable.healthy, false);
  assert.ok(unstable.score > stable.score);
  assert.equal(scorePath(reading("dead", null, null)).score, Infinity);
});

test("selects any healthy relay after two bad rounds and holds route when all probes fail", async () => {
  const applied: string[] = [];
  let now = 0;
  const selector = new MultiPathSelector({ paths: ["ir1", "ir2", "ir3"],
    apply: async (id) => { applied.push(id); }, now: () => now });
  const first = [reading("ir1", null, null, 80), reading("ir2", 40, 41, 42), reading("ir3", 30, 31, 32)];
  assert.equal((await selector.observe(first)).reason, "hysteresis");
  assert.equal((await selector.observe(first)).path, "ir3");
  assert.deepEqual(applied, ["ir3"]);
  const none = [reading("ir1", null), reading("ir2", null), reading("ir3", null)];
  assert.equal((await selector.observe(none)).path, "ir3");
  now = 2100;
  const recovered = [reading("ir1", 10, 11), reading("ir2", 40, 41), reading("ir3", 30, 31)];
  await selector.observe(recovered);
  assert.equal((await selector.observe(recovered)).path, "ir1");
});

test("cooldown prevents flapping and a rejected route update is retried", async () => {
  let now = 0;
  let attempts = 0;
  const selector = new MultiPathSelector({ paths: ["a", "b"], now: () => now,
    apply: async () => { attempts++; if (attempts === 1) throw Error("ip route failed"); } });
  const bad = [reading("a", null), reading("b", 10, 11)];
  await selector.observe(bad);
  await assert.rejects(selector.observe(bad));
  assert.equal(selector.activePath, "a");
  assert.equal((await selector.observe(bad)).path, "b");
  const reverse = [reading("a", 10, 11), reading("b", null)];
  await selector.observe(reverse);
  assert.equal((await selector.observe(reverse)).reason, "hysteresis");
  now = 2000;
  assert.equal((await selector.observe(reverse)).path, "a");
});

test("rejects duplicate or ambiguous path probes before touching the route", () => {
  const config = { endpoint: "192.0.2.10", source: "192.0.2.11", table: 500,
    port: 45900, paths: [{ id: "a", gateway: "10.0.0.1", device: "wg1", probe: "10.1.0.1" },
      { id: "b", gateway: "10.0.0.2", device: "wg2", probe: "10.2.0.1" }] };
  assert.equal(parsePathConfig(config).paths.length, 2);
  assert.throws(() => parsePathConfig({ ...config, paths: [config.paths[0], config.paths[0]] }));
  assert.throws(() => parsePathConfig({ ...config, paths: [config.paths[0], { ...config.paths[1], probe: config.endpoint }] }));
});
