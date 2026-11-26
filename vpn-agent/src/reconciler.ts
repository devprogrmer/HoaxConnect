import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DesiredPeer, InterfaceConfig, WireGuardAdapter } from "./wireguard.js";

type ManagedState = { version: 1; peers: Record<string, {
  allowedIp: string;
  configVersion: number;
  leaseExpiresAt?: string;
}> };
const emptyState = (): ManagedState => ({ version: 1, peers: {} });

export class Reconciler {
  constructor(
    private readonly adapter: WireGuardAdapter,
    private readonly interfaceConfig: InterfaceConfig,
    private readonly stateFile: string,
  ) {}

  private async loadState(): Promise<ManagedState> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as ManagedState;
      if (parsed.version !== 1 || !parsed.peers || typeof parsed.peers !== "object") {
        throw new Error("Invalid managed peer state");
      }
      return parsed;
    } catch (error: any) {
      if (error?.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  private async saveState(state: ManagedState) {
    await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, this.stateFile);
  }

  async expireLeases(now = Date.now()) {
    await this.adapter.ensureInterface(this.interfaceConfig);
    const previous = await this.loadState();
    const actual = new Set((await this.adapter.listPeers()).map((peer) => peer.publicKey));
    let changed = false;
    for (const [publicKey, managed] of Object.entries(previous.peers)) {
      const expiresAt = managed.leaseExpiresAt ? Date.parse(managed.leaseExpiresAt) : Number.NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        if (actual.has(publicKey)) await this.adapter.removePeer(publicKey);
        delete previous.peers[publicKey];
        changed = true;
      }
    }
    if (changed) await this.saveState(previous);
  }

  async reconcile(desiredPeers: DesiredPeer[]) {
    await this.adapter.ensureInterface(this.interfaceConfig);
    await this.adapter.ensureNat(this.interfaceConfig.egressInterface);
    const previous = await this.loadState();
    const actual = new Map((await this.adapter.listPeers()).map((peer) => [peer.publicKey, peer]));
    const now = Date.now();
    const activePeers = desiredPeers.filter((peer) => {
      const expiresAt = Date.parse(peer.leaseExpiresAt);
      return Number.isFinite(expiresAt) && expiresAt > now;
    });
    const desired = new Map(activePeers.map((peer) => [peer.publicKey, peer]));

    for (const peer of activePeers) {
      const current = actual.get(peer.publicKey);
      if (!current || current.allowedIp !== peer.allowedIp ||
          previous.peers[peer.publicKey]?.configVersion !== peer.configVersion) {
        await this.adapter.upsertPeer(peer);
      }
    }
    for (const publicKey of Object.keys(previous.peers)) {
      if (!desired.has(publicKey) && actual.has(publicKey)) await this.adapter.removePeer(publicKey);
    }
    await this.saveState({ version: 1, peers: Object.fromEntries(activePeers.map((peer) => [
      peer.publicKey, { allowedIp: peer.allowedIp, configVersion: peer.configVersion,
        leaseExpiresAt: peer.leaseExpiresAt },
    ])) });
  }
}

