import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const databaseUrl =
  process.env.HC_STAGE2C_TEST_DATABASE_URL;

const require = createRequire(import.meta.url);
const { createElectronAuthOwner } = require(
  "../../electron/auth/auth-owner.cjs"
);

test(
  "Electron Auth Owner registers and restores against the real Backend",
  { skip: !databaseUrl },
  async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = databaseUrl!;
    process.env.JWT_ACCESS_SECRET = "a".repeat(128);
    process.env.JWT_ISSUER =
      "https://api.hoaxconnect.test";
    process.env.JWT_AUDIENCE = "hoaxconnect-desktop";
    process.env.REFRESH_TOKEN_PEPPER = "b".repeat(128);
    process.env.REFRESH_RECOVERY_ENCRYPTION_KEY =
      Buffer.alloc(32, 7).toString("base64");
    process.env.REFRESH_RECOVERY_TTL_SECONDS = "120";
    process.env.ACCESS_TOKEN_TTL_SECONDS = "600";
    process.env.REFRESH_TOKEN_TTL_DAYS = "30";
    process.env.EMAIL_VERIFICATION_REQUIRED = "false";
    process.env.EMAIL_PROVIDER = "none";
    process.env.PAYMENT_PROVIDER = "none";

    const [{ buildApp }, dbModule] = await Promise.all([
      import("../src/app.js"),
      import("../src/db.js"),
    ]);

    const app = await buildApp();
    const pool = dbModule.pool;
    const userDataPath = mkdtempSync(
      join(tmpdir(), "hoaxconnect-electron-e2e-")
    );

    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) =>
        Buffer.from(value, "utf8"),
      decryptString: (value: Buffer) =>
        value.toString("utf8"),
    };

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();

      assert.ok(address && typeof address === "object");

      const owner = createElectronAuthOwner({
        safeStorage,
        userDataPath,
        configuredBackendUrl:
          `http://127.0.0.1:${address.port}`,
        deviceInfo: {
          clientVersion: "0.3.9",
          osVersion: "test-os",
        },
      });

      const suffix = randomUUID()
        .replaceAll("-", "")
        .slice(0, 16);

      const phoneSuffix = String(
        parseInt(suffix.slice(0, 7), 16) % 10_000_000
      ).padStart(7, "0");

      const registration = await owner.register({
        email: `electron-e2e-${suffix}@example.test`,
        phone: `+1555${phoneSuffix}`,
        username: `e2e_${suffix}`,
        password: "Stage2C-Electron-E2E-Password-123!",
      });

      assert.equal(
        registration.ok,
        true,
        JSON.stringify(registration)
      );
      assert.equal(
        registration.state.status,
        "authenticated"
      );

      const store = require(
        "../../electron/auth/secure-store.cjs"
      ).createProtectedAuthStore({
        safeStorage,
        userDataPath,
      });

      const beforeRestore = store.load();
      assert.ok(beforeRestore?.refreshToken);
      assert.equal(beforeRestore.pendingRotation, null);

      const restored = await owner.restore();

      assert.equal(restored.ok, true, JSON.stringify(restored));
      assert.equal(
        restored.state.status,
        "authenticated"
      );

      const afterRestore = store.load();
      assert.ok(afterRestore?.refreshToken);
      assert.notEqual(
        afterRestore.refreshToken,
        beforeRestore.refreshToken
      );
      assert.equal(afterRestore.pendingRotation, null);

      const sessions = await pool.query(
        `SELECT status
         FROM sessions
         WHERE user_id = (
           SELECT id
           FROM users
           WHERE email_normalized = $1
         )
         ORDER BY created_at DESC`,
        [`electron-e2e-${suffix}@example.test`]
      );

      assert.equal(sessions.rowCount, 2);
      assert.equal(
        sessions.rows.filter(
          (row: { status: string }) => row.status === "active"
        ).length,
        1
      );
      assert.equal(
        sessions.rows.filter(
          (row: { status: string }) => row.status === "rotated"
        ).length,
        1
      );

      assert.equal(
        owner.getAccessTokenForMainProcess() !== null,
        true
      );
    } finally {
      await app.close();
      await pool.end();
      rmSync(userDataPath, { recursive: true, force: true });
    }
  }
);
