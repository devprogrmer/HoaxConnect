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
  canonicalDeviceProofPayload,
} = require("../auth/device-identity.cjs");

function makeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8"),
  };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

test(
  "account and device policy errors return specific safe messages",
  async () => {
    const userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "hoaxconnect-auth-policy-")
    );

    try {
      const cases = [
        [
          "ACCOUNT_ALREADY_EXISTS",
          "An account with this email or username already exists. Sign in instead.",
        ],
        [
          "EMAIL_VERIFICATION_REQUIRED",
          "Verify your email address before signing in.",
        ],
        [
          "ACCOUNT_SUSPENDED",
          "This account is suspended. Contact support for assistance.",
        ],
        [
          "ACCOUNT_BANNED",
          "This account cannot sign in. Contact support for assistance.",
        ],
        [
          "DEVICE_REVOKED",
          "This device has been revoked. Sign in with an authorized device.",
        ],
      ];

      for (const [code, message] of cases) {
        const owner = createElectronAuthOwner({
          safeStorage: makeSafeStorage(),
          userDataPath,
          configuredBackendUrl: "http://127.0.0.1:3100",
          fetchImpl: async () =>
            jsonResponse(
              { error: { code } },
              403
            ),
        });

        const result = await owner.login({
          identifier: "user@example.test",
          password: "test-password",
        });

        assert.equal(result.ok, false);
        assert.equal(result.error.code, code);
        assert.equal(result.error.message, message);
      }
    } finally {
      fs.rmSync(userDataPath, {
        recursive: true,
        force: true,
      });
    }
  }
);

