const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createProtectedAuthStore,
} = require("../auth/secure-store.cjs");

const {
  sanitizeAuthState,
} = require("../auth/ipc-contract.cjs");

function temporaryDirectory() {
  return fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hoaxconnect-auth-test-"
    )
  );
}

function availableSafeStorage() {
  return {
    isEncryptionAvailable() {
      return true;
    },

    encryptString(value) {
      return Buffer.from(
        `encrypted:${Buffer.from(
          value,
          "utf8"
        ).toString("base64")}`,
        "utf8"
      );
    },

    decryptString(value) {
      const encoded = value
        .toString("utf8")
        .replace(/^encrypted:/, "");

      return Buffer.from(
        encoded,
        "base64"
      ).toString("utf8");
    },
  };
}

test(
  "protected auth storage fails closed when encryption is unavailable",
  () => {
    const userDataPath =
      temporaryDirectory();

    const store =
      createProtectedAuthStore({
        safeStorage: {
          isEncryptionAvailable() {
            return false;
          },

          encryptString() {
            throw new Error(
              "must not encrypt"
            );
          },

          decryptString() {
            throw new Error(
              "must not decrypt"
            );
          },
        },

        userDataPath,
      });

    assert.throws(
      () =>
        store.save({
          version: 1,
          deviceUid:
            "device-test-001",
          devicePrivateKey:
            "PRIVATE-KEY-MUST-NOT-BE-STORED",
          refreshToken:
            "REFRESH-TOKEN-MUST-NOT-BE-STORED",
        }),
      (error) => {
        assert.equal(
          error.code,
          "SECURE_STORAGE_UNAVAILABLE"
        );

        return true;
      }
    );

    assert.deepEqual(
      fs.readdirSync(userDataPath),
      []
    );
  }
);

test(
  "protected auth storage encrypts secrets and restores them",
  () => {
    const userDataPath =
      temporaryDirectory();

    const store =
      createProtectedAuthStore({
        safeStorage:
          availableSafeStorage(),

        userDataPath,
      });

    const state = {
      version: 1,
      deviceUid:
        "device-test-002",
      devicePrivateKey:
        "PRIVATE-KEY-PLAINTEXT",
      refreshToken:
        "REFRESH-TOKEN-PLAINTEXT",
    };

    store.save(state);

    const files =
      fs.readdirSync(userDataPath);

    assert.equal(
      files.length,
      1
    );

    const persisted =
      fs.readFileSync(
        path.join(
          userDataPath,
          files[0]
        )
      );

    assert.equal(
      persisted.includes(
        Buffer.from(
          state.devicePrivateKey
        )
      ),
      false
    );

    assert.equal(
      persisted.includes(
        Buffer.from(
          state.refreshToken
        )
      ),
      false
    );

    assert.deepEqual(
      store.load(),
      state
    );
  }
);

test(
  "protected auth storage rejects corrupt ciphertext without plaintext fallback",
  () => {
    const userDataPath =
      temporaryDirectory();

    const store =
      createProtectedAuthStore({
        safeStorage:
          availableSafeStorage(),

        userDataPath,
      });

    fs.writeFileSync(
      path.join(
        userDataPath,
        "auth-state.enc"
      ),
      Buffer.from(
        "not-valid-protected-state",
        "utf8"
      )
    );

    assert.throws(
      () => store.load(),
      (error) => {
        assert.equal(
          error.code,
          "PROTECTED_STATE_INVALID"
        );

        return true;
      }
    );
  }
);

test(
  "Renderer auth state excludes credentials and device private material",
  () => {
    const rendererState =
      sanitizeAuthState({
        status: "authenticated",

        user: {
          id: "user-1",
          email:
            "user@example.com",
          phone: null,
          username: "user",
          role: "user",
          status: "active",
          email_verified: true,
          phone_verified: false,
        },

        device: {
          id: "device-1",
          device_uid:
            "device-test-003",
          name: "Windows PC",
          platform: "win32",
          os_version: "11",
          architecture: "x64",
          client_version: "0.3.9",
          revoked: false,
          banned: false,
        },

        accessToken:
          "ACCESS-TOKEN-SECRET",
        refreshToken:
          "REFRESH-TOKEN-SECRET",
        devicePrivateKey:
          "DEVICE-PRIVATE-KEY",
        password:
          "PASSWORD-SECRET",
      });

    assert.deepEqual(
      rendererState,
      {
        status: "authenticated",

        user: {
          id: "user-1",
          email:
            "user@example.com",
          phone: null,
          username: "user",
          role: "user",
          status: "active",
          email_verified: true,
          phone_verified: false,
        },

        device: {
          id: "device-1",
          device_uid:
            "device-test-003",
          name: "Windows PC",
          platform: "win32",
          os_version: "11",
          architecture: "x64",
          client_version: "0.3.9",
          revoked: false,
          banned: false,
        },
      }
    );

    const serialized =
      JSON.stringify(
        rendererState
      );

    for (const forbidden of [
      "ACCESS-TOKEN-SECRET",
      "REFRESH-TOKEN-SECRET",
      "DEVICE-PRIVATE-KEY",
      "PASSWORD-SECRET",
    ]) {
      assert.equal(
        serialized.includes(
          forbidden
        ),
        false
      );
    }
  }
);

