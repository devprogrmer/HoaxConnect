import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SignJWT, decodeJwt } from "jose";

const databaseUrl = process.env.HC_STAGE2F_TEST_DATABASE_URL;
const require = createRequire(import.meta.url);
const { createElectronAuthOwner } = require("../../electron/auth/auth-owner.cjs");
const origin = "https://admin.hoaxconnect.test";
const blank = {
  version: 1, app_state: "running",
  permissions: { hardware: false, network: false, applications: false },
  hardware: null, network: null, applications: null,
};
const shared = {
  ...blank, permissions: { hardware: true, network: true, applications: true },
  hardware: { hwid_sha256: "a".repeat(64), manufacturer: "Test manufacturer",
    model: "Test PC", cpu: "Test CPU", memory_bytes: 16 * 1024 ** 3 },
  network: { interface_online: true, backend_rtt_ms: 42, failed_heartbeats: 0 },
  applications: ["HoaxConnect", "Test Editor"],
};

test("client device reporting against isolated PostgreSQL", { skip: !databaseUrl }, async (t) => {
  const database = new URL(databaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname));
  assert.match(decodeURIComponent(database.pathname), /(^|[-_/])test($|[-_])/i);
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: databaseUrl, DATABASE_SSL: "false", LOG_LEVEL: "silent",
    JWT_ACCESS_SECRET: "a".repeat(128), JWT_ISSUER: "https://api.hoaxconnect.test",
    JWT_AUDIENCE: "hoaxconnect-desktop", REFRESH_TOKEN_PEPPER: "b".repeat(128),
    REFRESH_RECOVERY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ADMIN_ALLOWED_ORIGINS: origin, TRUSTED_PROXY_IPS: "127.0.0.1,::1,172.30.0.1",
    ACCESS_TOKEN_TTL_SECONDS: "600", EMAIL_VERIFICATION_REQUIRED: "false",
  });
  await import("../src/migrate.js");
  const { buildApp } = await import("../src/app.js");
  const { pool } = await import("../src/db.js");
  const { hashPassword } = await import("../src/security.js");
  const app = await buildApp();
  const userDataPath = mkdtempSync(join(tmpdir(), "hc-report-test-"));
  const userIds: string[] = [];
  const adminIds: string[] = [];
  const cookies: Record<string, string> = {};
  const password = "Device-Reporting-Test-Password-123!";
  let rejectedToken: string | null = null;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const owner = createElectronAuthOwner({
      userDataPath, configuredBackendUrl: `http://127.0.0.1:${address.port}`,
      safeStorage: { isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
      fetchImpl: async (url: URL, options: RequestInit) => {
        if (url.pathname.endsWith("/client/device-report") && rejectedToken) {
          options = { ...options, headers: { ...options.headers, authorization: `Bearer ${rejectedToken}` } };
          rejectedToken = null;
        }
        return fetch(url, options);
      },
    });
    const register = async () => {
      const suffix = randomUUID().replaceAll("-", "");
      const result = await owner.register({ email: `report-${suffix}@example.test`,
        username: `report_${suffix}`, phone: "+15551234567", password });
      assert.equal(result.ok, true, JSON.stringify(result));
      userIds.push(result.state.user.id);
      return result.state;
    };
    const state = await register();
    const deviceId = state.device.id;
    const token = () => owner.getAccessTokenForMainProcess();
    const report = (payload: unknown, remoteAddress = "198.51.100.50", forwarded = "203.0.113.5") => app.inject({
      method: "POST", url: "/api/v1/client/device-report", remoteAddress,
      headers: { authorization: `Bearer ${token()}`, "x-forwarded-for": forwarded }, payload,
    });
    const record = async () => (await pool.query(
      "SELECT *, host(ip_address) AS observed_ip FROM client_device_reports WHERE device_id = $1", [deviceId],
    )).rows[0];
    const passwordHash = await hashPassword(password);
    for (const role of ["admin", "support", "read_only"]) {
      const email = `report-admin-${randomUUID()}@example.test`;
      const inserted = await pool.query(
        "INSERT INTO admin_accounts (email, email_normalized, password_hash, role) VALUES ($1,$1,$2,$3) RETURNING id",
        [email, passwordHash, role],
      );
      adminIds.push(inserted.rows[0].id);
      const login = await app.inject({ method: "POST", url: "/api/v1/admin/auth/login",
        headers: { origin, "x-forwarded-proto": "https" }, payload: { email, password } });
      assert.equal(login.statusCode, 200, login.body);
      const setCookie = [login.headers["set-cookie"]].flat().find((s) => s?.startsWith("hc_admin_session="));
      assert.ok(setCookie);
      cookies[role] = setCookie.split(";", 1)[0];
    }
    const detail = async (role = "admin") => {
      const response = await app.inject({ method: "GET", url: `/api/v1/admin/users/${state.user.id}`,
        headers: { origin, cookie: cookies[role], "x-forwarded-proto": "https" } });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().data.devices.find((d: { id: string }) => d.id === deviceId);
    };

    await t.test("requires authentication and rejects forged identifiers and unshared data", async () => {
      assert.equal((await app.inject({ method: "POST", url: "/api/v1/client/device-report", payload: blank })).statusCode, 401);
      for (const payload of [
        { ...blank, device_id: randomUUID() }, { ...blank, ip_address: "203.0.113.1" },
        { ...blank, applications: ["Secret App"] }, { ...shared, app_state: "closed" },
        { ...shared, applications: ["C:\\Users\\private\\app.exe"] },
      ]) {
        const response = await report(payload);
        assert.equal(response.statusCode, 400, response.body);
      }
      assert.equal(await record(), undefined);
    });
    await t.test("binds IDs to the signed session and accepts forwarded IP only from an explicit proxy", async () => {
      assert.equal((await report(shared)).statusCode, 200);
      let row = await record();
      assert.equal(row.observed_ip, "198.51.100.50");
      assert.equal(row.device_id, deviceId);
      assert.equal(row.session_id, decodeJwt(token()).sid);
      assert.equal((await report(shared, "172.30.0.1", "192.0.2.12, 198.51.100.80")).statusCode, 200);
      row = await record();
      assert.equal(row.observed_ip, "198.51.100.80");
      const device = await detail();
      assert.equal(device.reported_ip, "198.51.100.80");
      assert.equal(device.presence, "online");
      assert.equal(device.hardware.hwid_sha256, shared.hardware.hwid_sha256);
      assert.deepEqual(device.applications, shared.applications);
    });
    await t.test("shared-address reporting does not stop after ten active clients worth of heartbeats", async () => {
      for (let index = 0; index < 22; index += 1) {
        const response = await report(blank, "198.51.100.50");
        assert.equal(response.statusCode, 200, `Report ${index + 1}: ${response.body}`);
      }
      assert.equal((await record()).device_id, deviceId);
      assert.equal((await report(shared)).statusCode, 200);
    });
    await t.test("sensitive reports are redacted for support and read-only administrators", async () => {
      for (const role of ["support", "read_only"]) {
        const device = await detail(role);
        assert.equal(device.report_details_allowed, false);
        assert.equal(device.reported_ip, null);
        assert.equal(device.report_permissions, null);
        assert.equal(device.hardware, null);
        assert.equal(device.network, null);
        assert.equal(device.applications, null);
      }
    });
    await t.test("stale reports cannot claim that the app or other applications are currently open", async () => {
      await pool.query("UPDATE client_device_reports SET received_at = now() - interval '91 seconds' WHERE device_id = $1", [deviceId]);
      const device = await detail();
      assert.equal(device.presence, "not_reporting");
      assert.equal(device.applications, null);
    });
    await t.test("withdrawing sharing deletes previously stored hardware, network and application values", async () => {
      const response = await report(blank);
      assert.equal(response.statusCode, 200, response.body);
      const row = await record();
      assert.equal(row.hardware, null);
      assert.equal(row.network, null);
      assert.equal(row.applications, null);
      assert.deepEqual(row.permissions, blank.permissions);
    });
    await t.test("owner refreshes an expired token and stores a report under the replacement session", async () => {
      const previous = token();
      rejectedToken = await new SignJWT({ ...decodeJwt(previous), exp: Math.floor(Date.now() / 1000) - 10 })
        .setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET));
      const result = await owner.reportDeviceState(shared, deviceId);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.notEqual(token(), previous);
      assert.equal((await record()).session_id, decodeJwt(token()).sid);
      assert.equal(owner.getState().state.status, "authenticated");
    });
    await t.test("closed reports clear details and remain distinct from missing heartbeats", async () => {
      assert.equal((await report({ ...blank, app_state: "closed" })).statusCode, 200);
      assert.equal((await detail()).presence, "closed");
      assert.equal((await detail()).applications, null);
    });
    await t.test("reports older than 24 hours disappear and are removed on server startup", async () => {
      await pool.query("UPDATE client_device_reports SET received_at = now() - interval '25 hours' WHERE device_id = $1", [deviceId]);
      assert.equal((await detail()).presence, "not_reported");
      assert.equal((await detail()).reported_ip, null);
      const another = await buildApp();
      try { await another.ready(); assert.equal(await record(), undefined); }
      finally { await another.close(); }
    });
    await t.test("a banned device cannot send reports even when its access token has not expired", async () => {
      assert.equal((await report(shared)).statusCode, 200);
      await pool.query("UPDATE devices SET banned_at = now() WHERE id = $1", [deviceId]);
      try {
        assert.equal((await report(shared)).statusCode, 401);
        assert.equal((await detail()).presence, "session_inactive");
        assert.equal((await detail()).applications, null);
      } finally { await pool.query("UPDATE devices SET banned_at = NULL WHERE id = $1", [deviceId]); }
    });
    await t.test("logout invalidates presence and a report collected for another account cannot be sent", async () => {
      assert.equal((await owner.logout()).ok, true);
      assert.equal((await detail()).presence, "session_inactive");
      assert.equal((await owner.reportDeviceState(shared, deviceId)).ok, false);
      const next = await register();
      assert.notEqual(next.device.id, deviceId);
      assert.equal((await owner.reportDeviceState(shared, deviceId)).ok, false);
      assert.equal((await pool.query("SELECT 1 FROM client_device_reports WHERE device_id = $1", [next.device.id])).rowCount, 0);
    });
  } finally {
    await app.close();
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM admin_accounts WHERE id = ANY($1::uuid[])", [adminIds]);
    await pool.end();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
