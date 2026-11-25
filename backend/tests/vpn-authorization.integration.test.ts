import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const databaseUrl = process.env.HC_STAGE5_TEST_DATABASE_URL;
const require = createRequire(import.meta.url);
const { createElectronAuthOwner } = require("../../electron/auth/auth-owner.cjs");

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

test("per-device VPN authorization enforces entitlement and revocation", { skip: !databaseUrl }, async (t) => {
  const database = new URL(databaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(database.hostname));
  assert.match(decodeURIComponent(database.pathname), /(^|[-_/])test($|[-_])/i);
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: databaseUrl, DATABASE_SSL: "false", LOG_LEVEL: "silent",
    JWT_ACCESS_SECRET: "a".repeat(128), JWT_ISSUER: "https://api.hoaxconnect.test",
    JWT_AUDIENCE: "hoaxconnect-desktop", REFRESH_TOKEN_PEPPER: "b".repeat(128),
    REFRESH_RECOVERY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    EMAIL_VERIFICATION_REQUIRED: "false", ADMIN_ALLOWED_ORIGINS: "https://admin.hoaxconnect.test",
  });
  await import("../src/migrate.js");
  const [{ buildApp }, { pool }, { createVpnNodeEnrollmentToken }, { canonicalAgentRequest }, { hashPassword }] =
    await Promise.all([
      import("../src/app.js"), import("../src/db.js"),
      import("../src/vpn-node-bootstrap.js"), import("../src/vpn-agent-auth.js"),
      import("../src/security.js"),
    ]);
  const app = await buildApp();
  const userDataPath = mkdtempSync(join(tmpdir(), "hc-vpn-authz-test-"));
  const owner = createElectronAuthOwner({
    userDataPath, configuredBackendUrl: "http://127.0.0.1:3100",
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    },
    fetchImpl: (url: URL, options: RequestInit) => app.inject({
      method: options.method as any,
      url: `${url.pathname}${url.search}`,
      headers: options.headers as any,
      payload: options.body ? JSON.parse(String(options.body)) : undefined,
    }).then((response) => new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    })),
  });
  const ids: { user?: string; plan?: string; node?: string; admin?: string } = {};
  const password = "VPN-Authorization-Test-Password-123!";
  let subscriptionId = "";
  let token = "";
  let deviceId = "";
  const peerKey = `${"B".repeat(43)}=`;
  let desiredPeerKey = peerKey;
  const authorize = (payload: unknown = {
    client_public_key: peerKey, country_code: "DE", region: "fra",
  }) => app.inject({
    method: "POST", url: "/api/v1/vpn/authorize",
    headers: { authorization: `Bearer ${token}` }, payload,
  });

  try {
    const suffix = randomUUID().replaceAll("-", "");
    const registered = await owner.register({
      email: `vpn-${suffix}@example.test`, username: `vpn_${suffix}`,
      phone: "+15551234567", password,
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    ids.user = registered.state.user.id;
    deviceId = registered.state.device.id;
    token = owner.getAccessTokenForMainProcess();

    const plan = await pool.query<{ id: string }>(
      `INSERT INTO plans (code, name, duration_days, traffic_quota_bytes,
         device_limit, concurrent_session_limit, price_minor, currency, enabled)
       VALUES ($1, 'VPN Test', 30, 1000000, 2, 1, 0, 'USD', true) RETURNING id`,
      [`vpn-test-${suffix}`],
    );
    ids.plan = plan.rows[0]!.id;
    const subscription = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions (user_id, plan_id, status, starts_at, ends_at,
         traffic_quota_bytes, device_limit, concurrent_session_limit)
       VALUES ($1, $2, 'active', now() - interval '1 hour', now() + interval '30 days',
         1000000, 2, 1) RETURNING id`,
      [ids.user, ids.plan],
    );
    subscriptionId = subscription.rows[0]!.id;
    const node = await pool.query<{ id: string }>(
      `INSERT INTO vpn_nodes (name, country_code, region, hostname, public_endpoint,
         public_key, status, capacity_peers, current_peers, enabled, last_seen_at,
         tunnel_cidr, listen_port, dns_servers, egress_interface)
       VALUES ($1, 'DE', 'fra', $2, '198.51.100.20:51820', $3, 'online', 100, 0,
         true, now(), '10.88.0.0/24', 51820, ARRAY['1.1.1.1'::inet], 'eth0') RETURNING id`,
      [`vpn-node-${suffix}`, `vpn-node-${suffix}.example.test`, `${"C".repeat(43)}=`],
    );
    ids.node = node.rows[0]!.id;

    await t.test("lists only live VPN nodes for the authenticated desktop", async () => {
      const list = () => app.inject({
        method: "POST", url: "/api/v1/vpn/nodes",
        headers: { authorization: `Bearer ${token}` }, payload: {},
      });
      const available = await list();
      assert.equal(available.statusCode, 200, available.body);
      assert.deepEqual(available.json().data.nodes, [{
        id: ids.node,
        name: `vpn-node-${suffix}`,
        country_code: "DE",
        region: "fra",
        city: null,
        capacity_peers: 100,
        current_peers: 0,
        load_percent: 0,
      }]);

      await pool.query("UPDATE vpn_nodes SET last_seen_at = now() - interval '2 minutes' WHERE id = $1", [ids.node]);
      assert.deepEqual((await list()).json().data.nodes, []);
      await pool.query("UPDATE vpn_nodes SET last_seen_at = now() WHERE id = $1", [ids.node]);
    });

    await t.test("rejects invalid keys and missing, expired, or exhausted entitlement", async () => {
      assert.equal((await authorize({ client_public_key: "bad", country_code: "DE" })).statusCode, 400);
      await pool.query("UPDATE subscriptions SET status = 'cancelled' WHERE id = $1", [subscriptionId]);
      assert.equal((await authorize()).json().error.code, "VPN_SUBSCRIPTION_REQUIRED");
      await pool.query("UPDATE subscriptions SET status = 'active', ends_at = now() - interval '1 second' WHERE id = $1", [subscriptionId]);
      assert.equal((await authorize()).json().error.code, "VPN_SUBSCRIPTION_EXPIRED");
      await pool.query("UPDATE subscriptions SET ends_at = now() + interval '30 days', used_rx_bytes = 500000, used_tx_bytes = 500000 WHERE id = $1", [subscriptionId]);
      assert.equal((await authorize()).json().error.code, "VPN_QUOTA_EXHAUSTED");
      await pool.query("UPDATE subscriptions SET used_rx_bytes = 0, used_tx_bytes = 0 WHERE id = $1", [subscriptionId]);
    });

    await t.test("rejects unavailable nodes and moderated accounts or devices", async () => {
      for (const sql of [
        "UPDATE vpn_nodes SET enabled = false WHERE id = $1",
        "UPDATE vpn_nodes SET enabled = true, status = 'offline' WHERE id = $1",
        "UPDATE vpn_nodes SET status = 'online', last_seen_at = now() - interval '2 minutes' WHERE id = $1",
        "UPDATE vpn_nodes SET last_seen_at = now(), current_peers = capacity_peers WHERE id = $1",
      ]) {
        await pool.query(sql, [ids.node]);
        const response = await authorize();
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(response.json().error.code, "VPN_NODE_UNAVAILABLE");
      }
      await pool.query("UPDATE vpn_nodes SET current_peers = 0 WHERE id = $1", [ids.node]);
      for (const status of ["suspended", "banned"]) {
        await pool.query("UPDATE users SET status = $2 WHERE id = $1", [ids.user, status]);
        assert.equal((await authorize()).statusCode, 403);
      }
      await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [ids.user]);
      await pool.query("UPDATE devices SET banned_at = now() WHERE id = $1", [deviceId]);
      assert.equal((await authorize()).statusCode, 401);
      await pool.query("UPDATE devices SET banned_at = NULL, revoked_at = now() WHERE id = $1", [deviceId]);
      assert.equal((await authorize()).statusCode, 401);
      await pool.query("UPDATE devices SET revoked_at = NULL WHERE id = $1", [deviceId]);
    });

    let vpnSessionId = "";
    await t.test("allocates one lease and makes concurrent reconnects idempotent", async () => {
      const responses = await Promise.all([authorize(), authorize()]);
      for (const response of responses) assert.equal(response.statusCode, 200, response.body);
      const first = responses[0]!.json().data;
      const second = responses[1]!.json().data;
      assert.equal(first.vpn_session_id, second.vpn_session_id);
      assert.equal(first.client.assigned_ip, "10.88.0.2");
      assert.deepEqual(first.client.dns_servers, ["1.1.1.1"]);
      assert.equal(first.node.id, ids.node);
      assert.equal(first.node.endpoint, "198.51.100.20:51820");
      assert.equal(first.node.public_key, `${"C".repeat(43)}=`);
      assert.ok(Date.parse(first.lease_expires_at) > Date.now());
      vpnSessionId = first.vpn_session_id;
      const count = await pool.query("SELECT count(*)::int AS count FROM vpn_sessions WHERE device_id = $1", [deviceId]);
      assert.equal(count.rows[0].count, 1);
    });

    await t.test("renews at node capacity and reclaims an expired lease and address", async () => {
      await pool.query("UPDATE vpn_nodes SET current_peers = capacity_peers WHERE id = $1", [ids.node]);
      const renewed = await authorize();
      assert.equal(renewed.statusCode, 200, renewed.body);
      assert.equal(renewed.json().data.vpn_session_id, vpnSessionId);
      await pool.query("UPDATE vpn_nodes SET current_peers = 0 WHERE id = $1", [ids.node]);

      await pool.query(
        `UPDATE vpn_sessions SET created_at = now() - interval '10 minutes',
           lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [vpnSessionId],
      );
      desiredPeerKey = `${"G".repeat(43)}=`;
      const replacement = await authorize({
        client_public_key: desiredPeerKey, country_code: "DE", region: "fra",
      });
      assert.equal(replacement.statusCode, 200, replacement.body);
      assert.equal(replacement.json().data.client.assigned_ip, "10.88.0.2");
      const old = await pool.query(
        "SELECT status::text, disconnect_reason FROM vpn_sessions WHERE id = $1",
        [vpnSessionId],
      );
      assert.equal(old.rows[0].status, "expired");
      assert.equal(old.rows[0].disconnect_reason, "lease_expired");
      vpnSessionId = replacement.json().data.vpn_session_id;
    });

    const agentKeys = generateKeyPairSync("ed25519");
    let credentialId = "";
    await t.test("returns signed desired peer state and idempotent disconnect revocations", async () => {
      const enrollment = await createVpnNodeEnrollmentToken(ids.node!, 10);
      const enrolled = await app.inject({ method: "POST", url: "/api/v1/vpn-agent/enroll", payload: {
        node_id: ids.node,
        enrollment_token: enrollment.token,
        public_key_spki: agentKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      } });
      assert.equal(enrolled.statusCode, 201, enrolled.body);
      credentialId = enrolled.json().data.credential_id;
      const desiredBody = {};
      const path = "/api/v1/vpn-agent/desired-state";
      const signedHeaders = () => {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = randomBytes(18).toString("base64url");
        const bodyHash = createHash("sha256").update(stableJson(desiredBody)).digest("hex");
        assert.equal(canonicalAgentRequest({ method: "POST", path, timestamp, nonce, body: desiredBody }),
          `HC-VPN-AGENT-V1\nPOST\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`);
        return {
          "x-hc-node-id": ids.node!, "x-hc-credential-id": credentialId,
          "x-hc-timestamp": timestamp, "x-hc-nonce": nonce,
          "x-hc-signature": sign(null, Buffer.from(canonicalAgentRequest({ method: "POST", path, timestamp, nonce, body: desiredBody })), agentKeys.privateKey).toString("base64"),
        };
      };
      const desired = await app.inject({ method: "POST", url: path, headers: signedHeaders(), payload: desiredBody });
      assert.equal(desired.statusCode, 200, desired.body);
      assert.equal(desired.json().data.peers[0].vpn_session_id, vpnSessionId);
      assert.equal(desired.json().data.peers[0].public_key, desiredPeerKey);

      const disconnect = () => app.inject({ method: "POST", url: "/api/v1/vpn/disconnect",
        headers: { authorization: `Bearer ${token}` }, payload: {} });
      assert.equal((await disconnect()).statusCode, 200);
      assert.equal((await disconnect()).statusCode, 200);
      const after = await app.inject({ method: "POST", url: path, headers: signedHeaders(), payload: desiredBody });
      assert.equal(after.statusCode, 200, after.body);
      assert.equal(after.json().data.peers.length, 0);
      assert.ok(after.json().data.revocations.some(
        (revocation: { vpn_session_id: string }) => revocation.vpn_session_id === vpnSessionId,
      ));
    });

    await t.test("account moderation atomically revokes active VPN leases", async () => {
      const relogin = await owner.login({ identifier: `vpn_${suffix}`, password });
      assert.equal(relogin.ok, true, JSON.stringify(relogin));
      token = owner.getAccessTokenForMainProcess();
      const active = await authorize({ client_public_key: `${"E".repeat(43)}=`, country_code: "DE", region: "fra" });
      assert.equal(active.statusCode, 200, active.body);
      const activeId = active.json().data.vpn_session_id;

      const adminEmail = `vpn-admin-${suffix}@example.test`;
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO admin_accounts (email, email_normalized, password_hash, role)
         VALUES ($1, $1, $2, 'superadmin') RETURNING id`,
        [adminEmail, await hashPassword(password)],
      );
      ids.admin = inserted.rows[0]!.id;
      const origin = "https://admin.hoaxconnect.test";
      const login = await app.inject({ method: "POST", url: "/api/v1/admin/auth/login",
        headers: { origin, "x-forwarded-proto": "https" }, payload: { email: adminEmail, password } });
      assert.equal(login.statusCode, 200, login.body);
      const setCookie = [login.headers["set-cookie"]].flat();
      const cookie = setCookie.find((value) => value?.startsWith("hc_admin_session="))?.split(";", 1)[0];
      assert.ok(cookie);
      const csrf = login.json().data.csrf_token;
      const moderation = (action: "suspend" | "unsuspend") => app.inject({
        method: "POST", url: `/api/v1/admin/users/${ids.user}/status`,
        headers: { origin, "x-forwarded-proto": "https", cookie, "x-csrf-token": csrf },
        payload: { action, reason: "VPN policy integration test" },
      });
      const suspended = await moderation("suspend");
      assert.equal(suspended.statusCode, 200, suspended.body);
      const row = await pool.query("SELECT status::text, disconnect_reason FROM vpn_sessions WHERE id = $1", [activeId]);
      assert.equal(row.rows[0].status, "revoked");
      assert.equal(row.rows[0].disconnect_reason, "admin_suspend");
      const unsuspended = await moderation("unsuspend");
      assert.equal(unsuspended.statusCode, 200, unsuspended.body);
    });

    await t.test("logout-all atomically revokes an active VPN lease", async () => {
      const relogin = await owner.login({ identifier: `vpn_${suffix}`, password });
      assert.equal(relogin.ok, true, JSON.stringify(relogin));
      token = owner.getAccessTokenForMainProcess();
      const response = await authorize({ client_public_key: `${"D".repeat(43)}=`, country_code: "DE", region: "fra" });
      assert.equal(response.statusCode, 200, response.body);
      const activeId = response.json().data.vpn_session_id;
      const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout-all",
        headers: { authorization: `Bearer ${token}` }, payload: {} });
      assert.equal(logout.statusCode, 200, logout.body);
      const row = await pool.query("SELECT status::text, disconnect_reason FROM vpn_sessions WHERE id = $1", [activeId]);
      assert.equal(row.rows[0].status, "revoked");
      assert.equal(row.rows[0].disconnect_reason, "logout_all");
    });
  } finally {
    await app.close();
    if (ids.user) await pool.query("DELETE FROM users WHERE id = $1", [ids.user]);
    if (ids.admin) await pool.query("DELETE FROM admin_accounts WHERE id = $1", [ids.admin]);
    if (ids.node) await pool.query("DELETE FROM vpn_nodes WHERE id = $1", [ids.node]);
    if (ids.plan) await pool.query("DELETE FROM plans WHERE id = $1", [ids.plan]);
    await pool.end();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
