import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RouteTransport, type RouteGroup } from "../src/route-transport.js";
import type { CommandRunner } from "../src/wireguard.js";

const key = (c: string) => c.repeat(43) + "=";
function fixture(): RouteGroup {
  const groupId = randomUUID();
  return { groupId, configVersion: "1", phase: "staging", role: "entry",
    interfaceName: `hcr${groupId.replace(/-/g, "").slice(0, 11)}`,
    linkAddress: "10.253.17.2/24", gatewayLinkIp: "10.253.17.1",
    gatewayEndpoint: "192.0.2.22:51820", linkPort: 51830, routingTable: 20101,
    clientCidr: "10.143.0.0/24", gatewayPublicKey: key("A"),
    peers: [{ nodeId: randomUUID(), publicKey: key("B"),
      linkIp: "10.253.17.2", clientCidr: "10.143.0.0/24" }] };
}

test("staging installs dedicated WG only, and withdrawal removes owned resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc-route-transport-"));
  const group = fixture();
  const calls: string[] = [];
  let exists = false;
  const runner: CommandRunner = async (file, args) => {
    const command = `${file} ${args.join(" ")}`;
    calls.push(command);
    if (file === "ip" && args[0] === "link" && args[1] === "show" && !exists) throw new Error("not found");
    if (file === "ip" && args[0] === "link" && args[1] === "add") exists = true;
    if (file === "ip" && args[0] === "link" && args[1] === "del") exists = false;
    if (command === "ip -4 route show table 20101") {
      throw Object.assign(new Error("Dump terminated"),
        { stderr: "Error: ipv4: FIB table does not exist.\nDump terminated\n" });
    }
    if (command === `wg show ${group.interfaceName} latest-handshakes`) return {
      stdout: `${key("A")}\t${Math.floor(Date.now() / 1000)}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const transport = new RouteTransport(dir, "hcx0", "eth0", runner);
  try {
    await transport.reconcile([group]);
    assert.equal(exists, true);
    assert.equal(await transport.health(group), false); // No actual link address exists in this mocked namespace.
    assert.match(calls.join("\n"), /allowed-ips 0\.0\.0\.0\/0 endpoint 192\.0\.2\.22:51830/);
    assert.ok(!calls.some((line) => line.startsWith("ip -4 rule add")));
    assert.deepEqual(JSON.parse(await readFile(join(dir, "route-transport-owned.json"), "utf8"))
      .map((item: { groupId: string }) => item.groupId), [group.groupId]);
    await transport.withdraw();
    assert.equal(exists, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rejects invalid allocations before running commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc-route-validate-"));
  let called = false;
  const transport = new RouteTransport(dir, "hcx0", "eth0", async () => {
    called = true; return { stdout: "", stderr: "" };
  });
  try {
    await assert.rejects(() => transport.reconcile([{ ...fixture(), linkAddress: "10.1.1.999/24" }]));
    assert.equal(called, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
