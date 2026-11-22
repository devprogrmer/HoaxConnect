import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Reconciler } from "../src/reconciler.js";
import type { DesiredPeer, InterfaceConfig, PeerSnapshot, WireGuardAdapter } from "../src/wireguard.js";

const peer = (key: string, ip: string, version = 1): DesiredPeer => ({
  vpnSessionId: `session-${key}`, publicKey: key, allowedIp: ip, configVersion: version,
  leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
});

class FakeAdapter implements WireGuardAdapter {
  peers = new Map<string, PeerSnapshot>();
  calls: string[] = [];
  failKey: string | null = null;
  async ensureInterface(config: InterfaceConfig) { this.calls.push(`interface:${config.name}`); }
  async listPeers() { return [...this.peers.values()]; }
  async upsertPeer(value: DesiredPeer) {
    this.calls.push(`upsert:${value.publicKey}:${value.allowedIp}`);
    if (value.publicKey === this.failKey) throw new Error("partial apply");
    this.peers.set(value.publicKey, { publicKey: value.publicKey, allowedIp: value.allowedIp });
  }
  async removePeer(publicKey: string) { this.calls.push(`remove:${publicKey}`); this.peers.delete(publicKey); }
  async ensureNat(egressInterface: string) { this.calls.push(`nat:${egressInterface}`); }
  async snapshot() { return { publicKey: "server-public-key", currentPeers: this.peers.size }; }
}

test("reconciler converges idempotently and never removes unmanaged peers", async () => {
  const state = await mkdtemp(join(tmpdir(), "hc-agent-state-"));
  const stateFile = join(state, "managed-peers.json");
  const config: InterfaceConfig = {
    name: "hcx0", address: "10.88.0.1/24", listenPort: 51820,
    privateKeyPath: join(state, "wireguard.key"), egressInterface: "eth0",
  };
  const adapter = new FakeAdapter();
  adapter.peers.set("unmanaged", { publicKey: "unmanaged", allowedIp: "10.88.0.99/32" });
  const reconciler = new Reconciler(adapter, config, stateFile);
  try {
    const first = [peer("peer-a", "10.88.0.2/32"), peer("peer-b", "10.88.0.3/32")];
    await reconciler.reconcile(first);
    assert.deepEqual([...adapter.peers.keys()].sort(), ["peer-a", "peer-b", "unmanaged"]);
    const callsAfterFirst = adapter.calls.length;
    await reconciler.reconcile(first);
    assert.equal(adapter.calls.length, callsAfterFirst + 2, "only interface/NAT checks repeat");

    await reconciler.reconcile([peer("peer-a", "10.88.0.4/32", 2)]);
    assert.equal(adapter.peers.get("peer-a")?.allowedIp, "10.88.0.4/32");
    assert.equal(adapter.peers.has("peer-b"), false);
    assert.equal(adapter.peers.has("unmanaged"), true);

    const restarted = new Reconciler(adapter, config, stateFile);
    await restarted.reconcile([]);
    assert.equal(adapter.peers.has("peer-a"), false);
    assert.equal(adapter.peers.has("unmanaged"), true);
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), { version: 1, peers: {} });
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("partial apply leaves durable state unchanged and a retry converges", async () => {
  const state = await mkdtemp(join(tmpdir(), "hc-agent-partial-"));
  const stateFile = join(state, "managed-peers.json");
  const adapter = new FakeAdapter();
  const config: InterfaceConfig = { name: "hcx0", address: "10.88.0.1/24", listenPort: 51820,
    privateKeyPath: join(state, "wg.key"), egressInterface: "eth0" };
  const reconciler = new Reconciler(adapter, config, stateFile);
  try {
    adapter.failKey = "peer-b";
    await assert.rejects(() => reconciler.reconcile([
      peer("peer-a", "10.88.0.2/32"), peer("peer-b", "10.88.0.3/32"),
    ]), /partial apply/);
    await assert.rejects(() => readFile(stateFile, "utf8"), /ENOENT/);
    adapter.failKey = null;
    await reconciler.reconcile([
      peer("peer-a", "10.88.0.2/32"), peer("peer-b", "10.88.0.3/32"),
    ]);
    assert.equal(adapter.peers.size, 2);
  } finally { await rm(state, { recursive: true, force: true }); }
});

