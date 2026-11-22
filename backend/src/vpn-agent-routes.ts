import {
  createHash,
  createPublicKey,
} from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { pool } from "./db.js";
import { ApiError } from "./errors.js";
import { authenticateVpnAgent } from "./vpn-agent-auth.js";

const enrollmentSchema = z.object({
  node_id: z.string().uuid(),
  enrollment_token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  public_key_spki: z.string().min(24).max(512).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

const heartbeatSchema = z.object({
  agent_version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/),
  public_endpoint: z.string().min(3).max(255).refine((value) => {
    const match = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):([1-9][0-9]{0,4})$/.exec(value);
    return Boolean(match && Number(match[1]) <= 65535);
  }, "Invalid VPN endpoint"),
  public_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  capacity_peers: z.number().int().min(1).max(100_000),
  current_peers: z.number().int().min(0).max(100_000),
  load_percent: z.number().min(0).max(100),
}).strict().refine(
  (value) => value.current_peers <= value.capacity_peers,
  { message: "Current peers cannot exceed capacity", path: ["current_peers"] },
);

export async function registerVpnAgentRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/vpn-agent/enroll",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = enrollmentSchema.parse(request.body);
      const publicKeyDer = Buffer.from(input.public_key_spki, "base64");
      let publicKey;
      try {
        publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
      } catch {
        throw new ApiError(
          400,
          "VPN_NODE_PUBLIC_KEY_INVALID",
          "The VPN node public key is invalid.",
        );
      }
      if (
        publicKey.asymmetricKeyType !== "ed25519" ||
        publicKey.export({ type: "spki", format: "der" }).toString("base64") !==
          input.public_key_spki
      ) {
        throw new ApiError(
          400,
          "VPN_NODE_PUBLIC_KEY_INVALID",
          "The VPN node public key is invalid.",
        );
      }

      const tokenHash = createHash("sha256")
        .update(input.enrollment_token)
        .digest("hex");
      const fingerprint = createHash("sha256").update(publicKeyDer).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const token = await client.query<{ id: string }>(
          `SELECT id FROM vpn_node_enrollment_tokens
           WHERE vpn_node_id = $1 AND token_hash = $2
             AND used_at IS NULL AND expires_at > now()
           FOR UPDATE`,
          [input.node_id, tokenHash],
        );
        if (!token.rows[0]) {
          throw new ApiError(
            401,
            "VPN_NODE_ENROLLMENT_INVALID",
            "The VPN node enrollment request is invalid or expired.",
          );
        }

        let credential;
        try {
          credential = await client.query<{ id: string }>(
            `INSERT INTO vpn_node_credentials (
               vpn_node_id, public_key_spki, fingerprint_sha256
             ) VALUES ($1, $2, $3) RETURNING id`,
            [input.node_id, input.public_key_spki, fingerprint],
          );
        } catch (error: any) {
          if (error?.code === "23505") {
            throw new ApiError(
              409,
              "VPN_NODE_IDENTITY_EXISTS",
              "This VPN node identity is already enrolled.",
            );
          }
          throw error;
        }
        await client.query(
          `UPDATE vpn_node_enrollment_tokens SET used_at = now()
           WHERE id = $1`,
          [token.rows[0].id],
        );
        await client.query("COMMIT");
        reply.status(201);
        return {
          data: {
            node_id: input.node_id,
            credential_id: credential.rows[0]!.id,
            fingerprint_sha256: fingerprint,
          },
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post(
    "/api/v1/vpn-agent/heartbeat",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const identity = await authenticateVpnAgent(request);
      const input = heartbeatSchema.parse(request.body);
      const updated = await pool.query<{ status: string; agent_config_version: string }>(
        `UPDATE vpn_nodes
         SET status = 'online', agent_version = $2, public_endpoint = $3,
             public_key = $4, capacity_peers = $5, current_peers = $6,
             load_percent = $7, last_agent_ip = $8, last_seen_at = now(),
             updated_at = now()
         WHERE id = $1
         RETURNING status::text, agent_config_version::text`,
        [
          identity.nodeId,
          input.agent_version,
          input.public_endpoint,
          input.public_key,
          input.capacity_peers,
          input.current_peers,
          input.load_percent,
          request.ip,
        ],
      );
      if (!updated.rows[0]) {
        throw new ApiError(401, "VPN_AGENT_AUTHENTICATION_FAILED", "VPN node authentication failed.");
      }
      return {
        data: {
          status: updated.rows[0].status,
          config_version: updated.rows[0].agent_config_version,
        },
      };
    },
  );
}
