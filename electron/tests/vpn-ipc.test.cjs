const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createVpnIpcHandlers,
} = require("../vpn-ipc.cjs");

test("VPN IPC uses persisted selected applications instead of renderer paths", async () => {
  let received;
  const handlers = createVpnIpcHandlers({
    connection: {
      getState: () => ({ status: "idle" }),
      connect: async (input) => { received = input; return { status: "connected" }; },
      disconnect: async () => ({ status: "idle" }),
    },
    readSplitState: () => ({
      mode: "selected-only",
      selectedApps: [{ path: "C:\\Games\\Allowed.exe" }],
    }),
  });

  const result = await handlers.connect({
    location: { countryCode: "DE" },
    apps: [{ path: "C:\\Windows\\System32\\cmd.exe" }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(received.apps, [{ path: "C:\\Games\\Allowed.exe" }]);
  assert.deepEqual(received.location, { countryCode: "DE" });
});

test("VPN IPC returns bounded errors and never exposes stacks", async () => {
  const handlers = createVpnIpcHandlers({
    connection: {
      getState: () => ({ status: "idle" }),
      connect: async () => { throw new Error(`private ${"x".repeat(800)}`); },
      disconnect: async () => { throw new Error("private disconnect"); },
    },
    readSplitState: () => ({ mode: "selected-only", selectedApps: [{ path: "C:\\Game.exe" }] }),
  });

  const result = await handlers.connect({ location: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "VPN_CONNECT_FAILED");
  assert.ok(result.error.message.length <= 240);
  assert.equal(JSON.stringify(result).includes("stack"), false);
});

