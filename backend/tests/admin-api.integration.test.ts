import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const databaseUrl =
  process.env.HC_STAGE2D_TEST_DATABASE_URL;
const integrationOptions = { skip: !databaseUrl };
const origin = "https://admin.hoaxconnect.test";
const emailPrefix = `admin-stage2d-${randomUUID()}`;
const password = "Stage2D-Admin-Test-Password-123!";

let app: any;
let pool: any;
let accountIds: string[] = [];
let nodeIds: string[] = [];
let userId = "";
let roleEmails: Record<string, string> = {};
let loginClientIp = 1;

before(async () => {
  if (!databaseUrl) return;

  const database = new URL(databaseUrl);
  const databaseName = decodeURIComponent(database.pathname.slice(1));
  if (
    !["localhost", "127.0.0.1", "::1"].includes(database.hostname) ||
    !/(^|[-_])test($|[-_])/i.test(databaseName)
  ) {
    throw new Error(
      "Admin integration tests only run on loopback PostgreSQL databases with 'test' in the database name.",
    );
  }

  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_SSL = "false";
  process.env.JWT_ACCESS_SECRET = "a".repeat(128);
  process.env.JWT_ISSUER = "https://api.hoaxconnect.test";
  process.env.JWT_AUDIENCE = "hoaxconnect-desktop";
  process.env.REFRESH_TOKEN_PEPPER = "b".repeat(128);
  process.env.REFRESH_RECOVERY_ENCRYPTION_KEY =
    Buffer.alloc(32, 7).toString("base64");
  process.env.ADMIN_ALLOWED_ORIGINS = origin;
  process.env.CORS_ALLOWED_ORIGINS = origin;

  await import("../src/migrate.js");
  const [appModule, dbModule, securityModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("../src/security.js"),
  ]);

  app = await appModule.buildApp();
  pool = dbModule.pool;
  const passwordHash = await securityModule.hashPassword(password);

  for (const role of ["superadmin", "admin", "support", "read_only"]) {
    const email = `${emailPrefix}-${role}@example.test`;
    roleEmails[role] = email;
    const result = await pool.query(
      `INSERT INTO admin_accounts (
         email, email_normalized, password_hash, role
       ) VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [email, email.toLowerCase(), passwordHash, role],
    );
    accountIds.push(result.rows[0].id);
  }

  const user = await pool.query(
    `INSERT INTO users (email, email_normalized, username, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      `${emailPrefix}-user@example.test`,
      `${emailPrefix}-user@example.test`,
      `${emailPrefix.slice(0, 24)}`,
      passwordHash,
    ],
  );
  userId = user.rows[0].id;
});

after(async () => {
  if (!databaseUrl || !pool) return;

  if (userId) {
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  }
  if (accountIds.length) {
    await pool.query(
      "DELETE FROM admin_accounts WHERE id = ANY($1::uuid[])",
      [accountIds],
    );
  }
  if (nodeIds.length) {
    await pool.query("DELETE FROM vpn_nodes WHERE id = ANY($1::uuid[])", [nodeIds]);
  }
  await app?.close();
  await pool.end();
});

function requestHeaders(extra: Record<string, string> = {}) {
  return {
    origin,
    "x-forwarded-proto": "https",
    ...extra,
  };
}

async function login(role: string) {
  const clientIp = `198.51.100.${loginClientIp++}`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/auth/login",
    headers: requestHeaders({ "x-forwarded-for": clientIp }),
    payload: { email: roleEmails[role], password },
  });

  assert.equal(response.statusCode, 200, response.body);
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const sessionCookie = cookies.find((value) =>
    value.startsWith("hc_admin_session=")
  );
  const csrfCookie = cookies.find((value) => value.startsWith("hc_admin_csrf="));
  assert.ok(sessionCookie);
  assert.ok(csrfCookie);
  assert.match(sessionCookie, /; HttpOnly/);
  assert.match(sessionCookie, /; Secure/);
  assert.match(csrfCookie, /; SameSite=Strict/);
  assert.match(csrfCookie, /; Secure/);

  return {
    cookie: sessionCookie.split(";", 1)[0],
    csrf: response.json().data.csrf_token as string,
    body: response.json(),
  };
}

