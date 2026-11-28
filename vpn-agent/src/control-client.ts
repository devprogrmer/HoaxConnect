import { createHash, randomBytes, sign, type KeyObject } from "node:crypto";

import type { DesiredPeer } from "./wireguard.js";
import type { RouteGroup } from "./route-transport.js";

type ControlOptions = {
  backendUrl: string;
  nodeId: string;
  credentialId: string;
  privateKey: KeyObject;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
};

type DesiredState = { peers: DesiredPeer[]; revocations: unknown[]; configVersion: number;
  routeGroupDrafts: Array<{ groupId: string; configVersion: string }>;
  routeGroups: RouteGroup[] };

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (["string", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  throw new Error("Unsupported control request value");
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ControlClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  constructor(private readonly options: ControlOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.baseDelayMs = options.baseDelayMs ?? 500;
  }

  private signedHeaders(method: string, path: string, body: unknown) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(18).toString("base64url");
    const hash = createHash("sha256").update(stableJson(body)).digest("hex");
    const canonical = ["HC-VPN-AGENT-V1", method, path, timestamp, nonce, hash].join("\n");
    return {
      "content-type": "application/json",
      "x-hc-node-id": this.options.nodeId,
      "x-hc-credential-id": this.options.credentialId,
      "x-hc-timestamp": timestamp,
      "x-hc-nonce": nonce,
      "x-hc-signature": sign(null, Buffer.from(canonical), this.options.privateKey).toString("base64"),
    };
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.options.backendUrl}${path}`, {
          method: "POST", headers: this.signedHeaders("POST", path, body), body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const payload = await response.json() as any;
        if (!response.ok) {
          const error = new Error(payload?.error?.message || `Control request failed (${response.status})`);
          if (response.status < 500) throw Object.assign(error, { retryable: false });
          throw error;
        }
        return payload.data as T;
      } catch (error: any) {
        lastError = error;
        if (error?.retryable === false || attempt === this.maxAttempts) throw error;
        await wait(Math.min(this.baseDelayMs * (2 ** (attempt - 1)), 5_000));
      }
    }
    throw lastError;
  }

  async heartbeat(input: {
    agentVersion: string; publicEndpoint: string; publicKey: string;
    capacityPeers: number; currentPeers: number; loadPercent: number;
  }) {
    return this.request<{ status: string; config_version: string }>("/api/v1/vpn-agent/heartbeat", {
      agent_version: input.agentVersion, public_endpoint: input.publicEndpoint,
      public_key: input.publicKey, capacity_peers: input.capacityPeers,
      current_peers: input.currentPeers, load_percent: input.loadPercent,
    });
  }

  async publishRouteGroupKey(groupId: string, configVersion: string, publicKey: string) {
    return this.request<{ group_id: string; node_id: string; config_version: string }>(
      "/api/v1/vpn-agent/route-group-key",
      { group_id: groupId, config_version: configVersion, public_key: publicKey },
    );
  }

  async reportRouteGroup(groupId: string, configVersion: string, healthy: boolean, detail: string) {
    return this.request("/api/v1/vpn-agent/route-group-report", {
      group_id: groupId, config_version: configVersion, healthy, detail,
    });
  }

  async desiredState(): Promise<DesiredState> {
    const data = await this.request<any>("/api/v1/vpn-agent/desired-state", {});
    return {
      configVersion: Number(data.config_version), revocations: data.revocations ?? [],
      routeGroupDrafts: (data.route_group_drafts ?? []).map((item: any) => ({
        groupId: item.group_id, configVersion: item.config_version,
      })),
      routeGroups: (data.route_groups ?? []).map((g: any): RouteGroup => ({
        groupId: g.group_id, configVersion: g.config_version, phase: g.phase,
        role: g.role, interfaceName: g.interface_name, linkAddress: g.link_address,
        gatewayLinkIp: g.gateway_link_ip, gatewayEndpoint: g.gateway_endpoint,
        linkPort: g.link_port, routingTable: g.routing_table, clientCidr: g.client_cidr,
        gatewayPublicKey: g.gateway_public_key,
        peers: g.peers.map((p: any) => ({ nodeId: p.node_id, publicKey: p.public_key,
          linkIp: p.link_ip, clientCidr: p.client_cidr })),
      })),
      peers: (data.peers ?? []).map((peer: any) => ({
        vpnSessionId: peer.vpn_session_id, publicKey: peer.public_key,
        allowedIp: peer.allowed_ip, configVersion: Number(peer.config_version),
        leaseExpiresAt: peer.lease_expires_at,
      })),
    };
  }
}