test(
  "protected auth storage replaces credentials without leaving temporary files",
  () => {
    const userDataPath =
      temporaryDirectory();

    const store =
      createProtectedAuthStore({
        safeStorage:
          availableSafeStorage(),

        userDataPath,
      });

    store.save({
      version: 1,
      deviceUid:
        "device-test-004",
      devicePrivateKey:
        "PRIVATE-KEY-ONE",
      refreshToken:
        "REFRESH-TOKEN-ONE",
    });

    const replacement = {
      version: 1,
      deviceUid:
        "device-test-004",
      devicePrivateKey:
        "PRIVATE-KEY-TWO",
      refreshToken:
        "REFRESH-TOKEN-TWO",
    };

    store.save(replacement);

    assert.deepEqual(
      store.load(),
      replacement
    );

    assert.deepEqual(
      fs.readdirSync(
        userDataPath
      ),
      [
        "auth-state.enc",
      ]
    );
  }
);

test(
  "protected auth storage clear removes reusable credentials",
  () => {
    const userDataPath =
      temporaryDirectory();

    const store =
      createProtectedAuthStore({
        safeStorage:
          availableSafeStorage(),

        userDataPath,
      });

    store.save({
      version: 1,
      deviceUid:
        "device-test-005",
      devicePrivateKey:
        "PRIVATE-KEY-CLEAR",
      refreshToken:
        "REFRESH-TOKEN-CLEAR",
    });

    store.clear();

    assert.equal(
      store.load(),
      null
    );

    assert.deepEqual(
      fs.readdirSync(
        userDataPath
      ),
      []
    );
  }
);

test(
  "encryption failure does not persist reusable credentials",
  () => {
    const userDataPath =
      temporaryDirectory();

    const store =
      createProtectedAuthStore({
        safeStorage: {
          isEncryptionAvailable() {
            return true;
          },

          encryptString() {
            throw new Error(
              "encryption failed"
            );
          },

          decryptString() {
            throw new Error(
              "not used"
            );
          },
        },

        userDataPath,
      });

    assert.throws(
      () =>
        store.save({
          version: 1,
          deviceUid:
            "device-test-006",
          devicePrivateKey:
            "PRIVATE-KEY-FAIL",
          refreshToken:
            "REFRESH-TOKEN-FAIL",
        }),
      (error) => {
        assert.equal(
          error.code,
          "SECURE_STORAGE_WRITE_FAILED"
        );

        return true;
      }
    );

    assert.deepEqual(
      fs.readdirSync(
        userDataPath
      ),
      []
    );
  }
);

test(
  "decryption failure returns a controlled protected-state error",
  () => {
    const userDataPath =
      temporaryDirectory();

    const workingStorage =
      availableSafeStorage();

    const writer =
      createProtectedAuthStore({
        safeStorage:
          workingStorage,

        userDataPath,
      });

    writer.save({
      version: 1,
      deviceUid:
        "device-test-007",
      devicePrivateKey:
        "PRIVATE-KEY-DECRYPT",
      refreshToken:
        "REFRESH-TOKEN-DECRYPT",
    });

    const reader =
      createProtectedAuthStore({
        safeStorage: {
          isEncryptionAvailable() {
            return true;
          },

          encryptString() {
            throw new Error(
              "not used"
            );
          },

          decryptString() {
            throw new Error(
              "decryption failed"
            );
          },
        },

        userDataPath,
      });

    assert.throws(
      () => reader.load(),
      (error) => {
        assert.equal(
          error.code,
          "PROTECTED_STATE_INVALID"
        );

        return true;
      }
    );
  }
);
