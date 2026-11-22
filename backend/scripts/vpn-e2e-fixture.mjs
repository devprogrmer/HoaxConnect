import { createHash, randomBytes, randomUUID } from "node:crypto";

import pg from "pg";

import { signAccessToken } from "../dist/security.js";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const pool = new pg.Pool({ connectionString: required("DATABASE_URL") });
const enrollmentToken = required("HC_E2E_ENROLLMENT_TOKEN");
const publicEndpoint = required("HC_E2E_PUBLIC_ENDPOINT");
const tunnelCidr = required("HC_E2E_TUNNEL_CIDR");
const egressInterface = required("HC_E2E_EGRESS_INTERFACE");
const runId = required("HC_E2E_RUN_ID").replace(/[^A-Za-z0-9]/g, "").slice(-20);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const user = await client.query(
    `INSERT INTO users (email, email_normalized, username, password_hash, email_verified_at)
     VALUES ($1, $1, $2, 'e2e-not-a-login-password', now()) RETURNING id, auth_version, role::text`,
    [`vpn-e2e-${runId}@example.test`, `vpne2e_${runId}`],
  );
  const userId = user.rows[0].id;
  const device = await client.query(
    `INSERT INTO devices (user_id, device_uid, name, os, client_version)
     VALUES ($1, $2, 'E2E namespace', 'Linux', 'stage5-e2e') RETURNING id`,
    [userId, `vpn-e2e-device-${runId}`],
  );
  const deviceId = device.rows[0].id;
  const sessionId = randomUUID();
  await client.query(
    `INSERT INTO sessions (id, family_id, user_id, device_id, refresh_token_hash,
       status, expires_at, proof_verified_at)
     VALUES ($1, $2, $3, $4, $5, 'active', now() + interval '1 hour', now())`,
    [sessionId, randomUUID(), userId, deviceId, randomBytes(32).toString("hex")],
  );
  const plan = await client.query(
    `INSERT INTO plans (code, name, duration_days, traffic_quota_bytes, device_limit,
       concurrent_session_limit, price_minor, currency, enabled)
     VALUES ($1, 'Stage 5 E2E', 1, 1000000000, 1, 1, 0, 'USD', true) RETURNING id`,
    [`vpn-e2e-${runId}`],
  );
  await client.query(
    `INSERT INTO subscriptions (user_id, plan_id, status, starts_at, ends_at,
       traffic_quota_bytes, device_limit, concurrent_session_limit)
     VALUES ($1, $2, 'active', now() - interval '1 minute', now() + interval '1 hour',
       1000000000, 1, 1)`,
    [userId, plan.rows[0].id],
  );
  const node = await client.query(
    `INSERT INTO vpn_nodes (name, country_code, region, hostname, public_endpoint,
       public_key, status, capacity_peers, current_peers, enabled, tunnel_cidr,
       listen_port, dns_servers, egress_interface)
     VALUES ($1, 'DE', 'e2e', $2, $3, $4, 'offline', 10, 0, true, $5,
       51999, ARRAY['1.1.1.1'::inet], $6) RETURNING id`,
    [`vpn-e2e-${runId}`, `vpn-e2e-${runId}.test`, publicEndpoint,
      `${"Z".repeat(43)}=`, tunnelCidr, egressInterface],
  );
  const nodeId = node.rows[0].id;
  await client.query(
    `INSERT INTO vpn_node_enrollment_tokens (vpn_node_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '15 minutes')`,
    [nodeId, createHash("sha256").update(enrollmentToken).digest("hex")],
  );
  await client.query("COMMIT");
  const accessToken = await signAccessToken({ sub: userId, sid: sessionId, did: deviceId,
    role: user.rows[0].role, auth_version: user.rows[0].auth_version });
  process.stdout.write(`NODE_ID=${nodeId}\nUSER_ID=${userId}\nDEVICE_ID=${deviceId}\nACCESS_TOKEN=${accessToken}\n`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

