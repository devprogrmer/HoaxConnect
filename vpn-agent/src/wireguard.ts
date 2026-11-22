import { execFile } from "node:child_process";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const safeName = /^[A-Za-z0-9_.:-]{1,32}$/;
const wireGuardKey = /^[A-Za-z0-9+/]{43}=$/;
const ipv4Cidr = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export type InterfaceConfig = {
  name: string;
  address: string;
  listenPort: number;
  privateKeyPath: string;
  egressInterface: string;
};

export type DesiredPeer = {
  vpnSessionId: string;
  publicKey: string;
  allowedIp: string;
  configVersion: number;
  leaseExpiresAt: string;
};

export type PeerSnapshot = { publicKey: string; allowedIp: string };
export type InterfaceSnapshot = { publicKey: string; currentPeers: number };

export interface WireGuardAdapter {
  ensureInterface(config: InterfaceConfig): Promise<void>;
  listPeers(): Promise<PeerSnapshot[]>;
  upsertPeer(peer: DesiredPeer): Promise<void>;
  removePeer(publicKey: string): Promise<void>;
  ensureNat(egressInterface: string): Promise<void>;
  snapshot(): Promise<InterfaceSnapshot>;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: CommandRunner = async (file, args) => {
  const result = await execFileAsync(file, [...args], { encoding: "utf8", timeout: 15_000 });
  return { stdout: result.stdout, stderr: result.stderr };
};

function assertSafe(value: string, pattern: RegExp, label: string) {
  if (!pattern.test(value)) throw new Error(`Unsafe ${label}`);
}

export class LinuxWireGuardAdapter implements WireGuardAdapter {
  constructor(
    private readonly interfaceName: string,
    private readonly runner: CommandRunner = defaultRunner,
  ) { assertSafe(interfaceName, safeName, "WireGuard interface name"); }

  private async ensurePrivateKey(path: string) {
    try { await access(path); }
    catch {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const generated = (await this.runner("wg", ["genkey"])).stdout.trim();
      assertSafe(generated, wireGuardKey, "generated WireGuard key");
      await writeFile(path, `${generated}\n`, { mode: 0o600, flag: "wx" });
    }
    await chmod(path, 0o600);
  }

  async ensureInterface(config: InterfaceConfig) {
    if (config.name !== this.interfaceName) throw new Error("WireGuard interface mismatch");
    assertSafe(config.name, safeName, "WireGuard interface name");
    assertSafe(config.address, ipv4Cidr, "WireGuard address");
    assertSafe(config.egressInterface, safeName, "egress interface");
    if (!Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) {
      throw new Error("Invalid WireGuard listen port");
    }
    try { await this.runner("ip", ["link", "show", "dev", config.name]); }
    catch { await this.runner("ip", ["link", "add", "dev", config.name, "type", "wireguard"]); }
    await this.ensurePrivateKey(config.privateKeyPath);
    await this.runner("wg", ["set", config.name, "private-key", config.privateKeyPath,
      "listen-port", String(config.listenPort)]);
    await this.runner("ip", ["address", "replace", config.address, "dev", config.name]);
    await this.runner("ip", ["link", "set", "dev", config.name, "up"]);
  }

  async listPeers() {
    const output = (await this.runner("wg", ["show", this.interfaceName, "dump"])).stdout.trim();
    if (!output) return [];
    return output.split("\n").slice(1).flatMap((line) => {
      const fields = line.split("\t");
      const publicKey = fields[0];
      const allowedIp = fields[3]?.split(",")[0];
      return publicKey && allowedIp ? [{ publicKey, allowedIp }] : [];
    });
  }

  async upsertPeer(peer: DesiredPeer) {
    assertSafe(peer.publicKey, wireGuardKey, "peer public key");
    assertSafe(peer.allowedIp, ipv4Cidr, "peer allowed IP");
    await this.runner("wg", ["set", this.interfaceName, "peer", peer.publicKey,
      "allowed-ips", peer.allowedIp]);
  }

  async removePeer(publicKey: string) {
    assertSafe(publicKey, wireGuardKey, "peer public key");
    await this.runner("wg", ["set", this.interfaceName, "peer", publicKey, "remove"]);
  }

  async ensureNat(egressInterface: string) {
    assertSafe(egressInterface, safeName, "egress interface");
    try { await this.runner("nft", ["list", "table", "inet", "hoaxconnect"]); }
    catch {
      await this.runner("nft", ["add", "table", "inet", "hoaxconnect"]);
      await this.runner("nft", ["add", "chain", "inet", "hoaxconnect", "postrouting",
        "{", "type", "nat", "hook", "postrouting", "priority", "srcnat", ";", "policy", "accept", ";", "}"]);
    }
    const rules = (await this.runner("nft", ["list", "chain", "inet", "hoaxconnect", "postrouting"])).stdout;
    const marker = `hoaxconnect-nat-${egressInterface}`;
    if (!rules.includes(marker)) {
      await this.runner("nft", ["add", "rule", "inet", "hoaxconnect", "postrouting",
        "oifname", egressInterface, "masquerade", "comment", marker]);
    }
  }

  async snapshot() {
    const publicKey = (await this.runner("wg", ["show", this.interfaceName, "public-key"])).stdout.trim();
    assertSafe(publicKey, wireGuardKey, "WireGuard public key");
    return { publicKey, currentPeers: (await this.listPeers()).length };
  }
}