test(
  "Admin login creates a secure scoped session and returns no password material",
  integrationOptions,
  async () => {
    const session = await login("superadmin");
    assert.match(String(session.body.data.role), /superadmin/);
    assert.equal(JSON.stringify(session.body).includes(password), false);
    assert.match(
      String(session.cookie),
      /^hc_admin_session=[A-Za-z0-9_-]{43}$/,
    );

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/admin/auth/me",
      headers: requestHeaders({ cookie: session.cookie }),
    });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().data.email, roleEmails.superadmin);
    assert.equal(JSON.stringify(me.json()).includes("password_hash"), false);
  },
);

test(
  "Admin state changes require CSRF and are denied by the API for support and read-only roles",
  integrationOptions,
  async () => {
    const support = await login("support");
    const readOnly = await login("read_only");
    const route = `/api/v1/admin/users/${userId}/status`;
    const payload = { action: "ban", reason: "verified policy abuse" };

    const missingCsrf = await app.inject({
      method: "POST",
      url: route,
      headers: requestHeaders({ cookie: support.cookie }),
      payload,
    });
    assert.equal(missingCsrf.statusCode, 403, missingCsrf.body);

    for (const session of [support, readOnly]) {
      const denied = await app.inject({
        method: "POST",
        url: route,
        headers: requestHeaders({
          cookie: session.cookie,
          "x-csrf-token": session.csrf,
        }),
        payload,
      });
      assert.equal(denied.statusCode, 403, denied.body);
    }
  },
);

test(
  "an Admin marked as MFA-enabled cannot sign in with only a password",
  integrationOptions,
  async () => {
    const email = roleEmails.read_only;
    await pool.query(
      `UPDATE admin_accounts SET mfa_enabled = true,
         mfa_secret_ciphertext = decode('01', 'hex')
       WHERE email_normalized = $1`,
      [email.toLowerCase()],
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/auth/login",
        headers: requestHeaders(),
        payload: { email, password },
      });
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().error.code, "ADMIN_MFA_REQUIRED");
      assert.equal(response.headers["set-cookie"], undefined);
    } finally {
      await pool.query(
        `UPDATE admin_accounts SET mfa_enabled = false,
           mfa_secret_ciphertext = NULL, mfa_enrolled_at = NULL
         WHERE email_normalized = $1`,
        [email.toLowerCase()],
      );
    }
  },
);

test(
  "superadmin ban revokes sessions and records an auditable reason",
  integrationOptions,
  async () => {
    const superadmin = await login("superadmin");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${userId}/status`,
      headers: requestHeaders({
        cookie: superadmin.cookie,
        "x-csrf-token": superadmin.csrf,
      }),
      payload: {
        action: "ban",
        reason: "verified abuse report",
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    const user = await pool.query(
      "SELECT status::text FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(user.rows[0].status, "banned");

    const audit = await pool.query(
      `SELECT action, reason
       FROM admin_audit_logs
       WHERE resource_type = 'user' AND resource_id = $1
         AND admin_email = $2
       ORDER BY id DESC
       LIMIT 1`,
      [userId, roleEmails.superadmin],
    );
    assert.equal(audit.rows[0]?.action, "user.ban");
    assert.equal(audit.rows[0]?.reason, "verified abuse report");

    const blockedLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifier: `${emailPrefix}-user@example.test`,
        password,
        device: {
          uid: randomUUID(), name: "Test Desktop", os: "windows",
          platform: "win32", os_version: "11", architecture: "x64",
          client_version: "0.3.11", public_key_spki: "a".repeat(64),
        },
      },
    });
    assert.equal(blockedLogin.statusCode, 403, blockedLogin.body);
    assert.equal(blockedLogin.json().error.code, "ACCOUNT_BANNED");
    assert.equal(blockedLogin.json().error.message, "verified abuse report");

    const unban = await app.inject({
      method: "POST", url: `/api/v1/admin/users/${userId}/status`,
      headers: requestHeaders({ cookie: superadmin.cookie, "x-csrf-token": superadmin.csrf }),
      payload: { action: "unban", reason: "review completed; restore access" },
    });
    assert.equal(unban.statusCode, 200, unban.body);
    assert.equal(unban.json().data.status, "active");

    const suspend = await app.inject({
      method: "POST", url: `/api/v1/admin/users/${userId}/status`,
      headers: requestHeaders({ cookie: superadmin.cookie, "x-csrf-token": superadmin.csrf }),
      payload: { action: "suspend", reason: "temporary review is required" },
    });
    assert.equal(suspend.statusCode, 200, suspend.body);
    const unsuspend = await app.inject({
      method: "POST", url: `/api/v1/admin/users/${userId}/status`,
      headers: requestHeaders({ cookie: superadmin.cookie, "x-csrf-token": superadmin.csrf }),
      payload: { action: "unsuspend", reason: "temporary review has finished" },
    });
    assert.equal(unsuspend.statusCode, 200, unsuspend.body);
    assert.equal(unsuspend.json().data.status, "active");
  },
);

test(
  "updating a missing plan returns not found instead of creating it",
  integrationOptions,
  async () => {
    const superadmin = await login("superadmin");
    const missingPlanId = randomUUID();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plans/${missingPlanId}`,
      headers: requestHeaders({
        cookie: superadmin.cookie,
        "x-csrf-token": superadmin.csrf,
      }),
      payload: {
        code: `missing-${randomUUID().slice(0, 8)}`,
        name: "Must not be created",
        duration_days: 30,
        traffic_quota_bytes: "1073741824",
        device_limit: 1,
        concurrent_session_limit: 1,
        price_irr: "0",
        enabled: false,
        reason: "test nonexistent plan update",
      },
    });

    assert.equal(response.statusCode, 404, response.body);
    const check = await pool.query("SELECT id FROM plans WHERE id = $1", [missingPlanId]);
    assert.equal(check.rowCount, 0);
  },
);

