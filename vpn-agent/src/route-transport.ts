import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { promisify } from "node:util";
import type { CommandRunner } from "./wireguard.js";

export type RouteGroup = {
  groupId: string; configVersion: string; phase: "staging" | "active";
  role: "entry" | "gateway"; interfaceName: string;
  linkAddress: string; gatewayLinkIp: string; gatewayEndpoint: string;
  linkPort: number; routingTable: number; clientCidr: string | null;
  gatewayPublicKey: string;
  peers: Array<{ nodeId: string; publicKey: string; linkIp: string; clientCidr: string }>;
};
type Owned = { groupId: string; configVersion: string; interfaceName: string;
  role: "entry" | "gateway"; routingTable: number; clientCidr: string | null;
  peers: RouteGroup["peers"] };
const keyPattern = /^[A-Za-z0-9+/]{43}=$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ip = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const cidr = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[1-9]|[12]\d|3[0-2])$/;
const defaultRunner: CommandRunner = async (file, args) => {
  const { stdout, stderr } = await promisify(execFile)(file, [...args],
    { encoding: "utf8", timeout: 10_000 });
  return { stdout, stderr };
};
const assert = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
function validIp(value: string) {
  return ip.test(value) && value.split(".").every((part) => Number(part) <= 255);
}
function validate(group: RouteGroup) {
  assert(uuid.test(group.groupId) && group.interfaceName ===
    `hcr${group.groupId.replace(/-/g, "").slice(0, 11)}`, "Invalid owned route interface");
  assert(/^[1-9]\d*$/.test(group.configVersion) &&
    (group.phase === "staging" || group.phase === "active"), "Invalid route phase");
  assert((group.role === "entry" || group.role === "gateway") &&
    validIp(group.gatewayLinkIp) && cidr.test(group.linkAddress) &&
    validIp(group.linkAddress.split("/")[0]!), "Invalid link address");
  assert(Number.isInteger(group.linkPort) && group.linkPort >= 1 && group.linkPort <= 65535 &&
    Number.isInteger(group.routingTable) && group.routingTable >= 20000 &&
    group.routingTable <= 60000, "Invalid route allocation");
  assert(keyPattern.test(group.gatewayPublicKey) && group.peers.length > 0 && group.peers.length <= 20 &&
    group.peers.every((p) => uuid.test(p.nodeId) && keyPattern.test(p.publicKey) &&
      validIp(p.linkIp) && cidr.test(p.clientCidr)), "Invalid route peer");
  assert(group.role === "gateway" ? group.clientCidr === null :
    Boolean(group.clientCidr && cidr.test(group.clientCidr) &&
      group.peers.some((p) => p.clientCidr === group.clientCidr)), "Invalid client CIDR");
  assert(/^[A-Za-z0-9.-]+:\d{1,5}$/.test(group.gatewayEndpoint), "Invalid gateway endpoint");
}

