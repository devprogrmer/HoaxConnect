const os = require("node:os");
const { randomBytes, randomUUID } = require("node:crypto");

const {
  createProtectedAuthStore,
} = require("./secure-store.cjs");
const {
  sanitizeAuthState,
} = require("./ipc-contract.cjs");
const {
  resolveBackendBaseUrl,
} = require("./backend-url.cjs");
const {
  createDeviceIdentity,
  restoreDeviceIdentity,
  canonicalDeviceProofPayload,
  signDeviceProof,
} = require("./device-identity.cjs");

const ERROR_MESSAGES = Object.freeze({
  SECURE_STORAGE_UNAVAILABLE:
    "Secure credential storage is unavailable.",
  SECURE_STORAGE_WRITE_FAILED:
    "Authentication state could not be protected.",
  BACKEND_API_URL_UNCONFIGURED:
    "The Backend address is not configured.",
  BACKEND_API_URL_INVALID:
    "The Backend address is invalid.",
  BACKEND_UNAVAILABLE:
    "HoaxConnect could not reach the Backend. Check your connection and try again.",
  INVALID_CREDENTIALS:
    "The account or password is incorrect.",
  DEVICE_LIMIT_EXCEEDED:
    "The account has reached its device limit.",
  EMAIL_VERIFICATION_REQUIRED:
    "Verify your email address before signing in.",
  ACCOUNT_SUSPENDED:
    "This account is suspended. Contact support for assistance.",
  ACCOUNT_BANNED:
    "This account cannot sign in. Contact support for assistance.",
  DEVICE_REVOKED:
    "This device has been revoked. Sign in with an authorized device.",
  ACCOUNT_ALREADY_EXISTS:
    "An account with this email or username already exists. Sign in instead.",
  AUTH_RESPONSE_INVALID:
    "The Backend returned an invalid authentication response.",
  AUTH_REJECTED:
    "Authentication could not be completed.",
});

const PASSTHROUGH_ERROR_CODES = new Set([
  "INVALID_CREDENTIALS",
  "DEVICE_LIMIT_EXCEEDED",
  "ACCOUNT_ALREADY_EXISTS",
  "EMAIL_VERIFICATION_REQUIRED",
  "ACCOUNT_SUSPENDED",
  "ACCOUNT_BANNED",
  "DEVICE_REVOKED",
  "SECURE_STORAGE_UNAVAILABLE",
  "SECURE_STORAGE_WRITE_FAILED",
  "BACKEND_API_URL_UNCONFIGURED",
  "BACKEND_API_URL_INVALID",
  "BACKEND_UNAVAILABLE",
  "AUTH_RESPONSE_INVALID",
]);

function authError(code, diagnostic = "") {
  const error = new Error(
    ERROR_MESSAGES[code] ||
      ERROR_MESSAGES.AUTH_REJECTED
  );
  error.code = code;
  if (
    typeof diagnostic === "string" &&
    /^[a-z0-9_, -]{1,160}$/.test(diagnostic)
  ) {
    error.authDiagnostic = diagnostic;
  }
  return error;
}

function safeError(error) {
  const diagnosticCode =
    error &&
    typeof error.backendCode === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(error.backendCode)
      ? error.backendCode
      : "";
  const code =
    error &&
    PASSTHROUGH_ERROR_CODES.has(error.code)
      ? error.code
      : diagnosticCode
        ? "BACKEND_REJECTED"
        : "AUTH_REJECTED";

  return {
    code,
    message:
      error &&
      error.code === "AUTH_RESPONSE_INVALID" &&
      typeof error.authDiagnostic === "string"
        ? `Backend response check failed: ${error.authDiagnostic}.`
        : diagnosticCode
        ? `The Backend rejected the request (${diagnosticCode}).`
        : ERROR_MESSAGES[code] ||
          ERROR_MESSAGES.AUTH_REJECTED,
  };
}

function responseData(body) {
  if (
    !body ||
    typeof body !== "object" ||
    !body.data ||
    typeof body.data !== "object"
  ) {
    throw authError(
      "AUTH_RESPONSE_INVALID",
      "data envelope missing"
    );
  }

  return body.data;
}

