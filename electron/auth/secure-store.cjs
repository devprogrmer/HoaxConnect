const fs = require("node:fs");
const path = require("node:path");
const {
  randomBytes,
} = require("node:crypto");

const STATE_FILE =
  "auth-state.enc";

function authError(
  code,
  message,
  cause
) {
  const error =
    new Error(message);

  error.code = code;

  if (cause) {
    error.cause = cause;
  }

  return error;
}

function requireEncryption(
  safeStorage
) {
  if (
    !safeStorage ||
    typeof safeStorage
      .isEncryptionAvailable !==
      "function" ||
    !safeStorage
      .isEncryptionAvailable()
  ) {
    throw authError(
      "SECURE_STORAGE_UNAVAILABLE",
      "Secure credential storage is unavailable."
    );
  }
}

function validateState(state) {
  const pending = state && state.pendingRotation;
  const pendingFields = [
    "refresh_token",
    "challenge_id",
    "flow_token",
    "nonce",
    "signature",
    "recovery_id",
    "recovery_secret",
  ];

  if (
    !state ||
    state.version !== 1 ||
    typeof state.deviceUid !== "string" ||
    !state.deviceUid ||
    typeof state.devicePrivateKey !== "string" ||
    !state.devicePrivateKey ||
    !(
      state.refreshToken === null ||
      (typeof state.refreshToken === "string" &&
        state.refreshToken.length > 0)
    ) ||
    (pending !== undefined &&
      pending !== null &&
      (!pending ||
        typeof pending !== "object" ||
        pendingFields.some(
          (field) =>
            typeof pending[field] !== "string" ||
            pending[field].length === 0
        ))) ||
    (state.user !== undefined &&
      state.user !== null &&
      (typeof state.user !== "object" ||
        typeof state.user.id !== "string")) ||
    (state.device !== undefined &&
      state.device !== null &&
      (typeof state.device !== "object" ||
        typeof state.device.id !== "string"))
  ) {
    throw authError(
      "PROTECTED_STATE_INVALID",
      "Protected authentication state is invalid."
    );
  }

  const validated = {
    version: 1,
    deviceUid: state.deviceUid,
    devicePrivateKey: state.devicePrivateKey,
    refreshToken: state.refreshToken,
  };

  if (Object.prototype.hasOwnProperty.call(state, "pendingRotation")) {
    validated.pendingRotation = pending || null;
  }
  if (Object.prototype.hasOwnProperty.call(state, "user")) {
    validated.user = state.user || null;
  }
  if (Object.prototype.hasOwnProperty.call(state, "device")) {
    validated.device = state.device || null;
  }

  return validated;
}

function createProtectedAuthStore({
  safeStorage,
  userDataPath,
  fileSystem = fs,
}) {
  if (
    typeof userDataPath !==
      "string" ||
    !userDataPath
  ) {
    throw new TypeError(
      "userDataPath is required"
    );
  }

  const statePath =
    path.join(
      userDataPath,
      STATE_FILE
    );

  function save(input) {
    requireEncryption(
      safeStorage
    );

    const state =
      validateState(input);

    let encrypted;

    try {
      encrypted =
        safeStorage.encryptString(
          JSON.stringify(state)
        );
    } catch (error) {
      throw authError(
        "SECURE_STORAGE_WRITE_FAILED",
        "Authentication state could not be protected.",
        error
      );
    }

    if (
      !Buffer.isBuffer(encrypted) ||
      encrypted.length === 0
    ) {
      throw authError(
        "SECURE_STORAGE_WRITE_FAILED",
        "Authentication state could not be protected."
      );
    }

    fileSystem.mkdirSync(
      userDataPath,
      {
        recursive: true,
        mode: 0o700,
      }
    );

    const temporaryPath =
      `${statePath}.${process.pid}.` +
      `${randomBytes(8).toString("hex")}.tmp`;

    try {
      fileSystem.writeFileSync(
        temporaryPath,
        encrypted,
        {
          mode: 0o600,
          flag: "wx",
        }
      );

      fileSystem.renameSync(
        temporaryPath,
        statePath
      );
    } catch (error) {
      try {
        fileSystem.rmSync(
          temporaryPath,
          {
            force: true,
          }
        );
      } catch {}

      throw authError(
        "SECURE_STORAGE_WRITE_FAILED",
        "Authentication state could not be saved.",
        error
      );
    }
  }

  function load() {
    if (
      !fileSystem.existsSync(
        statePath
      )
    ) {
      return null;
    }

    requireEncryption(
      safeStorage
    );

    try {
      const encrypted =
        fileSystem.readFileSync(
          statePath
        );

      const plaintext =
        safeStorage.decryptString(
          encrypted
        );

      return validateState(
        JSON.parse(plaintext)
      );
    } catch (error) {
      if (
        error &&
        error.code ===
          "SECURE_STORAGE_UNAVAILABLE"
      ) {
        throw error;
      }

      throw authError(
        "PROTECTED_STATE_INVALID",
        "Protected authentication state is corrupt or unavailable.",
        error
      );
    }
  }

  function clear() {
    try {
      fileSystem.rmSync(
        statePath,
        {
          force: true,
        }
      );
    } catch (error) {
      throw authError(
        "SECURE_STORAGE_CLEAR_FAILED",
        "Protected authentication state could not be cleared.",
        error
      );
    }
  }

  return Object.freeze({
    save,
    load,
    clear,
  });
}

module.exports = {
  createProtectedAuthStore,
};
