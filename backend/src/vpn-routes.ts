import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticate } from "./auth.js";
import { pool } from "./db.js";
import { ApiError } from "./errors.js";
import { authenticateVpnAgent } from "./vpn-agent-auth.js";
import { authorizeVpnMultiSession, authorizeVpnSession, revokeVpnSessions } from "./vpn-control.js";
import { failUnhealthyGroups, ipv4Link } from "./route-group-transport.js";

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
const multiAuthorizeSchema = z.object({
  client_public_key: publicKey,
  path_count: z.number().int().min(2).max(5).default(2),
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
  app.post("/api/v1/vpn/authorize-multi", async (request) => {
    const auth = await authenticate(request);
    const input = multiAuthorizeSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const data = await authorizeVpnMultiSession(client, auth, {
        clientPublicKey: input.client_public_key, pathCount: input.path_count,
      });
      await client.query("COMMIT");
      return { data };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
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
    const guard = await pool.connect();
    try { await guard.query("BEGIN"); await failUnhealthyGroups(guard); await guard.query("COMMIT"); }
    catch (error) { await guard.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { guard.release(); }
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
    const transport = await pool.query<{
      group_id: string; config_version: string; gateway_node_id: string;
      link_cidr: string; link_port: number; routing_table: number; phase: string;
      gateway_endpoint: string; entry_node_ids: string[];
      node_ids: string[]; public_keys: string[]; client_cidrs: string[];
    }>(`SELECT g.id AS group_id, g.config_version::text, g.gateway_node_id,
               g.link_cidr::text, g.link_port, g.routing_table, g.phase,
               gateway.public_endpoint AS gateway_endpoint,
               array_agg(e.entry_node_id ORDER BY e.priority) AS entry_node_ids,
               array_agg(e.entry_node_id ORDER BY e.priority) || ARRAY[g.gateway_node_id] AS node_ids,
               array_agg(k.public_key ORDER BY e.priority) || ARRAY[gk.public_key] AS public_keys,
               array_agg(n.tunnel_cidr::text ORDER BY e.priority) AS client_cidrs
        FROM vpn_route_groups g
        JOIN vpn_nodes gateway ON gateway.id = g.gateway_node_id
        JOIN vpn_route_group_node_keys gk ON gk.group_id = g.id
          AND gk.node_id = g.gateway_node_id AND gk.config_version = g.config_version
        JOIN vpn_route_group_entries e ON e.group_id = g.id
        JOIN vpn_nodes n ON n.id = e.entry_node_id
        JOIN vpn_route_group_node_keys k ON k.group_id = g.id
          AND k.node_id = e.entry_node_id AND k.config_version = g.config_version
        WHERE g.phase IN ('staging','active') AND
          (g.gateway_node_id = $1 OR EXISTS (SELECT 1 FROM vpn_route_group_entries m
            WHERE m.group_id = g.id AND m.entry_node_id = $1))
        GROUP BY g.id, gateway.public_endpoint, gk.public_key
        HAVING count(*) = (SELECT count(*) FROM vpn_route_group_entries x WHERE x.group_id = g.id)
        ORDER BY g.id`, [identity.nodeId]);
    return { data: {
      config_version: node.rows[0]?.config_version ?? "1",
      peers: peers.rows,
      revocations: revocations.rows,
      route_group_drafts: routeGroupDrafts.rows,
      route_groups: transport.rows.map((g) => ({
        group_id: g.group_id, config_version: g.config_version, phase: g.phase,
        role: identity.nodeId === g.gateway_node_id ? "gateway" : "entry",
        interface_name: `hcr${g.group_id.replace(/-/g, "").slice(0, 11)}`,
        link_address: `${ipv4Link(g.link_cidr, identity.nodeId === g.gateway_node_id ? 1 :
          g.entry_node_ids.indexOf(identity.nodeId) + 2)}/24`,
        gateway_link_ip: ipv4Link(g.link_cidr, 1), gateway_endpoint: g.gateway_endpoint,
        link_port: g.link_port, routing_table: g.routing_table,
        client_cidr: identity.nodeId === g.gateway_node_id ? null :
          g.client_cidrs[g.entry_node_ids.indexOf(identity.nodeId)],
        peers: g.entry_node_ids.map((id, i) => ({
          node_id: id, public_key: g.public_keys[i],
          link_ip: ipv4Link(g.link_cidr, i + 2), client_cidr: g.client_cidrs[i],
        })),
        gateway_public_key: g.public_keys.at(-1),
      })),
    } };
  });
  app.post("/api/v1/vpn-agent/route-group-report", async (request) => {
    const identity = await authenticateVpnAgent(request);
    const input = z.object({ group_id: z.string().uuid(),
      config_version: z.string().regex(/^[1-9]\d*$/), healthy: z.boolean(),
      detail: z.string().max(200) }).strict().parse(request.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const group = await client.query<{ phase: string; config_version: string; gateway_node_id: string }>(
        `SELECT phase, config_version::text, gateway_node_id FROM vpn_route_groups
         WHERE id = $1 FOR UPDATE`, [input.group_id]);
      const current = group.rows[0];
      if (!current || current.config_version !== input.config_version ||
          !["staging", "active"].includes(current.phase)) {
        throw new ApiError(409, "ROUTE_REPORT_REJECTED", "Route group is not staged at this version.");
      }
      const member = await client.query(`SELECT 1 FROM vpn_route_group_entries
        WHERE group_id = $1 AND entry_node_id = $2`, [input.group_id, identity.nodeId]);
      if (identity.nodeId !== current.gateway_node_id && !member.rowCount) {
        throw new ApiError(403, "ROUTE_REPORT_FORBIDDEN", "Node is not a route group member.");
      }
      await client.query(`INSERT INTO vpn_route_group_reports
        (group_id, node_id, config_version, healthy, detail)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (group_id,node_id) DO UPDATE SET
          config_version = EXCLUDED.config_version, healthy = EXCLUDED.healthy,
          detail = EXCLUDED.detail, reported_at = now()`,
        [input.group_id, identity.nodeId, input.config_version, input.healthy, input.detail]);
      if (!input.healthy && current.phase === "active") {
        await client.query(`UPDATE vpn_route_groups SET phase = 'failed', enabled = false,
          failure_reason = 'Agent reported unhealthy transport' WHERE id = $1`, [input.group_id]);
      }
      await failUnhealthyGroups(client, input.group_id);
      await client.query("COMMIT");
      return { data: { accepted: true } };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
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

