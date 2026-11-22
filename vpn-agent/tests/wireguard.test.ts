import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LinuxWireGuardAdapter, type CommandRunner } from "../src/wireguard.js";

test("Linux adapter invokes only fixed binaries with argument arrays and owns only its interface/table", async () => {
  const state = await mkdtemp(join(tmpdir(), "hc-agent-wg-"));
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    if (file === "ip" && args[0] === "link" && args[1] === "show") throw new Error("missing");
    if (file === "wg" && args[0] === "genkey") return { stdout: `${"A".repeat(43)}=\n`, stderr: "" };
    if (file === "nft" && args[0] === "list" && args[1] === "table") throw new Error("missing");
    return { stdout: "", stderr: "" };
  };
  const adapter = new LinuxWireGuardAdapter("hcx0", runner);
  try {
    await adapter.ensureInterface({ name: "hcx0", address: "10.88.0.1/24", listenPort: 51820,
      privateKeyPath: join(state, "wireguard.key"), egressInterface: "eth0" });
    await adapter.ensureNat("eth0");
    await adapter.upsertPeer({ vpnSessionId: "s", publicKey: `${"B".repeat(43)}=`,
      allowedIp: "10.88.0.2/32", configVersion: 1, leaseExpiresAt: new Date().toISOString() });
    assert.ok(calls.every((call) => ["ip", "wg", "nft"].includes(call.file)));
    assert.ok(calls.some((call) => call.file === "ip" && call.args.join(" ") === "link add dev hcx0 type wireguard"));
    assert.ok(calls.some((call) => call.file === "nft" && call.args.includes("hoaxconnect")));
    assert.equal(calls.some((call) => call.file.includes("sh") || call.args.some((arg) => arg.includes("&&"))), false);
    await assert.rejects(() => adapter.ensureNat("eth0;rm"), /Unsafe/);
  } finally { await rm(state, { recursive: true, force: true }); }
});
