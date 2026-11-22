import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";

import type { FastifyRequest } from "fastify";

import { pool } from "./db.js";
import { ApiError } from "./errors.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noncePattern = /^[A-Za-z0-9_-]{16,128}$/;
const signaturePattern = /^[A-Za-z0-9+/]{86}==$/;
const allowedClockSkewSeconds = 300;

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value) {
    throw new ApiError(
      401,
      "VPN_AGENT_AUTHENTICATION_FAILED",
      "VPN node authentication failed.",
    );
  }
  return value;
}

export function stableAgentJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableAgentJson).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableAgentJson(item)}`)
      .join(",")}}`;
  }
  throw new ApiError(400, "INVALID_REQUEST_BODY", "The request body is invalid.");
}

export function canonicalAgentRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: unknown;
}): string {
  const bodyHash = createHash("sha256")
    .update(stableAgentJson(input.body))
    .digest("hex");
  return [
    "HC-VPN-AGENT-V1",
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join("\n");
}

export async function authenticateVpnAgent(
  request: FastifyRequest,
): Promise<{ nodeId: string; credentialId: string }> {
  const nodeId = header(request, "x-hc-node-id");
  const credentialId = header(request, "x-hc-credential-id");
  const timestamp = header(request, "x-hc-timestamp");
  const nonce = header(request, "x-hc-nonce");
  const signature = header(request, "x-hc-signature");

  if (
    !uuidPattern.test(nodeId) ||
    !uuidPattern.test(credentialId) ||
    !/^\d{10}$/.test(timestamp) ||
    !noncePattern.test(nonce) ||
    !signaturePattern.test(signature)
  ) {
    throw new ApiError(
      401,
      "VPN_AGENT_AUTHENTICATION_FAILED",
      "VPN node authentication failed.",
    );
  }

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > allowedClockSkewSeconds) {
    throw new ApiError(
      401,
      "VPN_AGENT_REQUEST_EXPIRED",
      "The VPN node request timestamp is outside the allowed window.",
    );
  }

  const credentialResult = await pool.query<{
    public_key_spki: string;
  }>(
    `SELECT public_key_spki
     FROM vpn_node_credentials
     WHERE id = $1 AND vpn_node_id = $2 AND status = 'active'`,
    [credentialId, nodeId],
  );
  const credential = credentialResult.rows[0];
  if (!credential) {
    throw new ApiError(
      401,
      "VPN_AGENT_AUTHENTICATION_FAILED",
      "VPN node authentication failed.",
    );
  }

  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(credential.public_key_spki, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new ApiError(
      401,
      "VPN_AGENT_AUTHENTICATION_FAILED",
      "VPN node authentication failed.",
    );
  }

  const path = new URL(request.raw.url || request.url, "http://localhost").pathname;
  const canonical = canonicalAgentRequest({
    method: request.method,
    path,
    timestamp,
    nonce,
    body: request.body,
  });
  const signatureBytes = Buffer.from(signature, "base64");
  if (
    signatureBytes.length !== 64 ||
    !verify(null, Buffer.from(canonical), publicKey, signatureBytes)
  ) {
    throw new ApiError(
      401,
      "VPN_AGENT_AUTHENTICATION_FAILED",
      "VPN node authentication failed.",
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM vpn_node_request_nonces WHERE expires_at <= now()",
    );
    try {
      await client.query(
        `INSERT INTO vpn_node_request_nonces (
           credential_id, nonce, request_timestamp, expires_at
         ) VALUES ($1, $2, to_timestamp($3), now() + interval '10 minutes')`,
        [credentialId, nonce, timestampSeconds],
      );
    } catch (error: any) {
      if (error?.code === "23505") {
        throw new ApiError(
          409,
          "VPN_AGENT_REQUEST_REPLAYED",
          "The VPN node request has already been processed.",
        );
      }
      throw error;
    }
    await client.query(
      `UPDATE vpn_node_credentials SET last_used_at = now()
       WHERE id = $1`,
      [credentialId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return { nodeId, credentialId };
}
