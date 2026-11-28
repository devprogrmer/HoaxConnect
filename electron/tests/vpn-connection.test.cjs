const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createVpnConnection,
} = require("../vpn-connection.cjs");

const CLIENT_KEY = `${"A".repeat(43)}=`;
const SERVER_KEY = `${"B".repeat(43)}=`;
const APP = {
  id: "game",
  name: "Game",
  exeName: "Game.exe",
  path: "C:\\Games\\Game.exe",
  source: "manual",
};

function authorization(expiresAt = "2030-01-01T00:05:00.000Z") {
  return {
    connection_group_id: "connection-group",
    paths: [
      { vpn_session_id: "session-a", node: { id: "node-a", endpoint: "198.51.100.20:51820", public_key: SERVER_KEY },
        client: { assigned_ip: "10.88.0.2", dns_servers: ["1.1.1.1"] }, lease_expires_at: expiresAt },
      { vpn_session_id: "session-b", node: { id: "node-b", endpoint: "198.51.100.21:51820", public_key: `${"C".repeat(43)}=` },
        client: { assigned_ip: "10.89.0.2", dns_servers: ["1.1.1.1"] }, lease_expires_at: expiresAt },
    ],
    lease_expires_at: expiresAt,
  };
}

test("connection authorizes and applies only selected executable paths", async () => {
  const calls = [];
  const connection = createVpnConnection({
    api: {
      authorizeMulti: async (input) => {
        calls.push(["authorize", input]);
        return authorization();
      },
      disconnect: async () => ({ disconnected: true }),
    },
    service: {
      identity: async () => ({ publicKey: CLIENT_KEY }),
      connect: async (input) => calls.push(["connect", input]),
      disconnect: async () => calls.push(["disconnect"]),
    },
  });

  const state = await connection.connect({
    mode: "selected-only",
    apps: [APP],
    location: { countryCode: "DE", region: "Frankfurt" },
  });

  assert.equal(state.status, "connected");
  assert.equal(state.node.endpoint, "198.51.100.20:51820");
  assert.equal(state.paths.length, 2);
  assert.equal(calls[0][0], "authorize");
  assert.equal(calls[0][1].clientPublicKey, CLIENT_KEY);
  assert.deepEqual(calls[1][1].applicationPaths, ["C:\\Games\\Game.exe"]);
  assert.equal(calls[1][1].authorization.connection_group_id, "connection-group");
});

test("connection refuses empty, non-selected and unsafe application inputs", async () => {
  const connection = createVpnConnection({
    api: { authorizeMulti: async () => assert.fail(), disconnect: async () => ({}) },
    service: { identity: async () => assert.fail(), connect: async () => assert.fail(), disconnect: async () => {} },
  });

  await assert.rejects(
    connection.connect({ mode: "all", apps: [APP], location: {} }),
    /selected-only/,
  );
  await assert.rejects(
    connection.connect({ mode: "selected-only", apps: [], location: {} }),
    /Select at least one application/,
  );
  await assert.rejects(
    connection.connect({
      mode: "selected-only",
      apps: [{ ...APP, path: "..\\Game.exe" }],
      location: {},
    }),
    /absolute Windows executable/,
  );
});

test("local apply failure cleans local state and revokes the Backend lease", async () => {
  const calls = [];
  const connection = createVpnConnection({
    api: {
      authorizeMulti: async () => authorization(),
      disconnect: async () => calls.push("remote-disconnect"),
    },
    service: {
      identity: async () => ({ publicKey: CLIENT_KEY }),
      connect: async () => { throw new Error("WFP apply failed"); },
      disconnect: async () => calls.push("local-disconnect"),
    },
  });

  await assert.rejects(
    connection.connect({ mode: "selected-only", apps: [APP], location: {} }),
    /WFP apply failed/,
  );
  assert.deepEqual(calls, ["local-disconnect", "remote-disconnect"]);
  assert.equal(connection.getState().status, "error");
});

test("disconnect is idempotent and always cleans local policy", async () => {
  let localDisconnects = 0;
  let remoteDisconnects = 0;
  const connection = createVpnConnection({
    api: {
      authorizeMulti: async () => authorization(),
      disconnect: async () => { remoteDisconnects += 1; },
    },
    service: {
      identity: async () => ({ publicKey: CLIENT_KEY }),
      connect: async () => {},
      disconnect: async () => { localDisconnects += 1; },
    },
  });

  await connection.connect({ mode: "selected-only", apps: [APP], location: {} });
  await connection.disconnect();
  await connection.disconnect();

  assert.equal(remoteDisconnects, 1);
  assert.equal(localDisconnects, 2);
  assert.equal(connection.getState().status, "idle");
});

test("lease expiry fails closed by disconnecting the local service", async () => {
  let expiryHandler = null;
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  const localReasons = [];
  const connection = createVpnConnection({
    api: {
      authorizeMulti: async () => authorization("2030-01-01T00:00:10.000Z"),
      disconnect: async () => ({}),
    },
    service: {
      identity: async () => ({ publicKey: CLIENT_KEY }),
      connect: async () => {},
      disconnect: async (input) => localReasons.push(input.reason),
    },
    clock: {
      now: () => now,
      setTimeout: (handler, delay) => {
        assert.equal(delay, 10_000);
        expiryHandler = handler;
        return 1;
      },
      clearTimeout: () => {},
    },
  });

  await connection.connect({ mode: "selected-only", apps: [APP], location: {} });
  now = Date.parse("2030-01-01T00:00:10.000Z");
  await expiryHandler();

  assert.deepEqual(localReasons, ["lease_expired"]);
  assert.equal(connection.getState().status, "error");
  assert.equal(connection.getState().error.code, "VPN_LEASE_EXPIRED");
});


test("disconnect waits for a pending connect and revokes the resulting session", async () => {
  let release;
  let remoteDisconnects = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const connection = createVpnConnection({
    api: {
      authorizeMulti: async () => { await gate; return authorization(); },
      disconnect: async () => { remoteDisconnects++; return { disconnected: true }; },
    },
    service: {
      identity: async () => ({ publicKey: CLIENT_KEY }),
      connect: async () => {},
      disconnect: async () => {},
    },
  });

  const connecting = connection.connect({ mode: "selected-only", apps: [APP] });
  const disconnecting = connection.disconnect();
  release();
  await connecting;
  await disconnecting;
  assert.equal(remoteDisconnects, 1);
  assert.equal(connection.getState().status, "idle");
});

test("simultaneous disconnects revoke the active lease once", async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const connection = createVpnConnection({
    api: {
      authorizeMulti: async () => authorization(),
      disconnect: async () => { calls++; await gate; return { disconnected: true }; },
    },
    service: {
      identity: async () => ({ publicKey: CLIENT_KEY }),
      connect: async () => {},
      disconnect: async () => {},
    },
  });
  await connection.connect({ mode: "selected-only", apps: [APP] });
  const first = connection.disconnect();
  const second = connection.disconnect();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(connection.getState().status, "idle");
});
