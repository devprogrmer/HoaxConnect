const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createDeviceReporter, hardwareFingerprint } = require("../device-reporting.cjs");

function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hc-report-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reports = [];
  let collectorCalls = 0;
  const owner = { getDeviceIdForMainProcess: () => "device-one",
    async reportDeviceState(report, id) { reports.push({ report, id }); return { ok: true }; } };
  const reporter = createDeviceReporter({ owner, userDataPath: directory,
    hardwareCollector: async () => { collectorCalls += 1; return { hwid_sha256: "a".repeat(64) }; },
    applicationsCollector: async () => { collectorCalls += 1; return ["ExampleApp"]; }, ...overrides });
  return { reporter, reports, owner, directory, collectorCalls: () => collectorCalls };
}

test("presence does not collect optional hardware or application data without consent", async (t) => {
  const { reporter, reports, collectorCalls } = setup(t);
  await reporter.tick();
  assert.equal(collectorCalls(), 0);
  assert.equal(reports[0].report.hardware, null);
  assert.equal(reports[0].report.applications, null);
  assert.equal(reports[0].report.network, null);
  assert.equal(reports[0].id, "device-one");
});

test("withdrawing consent clears data in the next report and persists the choice", async (t) => {
  const { reporter, reports, owner, directory } = setup(t);
  await reporter.setPermissions({ hardware: true, network: true, applications: true });
  assert.deepEqual(reports[0].report.applications, ["ExampleApp"]);
  await reporter.setPermissions({ hardware: false, network: false, applications: false });
  assert.equal(reports.at(-1).report.hardware, null);
  assert.equal(reports.at(-1).report.applications, null);
  const restored = createDeviceReporter({ owner, userDataPath: directory });
  assert.deepEqual(restored.getSettings().permissions, { hardware: false, network: false, applications: false });
});

test("consent revoked during collection prevents the old snapshot from being sent", async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let started;
  const collecting = new Promise((resolve) => { started = resolve; });
  const { reporter, reports } = setup(t, { applicationsCollector: async () => { started(); await waiting; return ["PrivateApp"]; } });
  const enabling = reporter.setPermissions({ hardware: false, network: false, applications: true });
  await collecting;
  const disabling = reporter.setPermissions({ hardware: false, network: false, applications: false });
  release();
  await Promise.all([enabling, disabling]);
  assert.ok(reports.length);
  assert.equal(JSON.stringify(reports).includes("PrivateApp"), false);
});

test("concurrent ticks share a single request and closing sends no optional data", async (t) => {
  const { reporter, reports } = setup(t);
  await Promise.all([reporter.tick(), reporter.tick(), reporter.tick()]);
  assert.equal(reports.length, 1);
  await reporter.stop();
  assert.equal(reports.at(-1).report.app_state, "closed");
  await reporter.tick();
  assert.equal(reports.length, 2);
});

test("a hardware fingerprint hashes the reported UUID and rejects placeholder IDs", () => {
  assert.equal(hardwareFingerprint("00000000-0000-0000-0000-000000000000"), null);
  assert.equal(hardwareFingerprint("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"), null);
  assert.equal(hardwareFingerprint("unavailable"), null);
  const uuid = "ad137334-122a-4527-8385-ae317c636aac";
  assert.match(hardwareFingerprint(uuid), /^[a-f0-9]{64}$/);
  assert.equal(hardwareFingerprint(uuid), hardwareFingerprint(uuid.toUpperCase()));
  assert.notEqual(hardwareFingerprint(uuid), uuid.replaceAll("-", ""));
});
