import type { PoolClient } from "pg";

export type GroupRow = { id: string; gateway_node_id: string; config_version: string;
  link_cidr: string; link_port: number; routing_table: number; phase: string;
  staged_at: Date | null; entry_node_ids: string[] };

export async function failUnhealthyGroups(client: PoolClient, groupId?: string) {
  const result = await client.query<{ id: string }>(
    `SELECT g.id FROM vpn_route_groups g
     WHERE g.phase IN ('staging','active') AND ($1::uuid IS NULL OR g.id = $1)
       AND (g.link_cidr IS NULL OR g.link_port IS NULL OR
         EXISTS (SELECT 1 FROM vpn_nodes n
           WHERE (n.id = g.gateway_node_id OR EXISTS
             (SELECT 1 FROM vpn_route_group_entries e WHERE e.group_id = g.id AND e.entry_node_id = n.id))
             AND (n.enabled = false OR n.status <> 'online' OR
               n.last_seen_at IS NULL OR n.last_seen_at < now() - interval '90 seconds')) OR
         (g.phase = 'staging' AND g.staged_at < now() - interval '3 minutes') OR
         (g.phase = 'active' AND EXISTS (
           SELECT 1 FROM vpn_route_group_reports r WHERE r.group_id = g.id
             AND r.config_version = g.config_version AND
             (r.healthy = false OR r.reported_at < now() - interval '90 seconds'))))
     FOR UPDATE OF g`, [groupId ?? null],
  );
  for (const row of result.rows) {
    await client.query(`UPDATE vpn_route_groups SET phase = 'failed', enabled = false,
      failure_reason = 'Member heartbeat, transport health, or staging deadline failed'
      WHERE id = $1`, [row.id]);
  }
  return result.rows.map((row) => row.id);
}

export function ipv4Link(cidr: string, index: number) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/.exec(cidr);
  if (!match || match.slice(1).some((v) => Number(v) > 255) || index < 1 || index > 21) {
    throw new Error("Invalid link allocation");
  }
  return `${match[1]}.${match[2]}.${match[3]}.${index}`;
}
