import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentConfig } from "./config.js";

type StoredIdentity = {
  version: 1;
  nodeId: string;
  credentialId: string;
  privateKeyPem: string;
  publicKeySpki: string;
};

export type AgentIdentity = StoredIdentity & { privateKey: KeyObject };

function materialize(stored: StoredIdentity): AgentIdentity {
  return { ...stored, privateKey: createPrivateKey(stored.privateKeyPem) };
}

async function store(path: string, identity: StoredIdentity) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(identity)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function loadOrEnrollIdentity(
  config: AgentConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentIdentity> {
  try {
    const stored = JSON.parse(await readFile(config.identityPath, "utf8")) as StoredIdentity;
    if (stored.version !== 1 || stored.nodeId !== config.nodeId || !stored.credentialId || !stored.privateKeyPem) {
      throw new Error("Stored agent identity is invalid");
    }
    await chmod(config.identityPath, 0o600);
    return materialize(stored);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!config.enrollmentToken) throw new Error("HOAXCONNECT_ENROLLMENT_TOKEN is required for first enrollment");
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeySpki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const response = await fetchImpl(`${config.backendUrl}/api/v1/vpn-agent/enroll`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ node_id: config.nodeId, enrollment_token: config.enrollmentToken, public_key_spki: publicKeySpki }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json() as any;
  if (!response.ok || !payload?.data?.credential_id) {
    throw new Error(payload?.error?.message || `VPN node enrollment failed (${response.status})`);
  }
  const stored: StoredIdentity = {
    version: 1, nodeId: config.nodeId, credentialId: payload.data.credential_id,
    privateKeyPem, publicKeySpki,
  };
  await store(config.identityPath, stored);
  return materialize(stored);
}

