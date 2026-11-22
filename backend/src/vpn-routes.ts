import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticate } from "./auth.js";
import { pool } from "./db.js";
import { authenticateVpnAgent } from "./vpn-agent-auth.js";
import { authorizeVpnSession, revokeVpnSessions } from "./vpn-control.js";

const publicKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const authorizeSchema = z.object({
  client_public_key: publicKey,
  country_code: z.string().regex(/^[A-Z]{2}$/).optional(),
  region: z.string().min(1).max(100).optional(),
}).strict();

export async function registerVpnRoutes(app: FastifyInstance) {
  app.post("/api/v1/vpn/authorize", async (request) => {
    const auth = await authenticate(request);
    const input = authorizeSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const data = await authorizeVpnSession(client, auth, {
        clientPublicKey: input.client_public_key,
        ...(input.country_code ? { countryCode: input.country_code } : {}),
        ...(input.region ? { region: input.region } : {}),
      });
      await client.query("COMMIT");
      return { data };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  });

  app.post("/api/v1/vpn/disconnect", async (request) => {
    const auth = await authenticate(request);
    z.object({}).strict().parse(request.body ?? {});
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const count = await revokeVpnSessions(client, { deviceId: auth.deviceId }, "user_disconnect");
      await client.query("COMMIT");
      return { data: { disconnected: count > 0 } };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  });

  app.post("/api/v1/vpn-agent/desired-state", async (request) => {
    const identity = await authenticateVpnAgent(request);
    z.object({}).strict().parse(request.body ?? {});
    const [node, peers, revocations] = await Promise.all([
      pool.query(`SELECT agent_config_version::text AS config_version
                  FROM vpn_nodes WHERE id = $1`, [identity.nodeId]),
      pool.query(
        `SELECT s.id AS vpn_session_id, p.id AS vpn_peer_id,
                p.public_key, host(p.assigned_ip) || '/32' AS allowed_ip,
                s.config_version, s.lease_expires_at
         FROM vpn_sessions s JOIN vpn_peers p ON p.id = s.vpn_peer_id
         WHERE s.vpn_node_id = $1 AND s.status IN ('provisioning', 'active')
           AND s.lease_expires_at > now() AND p.status IN ('pending', 'active')
         ORDER BY s.created_at`,
        [identity.nodeId],
      ),
      pool.query(
        `SELECT s.id AS vpn_session_id, s.vpn_peer_id,
                s.disconnect_reason AS reason, s.updated_at
         FROM vpn_sessions s
         WHERE s.vpn_node_id = $1
           AND s.status IN ('disconnected', 'revoked', 'failed', 'expired')
           AND s.updated_at > now() - interval '24 hours'
         ORDER BY s.updated_at`,
        [identity.nodeId],
      ),
    ]);
    return { data: {
      config_version: node.rows[0]?.config_version ?? "1",
      peers: peers.rows,
      revocations: revocations.rows,
    } };
  });
}

