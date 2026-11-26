import type { PoolClient } from "pg";

import { ApiError } from "./errors.js";

export type VpnAuthorization = {
  vpn_session_id: string;
  node: { id: string; endpoint: string; public_key: string };
  client: { assigned_ip: string; dns_servers: string[] };
  lease_expires_at: string;
};

type AuthIdentity = { userId: string; deviceId: string; sessionId: string };

const liveStatuses = "('provisioning', 'active', 'disconnecting')";

type NodeRow = {
  id: string;
  public_endpoint: string;
  public_key: string;
  tunnel_cidr: string;
  dns_servers: string[];
  agent_config_version: string;
};

function result(row: NodeRow & {
  vpn_session_id: string;
  assigned_ip: string;
  lease_expires_at: Date;
}): VpnAuthorization {
  return {
    vpn_session_id: row.vpn_session_id,
    node: { id: row.id, endpoint: row.public_endpoint, public_key: row.public_key },
    client: { assigned_ip: row.assigned_ip, dns_servers: row.dns_servers },
    lease_expires_at: row.lease_expires_at.toISOString(),
  };
}

export async function revokeVpnSessions(
  client: PoolClient,
  filter: { userId?: string; deviceId?: string; authSessionId?: string },
  reason: string,
): Promise<number> {
  const clauses: string[] = [];
  const values: string[] = [];
  if (filter.userId) { values.push(filter.userId); clauses.push(`user_id = $${values.length}`); }
  if (filter.deviceId) { values.push(filter.deviceId); clauses.push(`device_id = $${values.length}`); }
  if (filter.authSessionId) { values.push(filter.authSessionId); clauses.push(`auth_session_id = $${values.length}`); }
  if (!clauses.length) throw new Error("A VPN session revocation scope is required");
  values.push(reason);
  const reasonParameter = `$${values.length}`;
  const revoked = await client.query<{ vpn_peer_id: string | null }>(
    `UPDATE vpn_sessions
     SET status = 'revoked', disconnected_at = COALESCE(disconnected_at, now()),
         disconnect_reason = ${reasonParameter}
     WHERE ${clauses.join(" AND ")}
       AND status IN ('provisioning', 'active', 'disconnecting')
     RETURNING vpn_peer_id`,
    values,
  );
  const peerIds = revoked.rows.flatMap((row) => row.vpn_peer_id ? [row.vpn_peer_id] : []);
  if (peerIds.length) {
    await client.query(
      `UPDATE vpn_peers SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()),
         revoke_reason = $2, updated_at = now()
       WHERE id = ANY($1::uuid[]) AND status IN ('pending', 'active')`,
      [peerIds, reason],
    );
  }
  return revoked.rowCount ?? 0;
}