test("unknown Backend errors expose only a sanitized error code", async () => {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "hoaxconnect-auth-backend-error-")
  );

  try {
    const owner = createElectronAuthOwner({
      safeStorage: makeSafeStorage(),
      userDataPath,
      configuredBackendUrl: "http://127.0.0.1:3100",
      fetchImpl: async () =>
        jsonResponse(
          {
            error: {
              code: "PHONE_NUMBER_NOT_SUPPORTED",
              message: "private backend detail",
            },
          },
          400
        ),
    });

    const result = await owner.register({
      email: "user@example.test",
      phone: "+989363438565",
      username: "test-user",
      password: "a-long-test-password",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "BACKEND_REJECTED");
    assert.equal(
      result.error.message,
      "The Backend rejected the request (PHONE_NUMBER_NOT_SUPPORTED)."
    );
    assert.equal(
      JSON.stringify(result).includes("private backend detail"),
      false
    );
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("login accepts an enrollment proof for a newly seen device", async () => {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "hoaxconnect-auth-new-device-")
  );
  const paths = [];

  try {
    const owner = createElectronAuthOwner({
      safeStorage: makeSafeStorage(),
      userDataPath,
      configuredBackendUrl: "http://127.0.0.1:3100",
      fetchImpl: async (url, options) => {
        const parsed = new URL(url);
        const body = JSON.parse(options.body);
        paths.push(parsed.pathname);

        if (parsed.pathname.endsWith("/auth/login")) {
          const key = crypto.createPublicKey(
            body.device.public_key_spki
          );
          const fingerprint = crypto
            .createHash("sha256")
            .update(key.export({ type: "spki", format: "der" }))
            .digest("hex");

          return jsonResponse({
            data: {
              user: {
                id: "new-device-user",
                email: "user@example.test",
                username: "user",
                role: "user",
                status: "active",
              },
              device: { device_uid: body.device.uid },
              proof: {
                challenge_id: "e2e44c79-b95f-4a33-9dd9-3c18a6e4e9b1",
                purpose: "enrollment",
                nonce: "n".repeat(43),
                flow_token: "f".repeat(43),
                key_fingerprint: fingerprint,
                issued_at: "2026-09-30T00:00:00.000Z",
                expires_at: "2026-09-30T00:05:00.000Z",
              },
            },
          });
        }

        return jsonResponse({
          data: {
            user: {
              id: "new-device-user",
              email: "user@example.test",
              username: "user",
              role: "user",
              status: "active",
            },
            device: {
              id: "device-id",
              device_uid: "device",
            },
            tokens: {
              accessToken: "access-token",
              refreshToken: "refresh-token",
              sessionId: "session-id",
            },
          },
        });
      },
    });

    const result = await owner.login({
      identifier: "user@example.test",
      password: "test-password",
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(paths, [
      "/api/v1/auth/login",
      "/api/v1/auth/device-proof",
    ]);
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("invalid login challenge reports field names without exposing challenge data", async () => {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "hoaxconnect-auth-invalid-challenge-")
  );

  try {
    const owner = createElectronAuthOwner({
      safeStorage: makeSafeStorage(),
      userDataPath,
      configuredBackendUrl: "http://127.0.0.1:3100",
      fetchImpl: async () =>
        jsonResponse({
          data: {
            user: { id: "user-id" },
            proof: {
              purpose: "login",
              key_fingerprint: "sensitive-fingerprint-value",
            },
          },
        }),
    });

    const result = await owner.login({
      identifier: "user@example.test",
      password: "test-password",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "AUTH_RESPONSE_INVALID");
    assert.match(result.error.message, /challenge_id missing/);
    assert.equal(
      JSON.stringify(result).includes("sensitive-fingerprint-value"),
      false
    );
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test(
  "Main completes signed login, persists refresh state, and returns only sanitized state",
  async () => {
    const userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "hoaxconnect-owner-")
    );
    const requests = [];
    let publicKeySpki;
    let rejectSignOut = false;

    const owner = createElectronAuthOwner({
      safeStorage: makeSafeStorage(),
      userDataPath,
      configuredBackendUrl:
        "http://127.0.0.1:3100",
      deviceInfo: {
        clientVersion: "0.3.9",
        osVersion: "test-os",
      },
      fetchImpl: async (url, options) => {
        const parsedUrl = new URL(url);
        const body = JSON.parse(options.body);
        requests.push({
          url: parsedUrl,
          options,
          body,
        });

        if (
          parsedUrl.pathname.endsWith("/auth/logout-all") ||
          parsedUrl.pathname.endsWith("/auth/logout")
        ) {
          if (rejectSignOut) {
            return jsonResponse(
              { error: { code: "REVOKE_FAILED" } },
              503
            );
          }

          return jsonResponse({
            data: { revoked: true },
          });
        }

        if (parsedUrl.pathname.endsWith("/auth/login")) {
          publicKeySpki =
            body.device.public_key_spki;

          return jsonResponse({
            data: {
              user: {
                id: "user-1",
                email: "user@example.test",
                username: "user",
                role: "user",
                status: "active",
                email_verified: false,
                phone_verified: false,
              },
              device: {
                id: "device-1",
                device_uid: body.device.uid,
                name: body.device.name,
                platform: body.device.platform,
                os_version: body.device.os_version,
                architecture: body.device.architecture,
                client_version:
                  body.device.client_version,
                revoked: false,
                banned: false,
              },
              proof: {
                challenge_id:
                  "bba59579-d2a2-4cc5-a569-b5323edbb87f",
                purpose: "login",
                nonce: "n".repeat(43),
                flow_token: "f".repeat(43),
                key_fingerprint:
                  crypto.createHash("sha256")
                    .update(
                      crypto.createPublicKey(
                        body.device.public_key_spki
                      ).export({
                        type: "spki",
                        format: "der",
                      })
                    )
                    .digest("hex"),
                issued_at:
                  "2026-09-30T00:00:00.000Z",
                expires_at:
                  "2026-09-30T00:05:00.000Z",
              },
            },
          });
        }

        assert.equal(
          parsedUrl.pathname,
          "/api/v1/auth/device-proof"
        );
        assert.equal(
          Object.hasOwn(body, "password"),
          false
        );

        const loginRequest = requests[0];
        const proof = {
          challenge_id:
            "bba59579-d2a2-4cc5-a569-b5323edbb87f",
          purpose: "login",
          nonce: "n".repeat(43),
          flow_token: "f".repeat(43),
          key_fingerprint:
            crypto.createHash("sha256")
              .update(
                crypto.createPublicKey(
                  publicKeySpki
                ).export({
                  type: "spki",
                  format: "der",
                })
              )
              .digest("hex"),
          issued_at:
            "2026-09-30T00:00:00.000Z",
          expires_at:
            "2026-09-30T00:05:00.000Z",
        };

        const payload =
          canonicalDeviceProofPayload({
            version: 1,
            challengeId: proof.challenge_id,
            purpose: proof.purpose,
            nonce: proof.nonce,
            userId: "user-1",
            deviceUid:
              loginRequest.body.device.uid,
            keyFingerprint:
              proof.key_fingerprint,
            issuedAt: proof.issued_at,
            expiresAt: proof.expires_at,
          });

        assert.equal(
          crypto.verify(
            null,
            payload,
            crypto.createPublicKey(publicKeySpki),
            Buffer.from(body.signature, "base64url")
          ),
          true
        );

        return jsonResponse({
          data: {
            user: {
              id: "user-1",
              email: "user@example.test",
              username: "user",
              role: "user",
              status: "active",
              email_verified: false,
              phone_verified: false,
            },
            device: {
              id: "device-1",
              device_uid:
                loginRequest.body.device.uid,
              name: "HoaxConnect Desktop",
              platform: "linux",
              os_version: "test-os",
              architecture: process.arch,
              client_version: "0.3.9",
              revoked: false,
              banned: false,
            },
            tokens: {
              accessToken: "access-secret",
              refreshToken: "refresh-secret",
              sessionId: "session-1",
            },
          },
        });
      },
    });

    try {
      const result = await owner.login({
        identifier: "user@example.test",
        password: "temporary-password",
      });

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(
        result.state.status,
        "authenticated"
      );
      assert.equal(requests.length, 2);
      assert.equal(
        requests[0].options.redirect,
        "error"
      );
      assert.ok(requests[0].options.signal);

      const returned = JSON.stringify(result);
      for (const secret of [
        "temporary-password",
        "access-secret",
        "refresh-secret",
        "BEGIN PRIVATE KEY",
      ]) {
        assert.equal(returned.includes(secret), false);
      }

      const store = createProtectedAuthStore({
        safeStorage: makeSafeStorage(),
        userDataPath,
      });
      const persisted = store.load();

      assert.equal(
        persisted.refreshToken,
        "refresh-secret"
      );
      assert.match(
        persisted.devicePrivateKey,
        /BEGIN PRIVATE KEY/
      );

      const logoutResult = await owner.logout();

      assert.equal(
        logoutResult.ok,
        true,
        JSON.stringify(logoutResult)
      );
      assert.equal(
        logoutResult.state.status,
        "signed_out"
      );

      const logoutRequest = requests.at(-1);
      assert.equal(
        logoutRequest.url.pathname,
        "/api/v1/auth/logout"
      );
      assert.equal(
        logoutRequest.options.headers.authorization,
        "Bearer access-secret"
      );

      const afterLogout = store.load();
      assert.equal(
        afterLogout.deviceUid,
        persisted.deviceUid
      );
      assert.equal(
        afterLogout.devicePrivateKey,
        persisted.devicePrivateKey
      );
      assert.equal(afterLogout.refreshToken, null);
      assert.equal(afterLogout.user, null);
      assert.equal(afterLogout.device, null);

      const relogin = await owner.login({
        identifier: "user@example.test",
        password: "temporary-password",
      });
      assert.equal(relogin.ok, true, JSON.stringify(relogin));

      const logoutAllResult = await owner.logoutAll();
      assert.equal(
        logoutAllResult.ok,
        true,
        JSON.stringify(logoutAllResult)
      );
      assert.equal(logoutAllResult.remoteRevoked, true);

      const logoutAllRequest = requests.at(-1);
      assert.equal(
        logoutAllRequest.url.pathname,
        "/api/v1/auth/logout-all"
      );
      assert.equal(
        logoutAllRequest.options.headers.authorization,
        "Bearer access-secret"
      );

      const afterLogoutAll = store.load();
      assert.equal(
        afterLogoutAll.deviceUid,
        persisted.deviceUid
      );
      assert.equal(afterLogoutAll.refreshToken, null);
      assert.equal(afterLogoutAll.user, null);
      assert.equal(afterLogoutAll.device, null);

      const reloginForFailure = await owner.login({
        identifier: "user@example.test",
        password: "temporary-password",
      });
      assert.equal(
        reloginForFailure.ok,
        true,
        JSON.stringify(reloginForFailure)
      );

      rejectSignOut = true;
      const unconfirmedLogout = await owner.logout();

      assert.equal(
        unconfirmedLogout.ok,
        true,
        JSON.stringify(unconfirmedLogout)
      );
      assert.equal(unconfirmedLogout.remoteRevoked, false);
      assert.equal(
        unconfirmedLogout.warning.code,
        "BACKEND_REJECTED"
      );
      assert.equal(
        unconfirmedLogout.state.status,
        "signed_out"
      );

      const afterUnconfirmedLogout = store.load();
      assert.equal(
        afterUnconfirmedLogout.deviceUid,
        persisted.deviceUid
      );
      assert.equal(
        afterUnconfirmedLogout.devicePrivateKey,
        persisted.devicePrivateKey
      );
      assert.equal(afterUnconfirmedLogout.refreshToken, null);
      assert.equal(afterUnconfirmedLogout.user, null);
      assert.equal(afterUnconfirmedLogout.device, null);
    } finally {
      fs.rmSync(userDataPath, {
        recursive: true,
        force: true,
      });
    }
  }
);

test(
  "Main refuses authentication before network access when secure storage is unavailable",
  async () => {
    const userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "hoaxconnect-owner-")
    );
    let requestCount = 0;

    const owner = createElectronAuthOwner({
      safeStorage: makeSafeStorage(false),
      userDataPath,
      configuredBackendUrl:
        "http://127.0.0.1:3100",
      fetchImpl: async () => {
        requestCount += 1;
        return jsonResponse({ data: {} });
      },
    });

    try {
      const result = await owner.login({
        identifier: "user@example.test",
        password: "temporary-password",
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.error.code,
        "SECURE_STORAGE_UNAVAILABLE"
      );
      assert.equal(requestCount, 0);
    } finally {
      fs.rmSync(userDataPath, {
        recursive: true,
        force: true,
      });
    }
  }
);