test(
  "traffic reporting is permission-gated, paginated, and audited",
  integrationOptions,
  async () => {
    const device = await pool.query(
      `INSERT INTO devices (user_id, device_uid, name, os, client_version)
       VALUES ($1, $2, 'Isolated telemetry device', 'windows', 'test')
       RETURNING id`,
      [userId, `admin-test-${randomUUID()}`],
    );
    const deviceId = device.rows[0].id as string;
    const usage = await pool.query(
      `INSERT INTO traffic_usage (
         user_id, device_id, period_date, period_start, period_end,
         rx_bytes, tx_bytes, source
       ) VALUES ($1, $2, current_date, now() - interval '1 hour', now(), 123, 456, 'admin-test')
       RETURNING id`,
      [userId, deviceId],
    );
    const day = await pool.query("SELECT current_date::text AS day");

    try {
      const admin = await login("admin");
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/traffic?from=${day.rows[0].day}&to=${day.rows[0].day}&search=${emailPrefix}`,
        headers: requestHeaders({ cookie: admin.cookie }),
      });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().data.total, 1);
      assert.equal(response.json().data.items[0].user_id, userId);
      assert.equal(response.json().data.items[0].rx_bytes, "123");
      assert.equal(response.json().data.items[0].tx_bytes, "456");
      assert.equal(response.json().data.items[0].total_bytes, "579");

      const audit = await pool.query(
        `SELECT action FROM admin_audit_logs
         WHERE admin_email = $1 AND action = 'telemetry.traffic.read'
         ORDER BY id DESC LIMIT 1`,
        [roleEmails.admin],
      );
      assert.equal(audit.rows[0]?.action, "telemetry.traffic.read");

      for (const role of ["support", "read_only"]) {
        const session = await login(role);
        const denied = await app.inject({
          method: "GET",
          url: "/api/v1/admin/traffic",
          headers: requestHeaders({ cookie: session.cookie }),
        });
        assert.equal(denied.statusCode, 403, `${role}: ${denied.body}`);
      }

      const support = await login("support");
      const alerts = await app.inject({
        method: "GET",
        url: "/api/v1/admin/alerts",
        headers: requestHeaders({ cookie: support.cookie }),
      });
      assert.equal(alerts.statusCode, 200, alerts.body);
      assert.ok(Array.isArray(alerts.json().data));
    } finally {
      await pool.query("DELETE FROM traffic_usage WHERE id = $1", [usage.rows[0].id]);
      await pool.query("DELETE FROM devices WHERE id = $1", [deviceId]);
    }
  },
);

test(
  "sensitive account and Admin-history reads are audited",
  integrationOptions,
  async () => {
    const operator = await login("admin");
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${userId}`,
      headers: requestHeaders({ cookie: operator.cookie }),
    });
    assert.equal(detail.statusCode, 200, detail.body);

    const superadmin = await login("superadmin");
    for (const route of ["/api/v1/admin/security/logins", "/api/v1/admin/admins"]) {
      const response = await app.inject({
        method: "GET",
        url: route,
        headers: requestHeaders({ cookie: superadmin.cookie }),
      });
      assert.equal(response.statusCode, 200, response.body);
    }

    const audit = await pool.query(
      `SELECT action, resource_type FROM admin_audit_logs
       WHERE admin_email = ANY($1::text[])
         AND action = ANY($2::text[])`,
      [
        [roleEmails.admin, roleEmails.superadmin],
        ["user.detail.read", "admin.login_history.read", "admin.accounts.read"],
      ],
    );
    assert.deepEqual(
      new Set(audit.rows.map((row: { action: string }) => row.action)),
      new Set(["user.detail.read", "admin.login_history.read", "admin.accounts.read"]),
    );
  },
);