export async function authorizeVpnSession(
  client: PoolClient,
  auth: AuthIdentity,
  input: { clientPublicKey: string; countryCode?: string; region?: string },
): Promise<VpnAuthorization> {
  const account = await client.query(
    `SELECT id FROM users
     WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
     FOR UPDATE`,
    [auth.userId],
  );
  if (!account.rowCount) {
    throw new ApiError(403, "ACCOUNT_UNAVAILABLE", "The account is not available for VPN access.");
  }

  const device = await client.query(
    `SELECT id FROM devices WHERE id = $1 AND user_id = $2
       AND revoked_at IS NULL AND banned_at IS NULL FOR UPDATE`,
    [auth.deviceId, auth.userId],
  );
  if (!device.rowCount) throw new ApiError(401, "SESSION_INVALID", "The device is no longer authorized.");

  const subscription = await client.query<{
    id: string; starts_at: Date | null; ends_at: Date | null;
    traffic_quota_bytes: string; used_rx_bytes: string; used_tx_bytes: string;
    concurrent_session_limit: number;
  }>(
    `SELECT id, starts_at, ends_at, traffic_quota_bytes::text,
            used_rx_bytes::text, used_tx_bytes::text, concurrent_session_limit
     FROM subscriptions WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [auth.userId],
  );
  const entitlement = subscription.rows[0];
  if (!entitlement) {
    throw new ApiError(403, "VPN_SUBSCRIPTION_REQUIRED", "An active subscription is required.");
  }
  const now = Date.now();
  if ((entitlement.starts_at && entitlement.starts_at.getTime() > now) ||
      (entitlement.ends_at && entitlement.ends_at.getTime() <= now)) {
    throw new ApiError(403, "VPN_SUBSCRIPTION_EXPIRED", "The subscription is not currently valid.");
  }
  if (BigInt(entitlement.used_rx_bytes) + BigInt(entitlement.used_tx_bytes) >=
      BigInt(entitlement.traffic_quota_bytes)) {
    throw new ApiError(403, "VPN_QUOTA_EXHAUSTED", "The subscription traffic quota is exhausted.");
  }

  const live = await client.query<NodeRow & {
    vpn_session_id: string; assigned_ip: string; lease_expires_at: Date;
    client_public_key: string; node_available: boolean;
  }>(
    `SELECT s.id AS vpn_session_id, host(s.assigned_ip) AS assigned_ip,
            s.lease_expires_at, s.client_public_key, n.id, n.public_endpoint,
            n.public_key, n.tunnel_cidr::text,
            ARRAY(SELECT host(value) FROM unnest(n.dns_servers) AS value) AS dns_servers,
            n.agent_config_version::text,
            (n.enabled AND n.status = 'online' AND
             n.last_seen_at > now() - interval '90 seconds') AS node_available
     FROM vpn_sessions s JOIN vpn_nodes n ON n.id = s.vpn_node_id
     WHERE s.device_id = $1 AND s.status IN ${liveStatuses}
       AND s.lease_expires_at > now()
     FOR UPDATE OF s`,
    [auth.deviceId],
  );
  const existing = live.rows[0];
  if (existing && existing.client_public_key === input.clientPublicKey && existing.node_available) {
    const renewed = await client.query<{ lease_expires_at: Date }>(
      `UPDATE vpn_sessions SET lease_expires_at = now() + interval '5 minutes',
         auth_session_id = $2 WHERE id = $1 RETURNING lease_expires_at`,
      [existing.vpn_session_id, auth.sessionId],
    );
    return result({ ...existing, lease_expires_at: renewed.rows[0]!.lease_expires_at });
  }
  if (existing) await revokeVpnSessions(client, { deviceId: auth.deviceId }, "client_reconfigured");

  const activeCount = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM vpn_sessions
     WHERE subscription_id = $1 AND status IN ${liveStatuses}
       AND lease_expires_at > now()`,
    [entitlement.id],
  );
  if ((activeCount.rows[0]?.count ?? 0) >= entitlement.concurrent_session_limit) {
    throw new ApiError(409, "VPN_CONCURRENT_LIMIT", "The concurrent VPN session limit is reached.");
  }

  const node = await client.query<NodeRow>(
    `SELECT id, public_endpoint, public_key, tunnel_cidr::text,
            ARRAY(SELECT host(value) FROM unnest(dns_servers) AS value) AS dns_servers,
            agent_config_version::text
     FROM vpn_nodes
     WHERE enabled AND status = 'online'
       AND last_seen_at > now() - interval '90 seconds'
       AND (current_peers < capacity_peers OR EXISTS (
         SELECT 1 FROM vpn_sessions stale
         WHERE stale.vpn_node_id = vpn_nodes.id
           AND stale.status IN ${liveStatuses}
           AND stale.lease_expires_at <= now()
       ))
       AND tunnel_cidr IS NOT NULL AND listen_port IS NOT NULL
       AND ($1::text IS NULL OR country_code = $1)
       AND ($2::text IS NULL OR region = $2)
     ORDER BY load_percent, current_peers, last_seen_at DESC
     LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [input.countryCode ?? null, input.region ?? null],
  );
  const selected = node.rows[0];
  if (!selected) throw new ApiError(503, "VPN_NODE_UNAVAILABLE", "No healthy VPN node is currently available.");

  const address = await client.query<{ assigned_ip: string }>(
    `SELECT host(network($1::cidr)::inet + candidate.host_index::bigint) AS assigned_ip
     FROM generate_series(
       2::bigint,
       ((1::bigint << (32 - masklen($1::cidr))) - 2)::bigint
     ) AS candidate(host_index)
     WHERE NOT EXISTS (
       SELECT 1 FROM vpn_sessions s
       WHERE s.vpn_node_id = $2
         AND s.assigned_ip = network($1::cidr)::inet + candidate.host_index::bigint
         AND s.status IN ${liveStatuses}
         AND s.lease_expires_at > now()
     )
     ORDER BY candidate.host_index LIMIT 1`,
    [selected.tunnel_cidr, selected.id],
  );
  if (!address.rows[0]) throw new ApiError(503, "VPN_ADDRESS_POOL_EXHAUSTED", "The VPN node address pool is exhausted.");

  const stale = await client.query<{ id: string; vpn_peer_id: string | null }>(
    `SELECT id, vpn_peer_id FROM vpn_sessions
     WHERE lease_expires_at <= now() AND status IN ${liveStatuses}
       AND (device_id = $1 OR (vpn_node_id = $2 AND assigned_ip = $3::inet))
     ORDER BY id FOR UPDATE`,
    [auth.deviceId, selected.id, address.rows[0].assigned_ip],
  );
  const staleSessionIds = stale.rows.map((row) => row.id);
  if (staleSessionIds.length) {
    await client.query(
      `UPDATE vpn_sessions SET status = 'expired', disconnected_at = now(),
         disconnect_reason = 'lease_expired'
       WHERE id = ANY($1::uuid[])`,
      [staleSessionIds],
    );
    const stalePeerIds = stale.rows.flatMap((row) => row.vpn_peer_id ? [row.vpn_peer_id] : []);
    if (stalePeerIds.length) {
      await client.query(
        `UPDATE vpn_peers SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()),
           revoke_reason = 'lease_expired', updated_at = now()
         WHERE id = ANY($1::uuid[]) AND status IN ('pending', 'active')`,
        [stalePeerIds],
      );
    }
  }

  const peer = await client.query<{ id: string }>(
    `INSERT INTO vpn_peers (user_id, device_id, subscription_id, vpn_node_id,
       public_key, assigned_ip, status, config_version)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING id`,
    [auth.userId, auth.deviceId, entitlement.id, selected.id, input.clientPublicKey,
      address.rows[0].assigned_ip, Number(selected.agent_config_version)],
  );
  const session = await client.query<{ id: string; lease_expires_at: Date }>(
    `INSERT INTO vpn_sessions (user_id, device_id, auth_session_id, subscription_id,
       vpn_node_id, vpn_peer_id, client_public_key, assigned_ip, status,
       config_version, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'provisioning', $9,
       now() + interval '5 minutes') RETURNING id, lease_expires_at`,
    [auth.userId, auth.deviceId, auth.sessionId, entitlement.id, selected.id,
      peer.rows[0]!.id, input.clientPublicKey, address.rows[0].assigned_ip,
      Number(selected.agent_config_version)],
  );
  return result({ ...selected, vpn_session_id: session.rows[0]!.id,
    assigned_ip: address.rows[0].assigned_ip,
    lease_expires_at: session.rows[0]!.lease_expires_at });
}