function validateProof(proof, identity, purpose) {
  const invalid = [];
  if (!proof || typeof proof !== "object") {
    invalid.push("proof missing");
  } else {
    if (proof.purpose !== purpose) invalid.push("purpose mismatch");
    if (proof.key_fingerprint !== identity.keyFingerprint) {
      invalid.push("key fingerprint mismatch");
    }
    for (const field of [
      "challenge_id",
      "nonce",
      "flow_token",
      "issued_at",
      "expires_at",
    ]) {
      if (typeof proof[field] !== "string") {
        invalid.push(`${field} missing`);
      }
    }
  }

  if (invalid.length) {
    throw authError(
      "AUTH_RESPONSE_INVALID",
      invalid.join(", ")
    );
  }
}

function createElectronAuthOwner({
  safeStorage,
  userDataPath,
  isPackaged = false,
  configuredBackendUrl =
    process.env.HOAXCONNECT_BACKEND_URL || "",
  fetchImpl = globalThis.fetch,
  deviceInfo = {},
}) {
  const store = createProtectedAuthStore({
    safeStorage,
    userDataPath,
  });

  let accessToken = null;
  let operations = Promise.resolve();
  function serial(operation) {
    const result = operations.then(operation);
    operations = result.catch(() => {});
    return result;
  }
  let currentState = sanitizeAuthState({
    status: "signed_out",
  });

  function loadOrCreateDeviceIdentity() {
    const stored = store.load();

    if (stored) {
      const restored = restoreDeviceIdentity(
        stored.deviceUid,
        stored.devicePrivateKey
      );

      return {
        ...stored,
        publicKeySpki: restored.publicKeySpki,
        keyFingerprint: restored.keyFingerprint,
        keyAlgorithm: restored.keyAlgorithm,
      };
    }

    const generated = createDeviceIdentity();
    const initialState = {
      version: 1,
      deviceUid: generated.deviceUid,
      devicePrivateKey: generated.privateKeyPem,
      refreshToken: null,
    };

    // Persist the identity before sending a registration or login request.
    store.save(initialState);

    return {
      ...initialState,
      publicKeySpki: generated.publicKeySpki,
      keyFingerprint: generated.keyFingerprint,
      keyAlgorithm: generated.keyAlgorithm,
    };
  }

  function backendDevice(identity) {
    const platform =
      deviceInfo.platform || process.platform;

    return {
      uid: identity.deviceUid,
      name:
        deviceInfo.name ||
        "HoaxConnect Desktop",
      os:
        deviceInfo.os ||
        (platform === "win32"
          ? "windows"
          : platform),
      platform,
      os_version:
        deviceInfo.osVersion ||
        os.release(),
      architecture:
        deviceInfo.architecture ||
        process.arch,
      client_version:
        deviceInfo.clientVersion ||
        "0.0.0",
      public_key_spki:
        identity.publicKeySpki,
    };
  }

  async function postJson(pathname, payload, bearerToken = null) {
    if (typeof fetchImpl !== "function") {
      throw authError("BACKEND_UNAVAILABLE");
    }

    const baseUrl = resolveBackendBaseUrl({
      isPackaged,
      configuredUrl: configuredBackendUrl,
    });
    const url = new URL(
      pathname.replace(/^\/+/, ""),
      `${baseUrl}/`
    );

    let response;

    try {
      response = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(bearerToken
            ? { authorization: `Bearer ${bearerToken}` }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw authError("BACKEND_UNAVAILABLE");
    }

    let body;

    try {
      body = await response.json();
    } catch {
      throw authError("AUTH_RESPONSE_INVALID");
    }

    if (!response.ok) {
      const backendCode =
        body &&
        body.error &&
        typeof body.error.code === "string"
          ? body.error.code
          : "";

      if (
        PASSTHROUGH_ERROR_CODES.has(backendCode)
      ) {
        throw authError(backendCode);
      }

      const error = authError("AUTH_REJECTED");
      if (backendCode) {
        error.backendCode = backendCode;
      }
      throw error;
    }

    return responseData(body);
  }

  async function authenticate(kind, input) {
    try {
      if (
        !input ||
        typeof input !== "object" ||
        typeof input.password !== "string" ||
        input.password.length === 0
      ) {
        throw authError("AUTH_REJECTED");
      }

      if (
        kind === "login" &&
        (typeof input.identifier !== "string" ||
          input.identifier.trim().length < 3)
      ) {
        throw authError("AUTH_REJECTED");
      }

      if (
        kind === "register" &&
        (typeof input.email !== "string" ||
          typeof input.phone !== "string" ||
          !/^\+[1-9][0-9]{7,14}$/.test(input.phone) ||
          typeof input.username !== "string")
      ) {
        throw authError("AUTH_REJECTED");
      }

      const identity =
        loadOrCreateDeviceIdentity();
      const device = backendDevice(identity);
      const startPath =
        kind === "register"
          ? "/api/v1/auth/register"
          : "/api/v1/auth/login";

      const startPayload =
        kind === "register"
          ? {
              email: input.email,
              phone: input.phone,
              username: input.username,
              password: input.password,
              device,
            }
          : {
              identifier: input.identifier,
              password: input.password,
              device,
            };

      const started = await postJson(
        startPath,
        startPayload
      );

      const purpose =
        kind === "register"
          ? "enrollment"
          : started.proof &&
              ["enrollment", "login"].includes(
                started.proof.purpose
              )
            ? started.proof.purpose
            : "login";

      validateProof(
        started.proof,
        identity,
        purpose
      );

      const proof = started.proof;
      const signedPayload =
        canonicalDeviceProofPayload({
          version: 1,
          challengeId: proof.challenge_id,
          purpose: proof.purpose,
          nonce: proof.nonce,
          userId: started.user.id,
          deviceUid: identity.deviceUid,
          keyFingerprint:
            identity.keyFingerprint,
          issuedAt: proof.issued_at,
          expiresAt: proof.expires_at,
        });

      const signature = signDeviceProof(
        identity.devicePrivateKey,
        signedPayload
      );

      const completed = await postJson(
        "/api/v1/auth/device-proof",
        {
          challenge_id: proof.challenge_id,
          flow_token: proof.flow_token,
          nonce: proof.nonce,
          signature,
        }
      );

      if (
        !completed.tokens ||
        typeof completed.tokens.accessToken !==
          "string" ||
        typeof completed.tokens.refreshToken !==
          "string" ||
        typeof completed.tokens.sessionId !==
          "string"
      ) {
        throw authError(
          "AUTH_RESPONSE_INVALID",
          "completed tokens missing"
        );
      }

      store.save({
        version: 1,
        deviceUid: identity.deviceUid,
        devicePrivateKey:
          identity.devicePrivateKey,
        refreshToken:
          completed.tokens.refreshToken,
        pendingRotation: null,
        user: completed.user,
        device: completed.device,
      });

      accessToken =
        completed.tokens.accessToken;

      currentState = sanitizeAuthState({
        status: "authenticated",
        user: completed.user,
        device: completed.device,
      });

      return {
        ok: true,
        state: currentState,
        verificationRequired:
          Boolean(started.verification_required),
      };
    } catch (error) {
      return {
        ok: false,
        error: safeError(error),
      };
    }
  }

  async function restore() {
    try {
      const stored = store.load();

      if (
        !stored ||
        !stored.refreshToken ||
        !stored.user ||
        !stored.device
      ) {
        throw authError("PROTECTED_STATE_INVALID");
      }

      const identity = restoreDeviceIdentity(
        stored.deviceUid,
        stored.devicePrivateKey
      );

      let rotation = stored.pendingRotation;

      if (!rotation) {
        const challenge = await postJson(
          "/api/v1/auth/refresh/challenge",
          { refresh_token: stored.refreshToken }
        );

        validateProof(challenge.proof, identity, "refresh");
        const proof = challenge.proof;
        const signedPayload = canonicalDeviceProofPayload({
          version: 1,
          challengeId: proof.challenge_id,
          purpose: proof.purpose,
          nonce: proof.nonce,
          userId: stored.user.id,
          deviceUid: identity.deviceUid,
          keyFingerprint: identity.keyFingerprint,
          issuedAt: proof.issued_at,
          expiresAt: proof.expires_at,
        });

        rotation = {
          refresh_token: stored.refreshToken,
          challenge_id: proof.challenge_id,
          flow_token: proof.flow_token,
          nonce: proof.nonce,
          signature: signDeviceProof(
            stored.devicePrivateKey,
            signedPayload
          ),
          recovery_id: randomUUID(),
          recovery_secret:
            randomBytes(32).toString("base64url"),
        };

        // Persist the exact retry request before the server can rotate tokens.
        store.save({
          ...stored,
          pendingRotation: rotation,
        });
      }

      const rotated = await postJson(
        "/api/v1/auth/refresh",
        rotation
      );

      if (
        !rotated.tokens ||
        typeof rotated.tokens.accessToken !== "string" ||
        typeof rotated.tokens.refreshToken !== "string" ||
        typeof rotated.tokens.sessionId !== "string"
      ) {
        throw authError("AUTH_RESPONSE_INVALID");
      }

      store.save({
        ...stored,
        refreshToken: rotated.tokens.refreshToken,
        pendingRotation: null,
      });

      accessToken = rotated.tokens.accessToken;
      currentState = sanitizeAuthState({
        status: "authenticated",
        user: stored.user,
        device: stored.device,
      });

      return {
        ok: true,
        state: currentState,
      };
    } catch (error) {
      return {
        ok: false,
        error: safeError(error),
      };
    }
  }

  async function revokeAndClear(pathname) {
    let remoteRevoked = false;
    let remoteError = null;

    if (accessToken) {
      try {
        await postJson(pathname, {}, accessToken);
        remoteRevoked = true;
      } catch (error) {
        remoteError = safeError(error);
      }
    }

    try {
      const stored = store.load();
      if (stored) {
        store.save({
          version: 1,
          deviceUid: stored.deviceUid,
          devicePrivateKey: stored.devicePrivateKey,
          refreshToken: null,
          pendingRotation: null,
          user: null,
          device: null,
        });
      }
    } catch (error) {
      return {
        ok: false,
        error: safeError(error),
      };
    }

    accessToken = null;
    currentState = sanitizeAuthState({
      status: "signed_out",
    });

    return {
      ok: true,
      state: currentState,
      remoteRevoked,
      ...(remoteError ? { warning: remoteError } : {}),
    };
  }

  function logout() {
    return revokeAndClear("/api/v1/auth/logout");
  }

  function logoutAll() {
    return revokeAndClear("/api/v1/auth/logout-all");
  }

  function getState() {
    try {
      if (accessToken && currentState.status === "authenticated") {
        return { ok: true, state: currentState };
      }
      const stored = store.load();

      if (stored && stored.refreshToken) {
        return {
          ok: true,
          state: sanitizeAuthState({
            status: "restore_required",
          }),
        };
      }

      return {
        ok: true,
        state: sanitizeAuthState({
          status: "signed_out",
        }),
      };
    } catch (error) {
      return {
        ok: false,
        error: safeError(error),
      };
    }
  }

  return Object.freeze({
    getState,
    restore: () => serial(restore),
    logout: () => serial(logout),
    logoutAll: () => serial(logoutAll),
    login(input) {
      return serial(() => authenticate("login", input));
    },
    register(input) {
      return serial(() => authenticate("register", input));
    },
    reportDeviceState(payload, expectedDeviceId) {
      return serial(async () => {
        if (!accessToken || currentState.device?.id !== expectedDeviceId) {
          return { ok: false, error: { code: "SIGNED_OUT" } };
        }
        try {
          try {
            await postJson("/api/v1/client/device-report", payload, accessToken);
          } catch (error) {
            if (error.backendCode !== "INVALID_ACCESS_TOKEN") throw error;
            const renewed = await restore();
            if (!renewed.ok) return renewed;
            await postJson("/api/v1/client/device-report", payload, accessToken);
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      });
    },
    getDeviceIdForMainProcess() {
      return accessToken ? currentState.device?.id || null : null;
    },
    getAccessTokenForMainProcess() {
      return accessToken;
    },
  });
}

module.exports = {
  createElectronAuthOwner,
};
