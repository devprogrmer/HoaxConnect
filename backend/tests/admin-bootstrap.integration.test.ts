import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const databaseUrl = process.env.HC_STAGE2D_TEST_DATABASE_URL;

test(
  "first superadmin bootstrap commits an audit row and cannot run twice",
  { skip: !databaseUrl },
  async () => {
    const database = new URL(databaseUrl!);
    const databaseName = decodeURIComponent(database.pathname.slice(1));
    if (
      !["localhost", "127.0.0.1", "::1"].includes(database.hostname) ||
      !/(^|[-_])test($|[-_])/i.test(databaseName)
    ) {
      throw new Error(
        "Admin bootstrap integration test requires a loopback PostgreSQL database with 'test' in its name.",
      );
    }

    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = databaseUrl!;
    process.env.DATABASE_SSL = "false";
    process.env.JWT_ACCESS_SECRET = "a".repeat(128);
    process.env.JWT_ISSUER = "https://api.hoaxconnect.test";
    process.env.JWT_AUDIENCE = "hoaxconnect-desktop";
    process.env.REFRESH_TOKEN_PEPPER = "b".repeat(128);
    process.env.REFRESH_RECOVERY_ENCRYPTION_KEY =
      Buffer.alloc(32, 7).toString("base64");

    await import("../src/migrate.js");
    const [{ bootstrapFirstSuperadmin }, { pool, closeDatabase }] =
      await Promise.all([
        import("../src/admin-bootstrap.js"),
        import("../src/db.js"),
      ]);

    const email = `stage2d-bootstrap-${randomUUID()}@example.test`;
    const password = "Stage2D-Bootstrap-Test-Password-123!";
    let adminId: string | undefined;

    try {
      const admin = await bootstrapFirstSuperadmin(email, password);
      adminId = admin.id;
      assert.equal(admin.email, email);
      assert.equal(admin.role, "superadmin");

      const audit = await pool.query(
        `SELECT resource_id, metadata
         FROM admin_audit_logs
         WHERE admin_id = $1 AND action = 'admin.bootstrap'`,
        [admin.id],
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].resource_id, admin.id);
      assert.equal(audit.rows[0].metadata.source, "local_one_time_bootstrap");

      await assert.rejects(
        bootstrapFirstSuperadmin(
          `stage2d-bootstrap-second-${randomUUID()}@example.test`,
          password,
        ),
        /one-time Admin bootstrap has already been used/,
      );
    } finally {
      try {
        if (adminId) {
          await pool.query("DELETE FROM admin_audit_logs WHERE admin_id = $1", [adminId]);
          await pool.query("DELETE FROM admin_accounts WHERE id = $1", [adminId]);
        }
      } finally {
        await closeDatabase();
      }
    }
  },
);
