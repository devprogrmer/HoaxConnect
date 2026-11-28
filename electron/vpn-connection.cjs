const path = require("node:path");
const { randomUUID } = require("node:crypto");

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (handler, delay) => setTimeout(handler, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

function validateApps(mode, apps) {
  if (mode !== "selected-only") {
    throw new Error("Only selected-only split tunnel mode can connect.");
  }
  if (!Array.isArray(apps) || apps.length === 0) {
    throw new Error("Select at least one application before connecting.");
  }

  const unique = new Set();
  for (const app of apps) {
    const executable = app?.path;
    if (
      typeof executable !== "string" ||
      !path.win32.isAbsolute(executable) ||
      path.win32.extname(executable).toLowerCase() !== ".exe"
    ) {
      throw new Error("Every selected app must use an absolute Windows executable path.");
    }
    unique.add(path.win32.normalize(executable));
  }
  return [...unique];
}

function publicState(state) {
  return JSON.parse(JSON.stringify(state));
}

function createVpnConnection({ api, service, clock = defaultClock }) {
  if (!api || !service) throw new TypeError("api and service are required");

  let state = { status: "idle", node: null, leaseExpiresAt: null, error: null };
  let leaseTimer = null;
  let activeGeneration = null;
  let connecting = null;
  let disconnecting = null;

  function cancelLeaseTimer() {
    if (leaseTimer !== null) {
      clock.clearTimeout(leaseTimer);
      leaseTimer = null;
    }
  }

  function scheduleExpiry(leaseExpiresAt, generation) {
    cancelLeaseTimer();
    const remaining = Math.max(0, Date.parse(leaseExpiresAt) - clock.now());
    const delay = Math.min(remaining, 2_147_483_647);
    leaseTimer = clock.setTimeout(async () => {
      if (activeGeneration !== generation) return;
      if (clock.now() < Date.parse(leaseExpiresAt)) {
        scheduleExpiry(leaseExpiresAt, generation);
        return;
      }
      try {
        await service.disconnect({ generation, reason: "lease_expired" });
      } finally {
        activeGeneration = null;
        state = {
          status: "error",
          node: null,
          leaseExpiresAt: null,
          error: {
            code: "VPN_LEASE_EXPIRED",
            message: "The protected VPN lease expired.",
          },
        };
      }
    }, delay);
    if (leaseTimer && typeof leaseTimer.unref === "function") {
      leaseTimer.unref();
    }
  }

  return Object.freeze({
    getState() {
      return publicState(state);
    },

    async connect(input) {
      if (state.status === "connecting" || state.status === "connected" || disconnecting) {
        throw new Error("A VPN connection is already active.");
      }
      const applicationPaths = validateApps(input?.mode, input?.apps);
      const generation = randomUUID();
      state = { status: "connecting", node: null, leaseExpiresAt: null, error: null };

      let remoteAuthorized = false;
      const work = (async () => {
        try {
          const identity = await service.identity();
          const authorization = await api.authorizeMulti({
            clientPublicKey: identity.publicKey, pathCount: input?.pathCount ?? 2,
          });
          remoteAuthorized = true;
          await service.connect({
            generation,
            applicationPaths,
            authorization,
          });
          activeGeneration = generation;
          state = {
            status: "connected",
            node: authorization.paths[0].node,
            paths: authorization.paths.map((path) => path.node),
            leaseExpiresAt: authorization.lease_expires_at,
            error: null,
          };
          scheduleExpiry(authorization.lease_expires_at, generation);
          return publicState(state);
        } catch (error) {
          cancelLeaseTimer();
          try {
            await service.disconnect({ generation, reason: "connect_failed" });
          } catch {}
          if (remoteAuthorized) {
            try { await api.disconnect(); } catch {}
          }
          activeGeneration = null;
          state = {
            status: "error",
            node: null,
            leaseExpiresAt: null,
            error: {
              code: "VPN_CONNECT_FAILED",
              message: error instanceof Error ? error.message : String(error),
            },
          };
          throw error;
        }
        })();
      connecting = work;
      try { return await work; } finally { if (connecting === work) connecting = null; }
    },

    async disconnect() {
      if (disconnecting) return disconnecting;
      const work = (async () => {
        if (connecting) { try { await connecting; } catch {} }
        const generation = activeGeneration;
        const hadRemoteSession = state.status === "connected" || state.status === "connecting";
        cancelLeaseTimer();
        state = { ...state, status: "disconnecting", error: null };
        let remoteError = null;
        if (hadRemoteSession) {
          try { await api.disconnect(); } catch (error) { remoteError = error; }
        }
        try {
          await service.disconnect({ generation, reason: "user_disconnect" });
        } finally {
          activeGeneration = null;
          state = { status: "idle", node: null, leaseExpiresAt: null, error: null };
        }
        if (remoteError) throw remoteError;
        return publicState(state);
      })();
      disconnecting = work;
      try { return await work; } finally { if (disconnecting === work) disconnecting = null; }
    },
  });
}

module.exports = {
  createVpnConnection,
  validateApps,
};

