import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticate } from "./auth.js";
import { pool } from "./db.js";
import { ApiError } from "./errors.js";
import { authenticateVpnAgent } from "./vpn-agent-auth.js";
import { authorizeVpnSession, revokeVpnSessions } from "./vpn-control.js";

const publicKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const routeKeySchema = z.object({
  group_id: z.string().uuid(),
  config_version: z.string().regex(/^[1-9]\d*$/),
  public_key: publicKey,
}).strict();

const authorizeSchema = z.object({
  client_public_key: publicKey,
  country_code: z.string().regex(/^[A-Z]{2}$/).optional(),
  region: z.string().min(1).max(100).optional(),
}).strict();

export async function registerVpnRoutes(app: FastifyInstance) {
  app.post("/api/v1/vpn/nodes", async (request) => {
    await authenticate(request);
    z.object({}).strict().parse(request.body ?? {});
    const result = await pool.query(
      `SELECT id, name, country_code, region, city,
              capacity_peers, current_peers,
              CASE WHEN capacity_peers > 0
                THEN least(100, round(current_peers * 100.0 / capacity_peers)::int)
                ELSE 0
              END AS load_percent
       FROM vpn_nodes
       WHERE enabled = true AND status = 'online'
         AND last_seen_at > now() - interval '90 seconds'
         AND (capacity_peers = 0 OR current_peers < capacity_peers)
       ORDER BY load_percent, country_code, region, name`,
    );
    return { data: { nodes: result.rows } };
  });

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
    const [node, peers, revocations, routeGroupDrafts] = await Promise.all([
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
      pool.query(
        `SELECT g.id AS group_id, g.config_version::text
         FROM vpn_route_groups g
         WHERE g.enabled = false
           AND (g.gateway_node_id = $1 OR EXISTS (
             SELECT 1 FROM vpn_route_group_entries e
             WHERE e.group_id = g.id AND e.entry_node_id = $1
           ))
         ORDER BY g.id`, [identity.nodeId],
      ),
    ]);
    return { data: {
      config_version: node.rows[0]?.config_version ?? "1",
      peers: peers.rows,
      revocations: revocations.rows,
      route_group_drafts: routeGroupDrafts.rows,
    } };
  });
  app.post("/api/v1/vpn-agent/route-group-key", async (request) => {
    const identity = await authenticateVpnAgent(request);
    const input = routeKeySchema.parse(request.body);
    const result = await pool.query(
      `WITH allowed AS (
         SELECT g.id, g.config_version FROM vpn_route_groups g
         WHERE g.id = $1 AND g.config_version = $2::bigint AND g.enabled = false
           AND (g.gateway_node_id = $3 OR EXISTS (
             SELECT 1 FROM vpn_route_group_entries e
             WHERE e.group_id = g.id AND e.entry_node_id = $3
           ))
         FOR SHARE
       )
       INSERT INTO vpn_route_group_node_keys
         (group_id, node_id, config_version, public_key)
       SELECT id, $3::uuid, config_version, $4 FROM allowed
       ON CONFLICT (group_id, node_id) DO UPDATE
         SET config_version = EXCLUDED.config_version,
             public_key = EXCLUDED.public_key, reported_at = now()
       WHERE vpn_route_group_node_keys.config_version < EXCLUDED.config_version
          OR vpn_route_group_node_keys.public_key = EXCLUDED.public_key
       RETURNING group_id, node_id, config_version::text`,
      [input.group_id, input.config_version, identity.nodeId, input.public_key],
    );
    if (!result.rowCount) {
      throw new ApiError(409, "ROUTE_GROUP_KEY_REJECTED",
        "Route group is inactive, stale, or this node is not a member.");
    }
    return { data: result.rows[0] };
  });

}

