const assert = require("node:assert/strict");
const { createVpnServiceClient } = require("../electron/vpn-service-client.cjs");

async function verifyInstalledService() {
  const service = createVpnServiceClient({ timeoutMs: 15_000 });
  const status = await service.status();
  assert.equal(status.status, "idle");
  const first = await service.identity();
  assert.match(first.publicKey, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal((await service.identity()).publicKey, first.publicKey);
  console.log("Installed Windows service responds to status and preserves its WireGuard identity.");
}

verifyInstalledService().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