export class RouteTransport {
  private readonly file: string;
  private readonly probeServers = new Map<string, Socket>();
  constructor(private readonly stateDir: string, private readonly clientInterface: string,
    private readonly egressInterface: string, private readonly run: CommandRunner = defaultRunner) {
    assert(/^[A-Za-z0-9_.:-]{1,15}$/.test(clientInterface) &&
      /^[A-Za-z0-9_.:-]{1,15}$/.test(egressInterface), "Invalid local interface");
    this.file = join(stateDir, "route-transport-owned.json");
  }
  private async owned(): Promise<Owned[]> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      assert(Array.isArray(data) && data.length <= 100, "Invalid owned route state");
      for (const item of data) {
        assert(uuid.test(item.groupId) && item.interfaceName ===
          `hcr${item.groupId.replace(/-/g, "").slice(0, 11)}` &&
          Number.isInteger(item.routingTable) && item.routingTable >= 20000 &&
          item.routingTable <= 60000, "Invalid owned route state");
      }
      return data;
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }
  private async save(items: Owned[]) {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(items), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }
  private async show(file: string, args: string[]) {
    return (await this.run(file, args)).stdout;
  }
  private async ownedRule(marker: string, action: "add" | "delete", args: string[]) {
    const rules = await this.show("nft", ["-a", "list", "chain", "ip", "filter", "DOCKER-USER"]);
    const line = rules.split("\n").find((row) => row.includes(`comment "${marker}"`));
    if (action === "add" && !line) await this.run("nft", ["insert", "rule", "ip", "filter",
      "DOCKER-USER", ...args, "accept", "comment", marker]);
    if (action === "delete" && line) {
      const handle = line.match(/# handle (\d+)\s*$/)?.[1];
      assert(Boolean(handle), "Missing owned firewall handle");
      await this.run("nft", ["delete", "rule", "ip", "filter", "DOCKER-USER", "handle", handle!]);
    }
  }
  private async nat(group: Owned, enable: boolean) {
    if (group.role !== "gateway") return;
    try { await this.run("nft", ["list", "table", "inet", "hoaxconnect_route"]); }
    catch {
      if (!enable) return;
      await this.run("nft", ["add", "table", "inet", "hoaxconnect_route"]);
      await this.run("nft", ["add", "chain", "inet", "hoaxconnect_route", "postrouting",
        "{", "type", "nat", "hook", "postrouting", "priority", "srcnat", ";", "policy", "accept", ";", "}"]);
    }
    for (const peer of group.peers) {
      const marker = `hoaxconnect-route-${group.interfaceName}-${peer.nodeId.slice(0, 8)}`;
      const rules = await this.show("nft", ["-a", "list", "chain", "inet", "hoaxconnect_route", "postrouting"]);
      const line = rules.split("\n").find((row) => row.includes(`comment "${marker}"`));
      if (enable && !line) await this.run("nft", ["add", "rule", "inet", "hoaxconnect_route",
        "postrouting", "ip", "saddr", peer.clientCidr, "oifname", this.egressInterface,
        "masquerade", "comment", marker]);
      if (!enable && line) {
        const handle = line.match(/# handle (\d+)\s*$/)?.[1];
        assert(Boolean(handle), "Missing owned NAT handle");
        await this.run("nft", ["delete", "rule", "inet", "hoaxconnect_route",
          "postrouting", "handle", handle!]);
      }
    }
  }
  private async forwarding(group: Owned, enable: boolean) {
    const marker = `hoaxconnect-route-${group.interfaceName}`;
    const edges = group.role === "entry" ? [
      ["out", ["iifname", this.clientInterface, "oifname", group.interfaceName,
        "ip", "saddr", group.clientCidr!]],
      ["in", ["iifname", group.interfaceName, "oifname", this.clientInterface,
        "ip", "daddr", group.clientCidr!, "ct", "state", "established,related"]],
    ] : [
      ["out", ["iifname", group.interfaceName, "oifname", this.egressInterface]],
      ["in", ["iifname", this.egressInterface, "oifname", group.interfaceName,
        "ct", "state", "established,related"]],
    ];
    for (const [suffix, args] of edges as Array<[string, string[]]>) {
      await this.ownedRule(`${marker}-${suffix}`, enable ? "add" : "delete", args);
    }
  }
  private async route(group: Owned, enable: boolean) {
    if (group.role === "entry") {
      const pref = String(group.routingTable + 10000);
      const existing = await this.show("ip", ["-4", "rule", "show"]);
      const exact = existing.split("\n").some((line) => line.startsWith(`${pref}:`) &&
        line.includes(`from ${group.clientCidr} lookup ${group.routingTable}`));
      if (enable) {
        assert(!existing.split("\n").some((line) => line.startsWith(`${pref}:`) && !exact),
          "Route rule priority belongs to another service");
        const other = await this.show("ip", ["-4", "route", "show", "table", String(group.routingTable)]);
        assert(!other.trim() || other.trim() === `default dev ${group.interfaceName}`,
          "Route table belongs to another service");
        await this.run("ip", ["-4", "route", "replace", "default", "dev",
          group.interfaceName, "table", String(group.routingTable)]);
        if (!exact) await this.run("ip", ["-4", "rule", "add", "pref", pref,
          "from", group.clientCidr!, "lookup", String(group.routingTable)]);
      } else {
        if (exact) await this.run("ip", ["-4", "rule", "del", "pref", pref,
          "from", group.clientCidr!, "lookup", String(group.routingTable)]);
        const route = await this.show("ip", ["-4", "route", "show", "table", String(group.routingTable)]);
        if (route.trim() === `default dev ${group.interfaceName}` ||
            route.trim().startsWith(`default dev ${group.interfaceName} `)) {
          await this.run("ip", ["-4", "route", "del", "default", "dev", group.interfaceName,
            "table", String(group.routingTable)]);
        }
      }
    } else {
      for (const peer of group.peers) {
        const current = await this.show("ip", ["-4", "route", "show", peer.clientCidr]);
        if (enable) {
          assert(!current.trim() || current.includes(` dev ${group.interfaceName} `),
            "Client return route belongs to another service");
          await this.run("ip", ["-4", "route", "replace", peer.clientCidr, "dev", group.interfaceName]);
        } else if (current.includes(` dev ${group.interfaceName} `)) {
          await this.run("ip", ["-4", "route", "del", peer.clientCidr, "dev", group.interfaceName]);
        }
      }
    }
  }
  private async deactivate(group: Owned) {
    await this.route(group, false);
    await this.nat(group, false);
    await this.forwarding(group, false);
  }
  private async delete(group: Owned) {
    const server = this.probeServers.get(group.groupId);
    if (server) { server.close(); this.probeServers.delete(group.groupId); }
    await this.deactivate(group);
    try { await this.run("ip", ["link", "del", "dev", group.interfaceName]); }
    catch { await this.run("ip", ["link", "show", "dev", group.interfaceName]).then(
      () => { throw new Error("Owned interface could not be removed"); }, () => undefined); }
  }
  async reconcile(groups: RouteGroup[]) {
    assert(groups.length <= 100 && new Set(groups.map((g) => g.groupId)).size === groups.length &&
      new Set(groups.map((g) => g.interfaceName)).size === groups.length,
      "Invalid route group set");
    groups.forEach(validate);
    let owned = await this.owned();
    for (const old of [...owned]) {
      if (groups.some((g) => g.groupId === old.groupId && g.configVersion === old.configVersion)) continue;
      await this.delete(old);
      owned = owned.filter((item) => item.groupId !== old.groupId);
      await this.save(owned);
    }
    for (const group of groups) {
      let current = owned.find((item) => item.groupId === group.groupId);
      if (!current) {
        try { await this.run("ip", ["link", "show", "dev", group.interfaceName]);
          throw new Error("Route interface already exists without ownership"); }
        catch (error: any) { if (error?.message === "Route interface already exists without ownership") throw error; }
        current = { groupId: group.groupId, configVersion: group.configVersion,
          interfaceName: group.interfaceName, role: group.role, clientCidr: group.clientCidr,
          routingTable: group.routingTable, peers: group.peers };
        owned.push(current);
        await this.save(owned);
        await this.run("ip", ["link", "add", "dev", group.interfaceName, "type", "wireguard"]);
      } else {
        try { await this.run("ip", ["link", "show", "dev", group.interfaceName]); }
        catch { await this.run("ip", ["link", "add", "dev", group.interfaceName, "type", "wireguard"]); }
      }
      const privateKey = join(this.stateDir, "route-keys", `${group.groupId}.key`);
      await this.run("wg", ["set", group.interfaceName, "private-key", privateKey,
        "listen-port", group.role === "gateway" ? String(group.linkPort) : "0"]);
      await this.run("ip", ["address", "replace", group.linkAddress, "dev", group.interfaceName]);
      const endpoint = group.gatewayEndpoint.replace(/:\d+$/, `:${group.linkPort}`);
      const expected = group.role === "gateway" ? group.peers.map((p) => p.publicKey) : [group.gatewayPublicKey];
      const existing = await this.show("wg", ["show", group.interfaceName, "peers"]);
      for (const key of existing.trim().split(/\s+/).filter(Boolean)) {
        if (!expected.includes(key)) await this.run("wg", ["set", group.interfaceName, "peer", key, "remove"]);
      }
      if (group.role === "gateway") {
        for (const peer of group.peers) await this.run("wg", ["set", group.interfaceName,
          "peer", peer.publicKey, "allowed-ips", `${peer.linkIp}/32,${peer.clientCidr}`]);
      } else {
        await this.run("wg", ["set", group.interfaceName, "peer", group.gatewayPublicKey,
          "allowed-ips", "0.0.0.0/0", "endpoint", endpoint, "persistent-keepalive", "5"]);
      }
      await this.run("ip", ["link", "set", "dev", group.interfaceName, "up"]);
      if (group.role === "gateway" && !this.probeServers.has(group.groupId)) {
        const server = createSocket("udp4");
        server.on("message", (payload, remote) => {
          if (payload.length === 16 && group.peers.some((peer) => peer.linkIp === remote.address)) {
            server.send(payload, remote.port, remote.address);
          }
        });
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.bind(33655, group.gatewayLinkIp, resolve);
          });
          this.probeServers.set(group.groupId, server);
        } catch (error) { server.close(); throw error; }
      }
      if (group.phase === "active") {
        const forwarding = (await readFile("/proc/sys/net/ipv4/ip_forward", "utf8")).trim();
        assert(forwarding === "1", "Host IPv4 forwarding must be enabled");
        await this.forwarding(current, true);
        await this.nat(current, true);
        await this.route(current, true);
      } else await this.deactivate(current);
    }
  }
  async health(group: RouteGroup): Promise<boolean> {
    const dump = await this.show("wg", ["show", group.interfaceName, "latest-handshakes"]);
    const seen = new Map(dump.trim().split("\n").map((line) => line.split(/\s+/) as [string, string]));
    const keys = group.role === "gateway" ? group.peers.map((p) => p.publicKey) : [group.gatewayPublicKey];
    const handshakes = keys.every((key) => {
      const time = Number(seen.get(key));
      return Number.isFinite(time) && time > 0 && Date.now() / 1000 - time < 180;
    });
    if (!handshakes || group.role === "gateway") return handshakes;
    const probe = createSocket("udp4");
    const token = randomBytes(16);
    try {
      return await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 1500);
        probe.on("error", () => { clearTimeout(timeout); resolve(false); });
        probe.on("message", (payload, remote) => {
          if (remote.address === group.gatewayLinkIp && remote.port === 33655 &&
              payload.equals(token)) { clearTimeout(timeout); resolve(true); }
        });
        probe.bind(0, group.linkAddress.split("/")[0]!, () =>
          probe.send(token, 33655, group.gatewayLinkIp));
      });
    } finally { probe.close(); }
  }
  async withdraw() { await this.reconcile([]); }
}
