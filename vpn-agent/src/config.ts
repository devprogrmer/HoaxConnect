import { join } from "node:path";

import type { InterfaceConfig } from "./wireguard.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeName = /^[A-Za-z0-9_.:-]{1,32}$/;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number, minimum: number, maximum: number) {
  const value = process.env[name] ? Number(process.env[name]) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

export type AgentConfig = {
  backendUrl: string;
  nodeId: string;
  enrollmentToken?: string;
  stateDir: string;
  identityPath: string;
  managedPeersPath: string;
  interface: InterfaceConfig;
  publicEndpoint: string;
  capacityPeers: number;
  intervalMs: number;
  dryRun: boolean;
};

export function loadConfig(): AgentConfig {
  const backend = new URL(required("HOAXCONNECT_BACKEND_URL"));
  if (backend.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(backend.hostname)) {
    throw new Error("HOAXCONNECT_BACKEND_URL must use HTTPS");
  }
  const nodeId = required("HOAXCONNECT_VPN_NODE_ID");
  if (!uuid.test(nodeId)) throw new Error("HOAXCONNECT_VPN_NODE_ID is invalid");
  const stateDir = process.env.HOAXCONNECT_AGENT_STATE_DIR?.trim() || "/state";
  const name = process.env.HOAXCONNECT_WG_INTERFACE?.trim() || "hcx0";
  const egressInterface = required("HOAXCONNECT_EGRESS_INTERFACE");
  if (!safeName.test(name) || !safeName.test(egressInterface)) throw new Error("Network interface name is invalid");
  const enrollmentToken = process.env.HOAXCONNECT_ENROLLMENT_TOKEN?.trim();
  return {
    backendUrl: backend.origin,
    nodeId,
    ...(enrollmentToken ? { enrollmentToken } : {}),
    stateDir,
    identityPath: join(stateDir, "agent-identity.json"),
    managedPeersPath: join(stateDir, "managed-peers.json"),
    interface: {
      name,
      address: process.env.HOAXCONNECT_WG_ADDRESS?.trim() || "10.88.0.1/24",
      listenPort: integer("HOAXCONNECT_WG_PORT", 51820, 1, 65535),
      privateKeyPath: join(stateDir, "wireguard.key"),
      egressInterface,
    },
    publicEndpoint: required("HOAXCONNECT_PUBLIC_ENDPOINT"),
    capacityPeers: integer("HOAXCONNECT_CAPACITY_PEERS", 500, 1, 100_000),
    intervalMs: integer("HOAXCONNECT_RECONCILE_INTERVAL_MS", 15_000, 1_000, 300_000),
    dryRun: process.env.HOAXCONNECT_AGENT_DRY_RUN === "1",
  };
}

