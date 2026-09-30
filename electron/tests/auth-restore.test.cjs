const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createElectronAuthOwner,
} = require("../auth/auth-owner.cjs");
const {
  createProtectedAuthStore,
} = require("../auth/secure-store.cjs");
const {
  createDeviceIdentity,
  canonicalDeviceProofPayload,
} = require("../auth/device-identity.cjs");

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8"),
  };
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data }),
  };
}

test("refresh restore retries the exact protected rotation request after a lost response", async () => {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "hoaxconnect-refresh-restore-")
  );
  const storage = safeStorage();
  const identity = createDeviceIdentity();
  const store = createProtectedAuthStore({
    safeStorage: storage,
    userDataPath,
  });

  store.save({
    version: 1,
    deviceUid: identity.deviceUid,
    devicePrivateKey: identity.privateKeyPem,
    refreshToken: "previous-refresh-token",
    user: {
      id: "user-restore-1",
      email: "restore@example.test",
      phone: null,
      username: "restore-user",
      role: "user",
      status: "active",
      email_verified: false,
      phone_verified: false,
    },
    device: {
      id: "device-restore-1",
      device_uid: identity.deviceUid,
      name: "HoaxConnect Desktop",
      platform: process.platform,
      os_version: "test",
      architecture: process.arch,
      client_version: "test",
      revoked: false,
      banned: false,
    },
  });

  const requests = [];
  let rotationAttempts = 0;

  const owner = createElectronAuthOwner({
    safeStorage: storage,
    userDataPath,
    configuredBackendUrl: "http://127.0.0.1:3100",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      const body = JSON.parse(options.body);
      requests.push({ path: parsed.pathname, body });

      if (parsed.pathname.endsWith("/auth/refresh/challenge")) {
        return response({
          proof: {
            challenge_id: "3dff337a-1a2f-4e5c-98af-594c08e9dc3d",
            purpose: "refresh",
            nonce: "n".repeat(43),
            flow_token: "f".repeat(43),
            key_fingerprint: identity.keyFingerprint,
            issued_at: "2026-09-30T00:00:00.000Z",
            expires_at: "2026-09-30T00:05:00.000Z",
          },
        });
      }

      assert.equal(parsed.pathname, "/api/v1/auth/refresh");
      rotationAttempts += 1;

      const persisted = store.load();
      assert.ok(persisted.pendingRotation);
      assert.deepEqual(body, persisted.pendingRotation);
      assert.equal(body.refresh_token, "previous-refresh-token");

      const signedPayload = canonicalDeviceProofPayload({
        version: 1,
        challengeId: body.challenge_id,
        purpose: "refresh",
        nonce: body.nonce,
        userId: "user-restore-1",
        deviceUid: identity.deviceUid,
        keyFingerprint: identity.keyFingerprint,
        issuedAt: "2026-09-30T00:00:00.000Z",
        expiresAt: "2026-09-30T00:05:00.000Z",
      });

      assert.equal(
        crypto.verify(
          null,
          signedPayload,
          crypto.createPublicKey(identity.publicKeySpki),
          Buffer.from(body.signature, "base64url")
        ),
        true
      );

      if (rotationAttempts === 1) {
        throw new Error("simulated lost response");
      }

      return response({
        tokens: {
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          sessionId: "new-session-id",
        },
      });
    },
  });

  try {
    assert.equal(owner.getState().state.status, "restore_required");

    const lost = await owner.restore();
    assert.equal(lost.ok, false);
    assert.equal(lost.error.code, "BACKEND_UNAVAILABLE");

    const firstPending = store.load().pendingRotation;
    assert.ok(firstPending);
    assert.equal(firstPending.recovery_id.length > 30, true);
    assert.equal(firstPending.recovery_secret.length > 30, true);

    const restored = await owner.restore();
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.state.status, "authenticated");
    assert.equal(requests.filter((r) =>
      r.path.endsWith("/auth/refresh/challenge")
    ).length, 1);
    assert.deepEqual(
      requests.filter((r) => r.path.endsWith("/auth/refresh"))
        .map((r) => r.body),
      [firstPending, firstPending]
    );

    const saved = store.load();
    assert.equal(saved.refreshToken, "new-refresh-token");
    assert.equal(saved.pendingRotation, null);
    assert.equal(owner.getAccessTokenForMainProcess(), "new-access-token");

    const exposed = JSON.stringify(restored);
    for (const secret of [
      "previous-refresh-token",
      "new-refresh-token",
      "new-access-token",
      firstPending.recovery_secret,
      "BEGIN PRIVATE KEY",
    ]) {
      assert.equal(exposed.includes(secret), false);
    }
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