test(
  "node inventory creation cannot claim an online or enabled node",
  integrationOptions,
  async () => {
    const superadmin = await login("superadmin");
    const hostname = `admin-test-${randomUUID().slice(0, 12)}.invalid`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/nodes",
      headers: requestHeaders({
        cookie: superadmin.cookie,
        "x-csrf-token": superadmin.csrf,
      }),
      payload: {
        name: "Isolated test node",
        country_code: "ZZ",
        region: "Test",
        hostname,
        public_endpoint: `${hostname}:51820`,
        public_key: randomBytes(32).toString("base64"),
        capacity_peers: 10,
        reason: "isolated admin integration test",
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    const node = response.json().data as { id: string; status: string; enabled: boolean };
    nodeIds.push(node.id);
    assert.equal(node.status, "offline");
    assert.equal(node.enabled, false);

    const cannotClaimOnline = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/nodes/${node.id}`,
      headers: requestHeaders({
        cookie: superadmin.cookie,
        "x-csrf-token": superadmin.csrf,
      }),
      payload: { status: "online", reason: "must reject unverified status" },
    });
    assert.equal(cannotClaimOnline.statusCode, 400, cannotClaimOnline.body);

    const disable = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/nodes/${node.id}`,
      headers: requestHeaders({
        cookie: superadmin.cookie,
        "x-csrf-token": superadmin.csrf,
      }),
      payload: { status: "disabled", reason: "disable isolated test node" },
    });
    assert.equal(disable.statusCode, 200, disable.body);
    assert.equal(disable.json().data.status, "disabled");
    assert.equal(disable.json().data.enabled, false);

    const cannotEnableDisabled = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/nodes/${node.id}`,
      headers: requestHeaders({
        cookie: superadmin.cookie,
        "x-csrf-token": superadmin.csrf,
      }),
      payload: { enabled: true, reason: "must reject inconsistent state" },
    });
    assert.equal(cannotEnableDisabled.statusCode, 409, cannotEnableDisabled.body);
  },
);

test("route group topology edits are audited, versioned, and reject stale updates", integrationOptions, async () => {
  const operator = await login("superadmin");
  const ids: string[] = [];
  let groupId = "";
  try {
    for (const country of ["TR", "IR", "IR"]) {
      const node = await pool.query(
        `INSERT INTO vpn_nodes(name, country_code, region, hostname, public_endpoint,
           public_key, capacity_peers, enabled, status)
         VALUES ($1, $2, 'test', $3, '198.51.100.4:51820', $4, 10, false, 'offline')
         RETURNING id`,
        [`route-${randomUUID()}`, country, `${randomUUID()}.example.test`, randomBytes(32).toString("base64")],
      );
      ids.push(node.rows[0].id);
    }
    const headers = requestHeaders({ cookie: operator.cookie, "x-csrf-token": operator.csrf });
    const created = await app.inject({ method: "POST", url: "/api/v1/admin/route-groups",
      headers, payload: { name: `test-${randomUUID()}`, gateway_node_id: ids[0],
        entry_node_ids: [ids[1]], reason: "Create test topology" } });
    assert.equal(created.statusCode, 200, created.body);
    groupId = created.json().data.id;
    assert.equal(created.json().data.enabled, false);
    const update = { name: `test-${randomUUID()}`, gateway_node_id: ids[0],
      entry_node_ids: [ids[2], ids[1]], config_version: "1", reason: "Update test topology" };
    const changed = await app.inject({ method: "PATCH", url: `/api/v1/admin/route-groups/${groupId}`,
      headers, payload: update });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().data.config_version, "2");
    assert.deepEqual(changed.json().data.entry_node_ids, [ids[2], ids[1]]);
    const blocked = await app.inject({ method: "GET",
      url: `/api/v1/admin/route-groups/${groupId}/preflight`,
      headers: requestHeaders({ cookie: operator.cookie }) });
    assert.equal(blocked.statusCode, 200, blocked.body);
    assert.equal(blocked.json().data.inventory_ready, false);
    assert.equal(blocked.json().data.transport_ready, false);
    for (const [index, id] of ids.entries()) {
      await pool.query(
        `UPDATE vpn_nodes SET enabled = true, status = 'online', last_seen_at = now(),
               listen_port = 51820, tunnel_cidr = $2::cidr WHERE id = $1`,
        [id, `10.14${index}.0.0/24`],
      );
    }
    const ready = await app.inject({ method: "GET",
      url: `/api/v1/admin/route-groups/${groupId}/preflight`,
      headers: requestHeaders({ cookie: operator.cookie }) });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json().data.inventory_ready, true);
    assert.equal(ready.json().data.transport_ready, false);
    assert.equal(ready.json().data.key_exchange_ready, false);
    assert.ok(ready.json().data.findings.some((item: { code: string }) => item.code === "ROUTE_KEY_MISSING"));
    for (const id of ids) {
      await pool.query(
        `INSERT INTO vpn_route_group_node_keys(group_id, node_id, config_version, public_key)
         VALUES ($1, $2, 2, $3)`,
        [groupId, id, randomBytes(32).toString("base64")],
      );
    }
    const keysReady = await app.inject({ method: "GET",
      url: `/api/v1/admin/route-groups/${groupId}/preflight`,
      headers: requestHeaders({ cookie: operator.cookie }) });
    assert.equal(keysReady.json().data.key_exchange_ready, true);
    assert.equal(keysReady.json().data.transport_ready, false);
    await pool.query("UPDATE vpn_nodes SET tunnel_cidr = '10.141.0.0/24' WHERE id = $1", [ids[2]]);
    const overlap = await app.inject({ method: "GET",
      url: `/api/v1/admin/route-groups/${groupId}/preflight`,
      headers: requestHeaders({ cookie: operator.cookie }) });
    assert.equal(overlap.json().data.inventory_ready, false);
    assert.ok(overlap.json().data.findings.some((item: { code: string }) => item.code === "CLIENT_CIDR_OVERLAP"));

    const stale = await app.inject({ method: "PATCH", url: `/api/v1/admin/route-groups/${groupId}`,
      headers, payload: update });
    assert.equal(stale.statusCode, 409, stale.body);
    const rows = await pool.query(
      "SELECT entry_node_id, priority FROM vpn_route_group_entries WHERE group_id = $1 ORDER BY priority", [groupId]);
    assert.deepEqual(rows.rows.map((row: { entry_node_id: string }) => row.entry_node_id), [ids[2], ids[1]]);
    const audit = await pool.query(
      "SELECT action FROM admin_audit_logs WHERE resource_id = $1 AND action = 'route_group.update'", [groupId]);
    assert.equal(audit.rowCount, 1);
    await pool.query("UPDATE vpn_nodes SET status = 'online', last_seen_at = now() WHERE id = $1", [ids[1]]);
    const fresh = await app.inject({ method: "GET", url: "/api/v1/admin/nodes", headers });
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.equal(fresh.json().data.items.find((node: { id: string }) => node.id === ids[1]).status, "online");
    await pool.query("UPDATE vpn_nodes SET last_seen_at = now() - interval '2 minutes' WHERE id = $1", [ids[1]]);
    const staleHeartbeat = await app.inject({ method: "GET", url: "/api/v1/admin/nodes", headers });
    assert.equal(staleHeartbeat.json().data.items.find((node: { id: string }) => node.id === ids[1]).status, "offline");
  } finally {
    if (groupId) await pool.query("DELETE FROM vpn_route_groups WHERE id = $1", [groupId]);
    if (ids.length) await pool.query("DELETE FROM vpn_nodes WHERE id = ANY($1::uuid[])", [ids]);
  }
});
