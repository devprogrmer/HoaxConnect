import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";

const databaseUrl = process.env.HC_STAGE5_TEST_DATABASE_URL;

test(
  "VPN control-plane schema enforces identity, replay, lease, and address uniqueness",
  { skip: !databaseUrl },
  async () => {
    const database = new URL(databaseUrl!);
    const databaseName = decodeURIComponent(database.pathname.slice(1));
    if (
      !["localhost", "127.0.0.1", "::1"].includes(database.hostname) ||
      !/(^|[-_])test($|[-_])/i.test(databaseName)
    ) {
      throw new Error(
        "Stage 5 integration tests require a loopback PostgreSQL database with 'test' in its name.",
      );
    }

    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: "false",
      JWT_ACCESS_SECRET: "a".repeat(128),
      JWT_ISSUER: "https://api.hoaxconnect.test",
      JWT_AUDIENCE: "hoaxconnect-desktop",
      REFRESH_TOKEN_PEPPER: "b".repeat(128),
      REFRESH_RECOVERY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });

    await import("../src/migrate.js");

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN");

    async function rejectsConstraint(sql: string, values: unknown[]) {
      const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      await assert.rejects(client.query(sql, values), (error: any) =>
        ["23505", "23514"].includes(error?.code),
      );
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }

    try {
      const tables = await client.query<{ name: string | null }>(
        `SELECT to_regclass('public.vpn_node_credentials')::text AS name
         UNION ALL SELECT to_regclass('public.vpn_node_request_nonces')::text
         UNION ALL SELECT to_regclass('public.vpn_sessions')::text`,
      );
      assert.deepEqual(
        tables.rows.map((row) => row.name).sort(),
        ["vpn_node_credentials", "vpn_node_request_nonces", "vpn_sessions"],
      );

      const node = await client.query<{ id: string }>(
        `INSERT INTO vpn_nodes (
           name, country_code, region, hostname, public_endpoint, public_key,
           capacity_peers, tunnel_cidr, listen_port
         ) VALUES ($1, 'DE', 'test', $2, '198.51.100.10:51820', $3, 10,
                   '10.77.0.0/24', 51820)
         RETURNING id`,
        [`stage5-${randomUUID()}`, `stage5-${randomUUID()}.example.test`, `node-${randomUUID()}`],
      );
      const nodeId = node.rows[0]!.id;

      const credential = await client.query<{ id: string }>(
        `INSERT INTO vpn_node_credentials (
           vpn_node_id, public_key_spki, fingerprint_sha256
         ) VALUES ($1, $2, $3) RETURNING id`,
        [nodeId, "c3RhZ2U1LWVkMjU1MTktc3BraQ==", "a".repeat(64)],
      );
      const credentialId = credential.rows[0]!.id;

      await rejectsConstraint(
        `INSERT INTO vpn_node_credentials (
           vpn_node_id, public_key_spki, fingerprint_sha256
         ) VALUES ($1, $2, $3)`,
        [nodeId, "c3RhZ2U1LWJhZC1zcGtp", "NOT-A-FINGERPRINT"],
      );

      await client.query(
        `INSERT INTO vpn_node_request_nonces (
           credential_id, nonce, request_timestamp, expires_at
         ) VALUES ($1, $2, now(), now() + interval '10 minutes')`,
        [credentialId, "stage5_nonce_1234567890"],
      );
      await rejectsConstraint(
        `INSERT INTO vpn_node_request_nonces (
           credential_id, nonce, request_timestamp, expires_at
         ) VALUES ($1, $2, now(), now() + interval '10 minutes')`,
        [credentialId, "stage5_nonce_1234567890"],
      );

      const user = await client.query<{ id: string }>(
        `INSERT INTO users (
           email, email_normalized, username, password_hash
         ) VALUES ($1, $1, $2, 'test-hash') RETURNING id`,
        [`stage5-${randomUUID()}@example.test`, `stage5_${randomUUID().replaceAll("-", "")}`],
      );
      const userId = user.rows[0]!.id;
      const device = await client.query<{ id: string }>(
        `INSERT INTO devices (
           user_id, device_uid, name, os, client_version
         ) VALUES ($1, $2, 'Test PC', 'windows', '0.3.10') RETURNING id`,
        [userId, `stage5-device-${randomUUID()}`],
      );
      const deviceId = device.rows[0]!.id;
      const plan = await client.query<{ id: string }>(
        `INSERT INTO plans (
           code, name, duration_days, traffic_quota_bytes, device_limit,
           concurrent_session_limit, price_minor, currency
         ) VALUES ($1, 'Stage 5 Test', 30, 1000000, 2, 1, 0, 'USD')
         RETURNING id`,
        [`stage5-${randomUUID()}`],
      );
      const subscription = await client.query<{ id: string }>(
        `INSERT INTO subscriptions (
           user_id, plan_id, status, starts_at, ends_at, traffic_quota_bytes,
           device_limit, concurrent_session_limit
         ) VALUES ($1, $2, 'active', now(), now() + interval '1 day',
                   1000000, 2, 1) RETURNING id`,
        [userId, plan.rows[0]!.id],
      );
      const peer = await client.query<{ id: string }>(
        `INSERT INTO vpn_peers (
           user_id, device_id, subscription_id, vpn_node_id, public_key,
           assigned_ip, status
         ) VALUES ($1, $2, $3, $4, $5, '10.77.0.2', 'active')
         RETURNING id`,
        [userId, deviceId, subscription.rows[0]!.id, nodeId, `peer-${randomUUID()}`],
      );

      const insertSession = `INSERT INTO vpn_sessions (
        user_id, device_id, subscription_id, vpn_node_id, vpn_peer_id,
        client_public_key, assigned_ip, status, lease_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now() + interval '5 minutes')`;
      const sessionValues = [
        userId, deviceId, subscription.rows[0]!.id, nodeId, peer.rows[0]!.id,
        `${"A".repeat(43)}=`, "10.77.0.2",
      ];
      await client.query(insertSession, sessionValues);

      await rejectsConstraint(insertSession, [
        ...sessionValues.slice(0, 5), `${"B".repeat(43)}=`, "10.77.0.3",
      ]);

      const secondDevice = await client.query<{ id: string }>(
        `INSERT INTO devices (
           user_id, device_uid, name, os, client_version
         ) VALUES ($1, $2, 'Second Test PC', 'windows', '0.3.10') RETURNING id`,
        [userId, `stage5-device-${randomUUID()}`],
      );
      await rejectsConstraint(insertSession, [
        userId, secondDevice.rows[0]!.id, subscription.rows[0]!.id, nodeId,
        peer.rows[0]!.id, `${"C".repeat(43)}=`, "10.77.0.2",
      ]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  },
);
