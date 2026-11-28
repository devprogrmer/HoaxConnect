const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  createVpnServiceClient,
} = require("../vpn-service-client.cjs");

class FakeSocket extends EventEmitter {
  constructor(onWrite) {
    super();
    this.onWrite = onWrite;
    this.destroyed = false;
  }
  setEncoding() {}
  write(value) { this.onWrite(value, this); }
  end() { this.destroyed = true; }
  destroy() { this.destroyed = true; }
}

function connector(onWrite) {
  return (_options, onConnect) => {
    const socket = new FakeSocket(onWrite);
    queueMicrotask(onConnect);
    return socket;
  };
}

test("service client sends a bounded versioned request and matches its response", async () => {
  let sent;
  const client = createVpnServiceClient({
    connect: connector((value, socket) => {
      sent = JSON.parse(value.trim());
      queueMicrotask(() => socket.emit("data", `${JSON.stringify({
        version: 1,
        id: sent.id,
        ok: true,
        result: { publicKey: `${"A".repeat(43)}=` },
      })}\n`));
    }),
  });

  const result = await client.identity();
  assert.equal(sent.version, 1);
  assert.equal(sent.method, "identity");
  assert.deepEqual(sent.params, {});
  assert.equal(result.publicKey, `${"A".repeat(43)}=`);
});

test("service client rejects mismatched, malformed and oversized responses", async () => {
  const mismatched = createVpnServiceClient({
    connect: connector((_value, socket) => {
      queueMicrotask(() => socket.emit("data", '{"version":1,"id":"wrong","ok":true,"result":{}}\n'));
    }),
  });
  await assert.rejects(mismatched.status(), /response identifier/);

  const malformed = createVpnServiceClient({
    connect: connector((_value, socket) => {
      queueMicrotask(() => socket.emit("data", "not-json\n"));
    }),
  });
  await assert.rejects(malformed.status(), /invalid response/);

  const oversized = createVpnServiceClient({
    connect: connector((_value, socket) => {
      queueMicrotask(() => socket.emit("data", "x".repeat(65_537)));
    }),
  });
  await assert.rejects(oversized.status(), /maximum message size/);
});

test("service client reports unavailable and timed-out service without hanging", async () => {
  const unavailable = createVpnServiceClient({
    connect: () => {
      const socket = new FakeSocket(() => {});
      queueMicrotask(() => socket.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })));
      return socket;
    },
  });
  await assert.rejects(unavailable.status(), /not available/);

  const timedOut = createVpnServiceClient({
    connect: connector(() => {}),
    timeoutMs: 5,
  });
  await assert.rejects(timedOut.status(), /timed out/);
});

test("service client exposes only the supported tunnel commands", async () => {
  const methods = [];
  const client = createVpnServiceClient({
    connect: connector((value, socket) => {
      const request = JSON.parse(value.trim());
      methods.push(request.method);
      queueMicrotask(() => socket.emit("data", `${JSON.stringify({
        version: 1,
        id: request.id,
        ok: true,
        result: {},
      })}\n`));
    }),
  });

  await client.status();
  await client.connect({ generation: "g", applicationPaths: [], authorization: {} });
  await client.disconnect({ generation: "g", reason: "test" });
  assert.deepEqual(methods, ["status", "connect", "disconnect"]);
  assert.equal(Object.hasOwn(client, "request"), false);
});

