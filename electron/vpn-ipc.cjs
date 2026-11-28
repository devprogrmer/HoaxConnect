function safeFailure(code, error) {
  const message = error instanceof Error ? error.message : String(error || "VPN request failed.");
  return {
    ok: false,
    error: {
      code,
      message: message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240),
    },
  };
}

function normalizeLocation(input) {
  const location = input?.location;
  if (!location || typeof location !== "object") return {};
  return {
    ...(typeof location.countryCode === "string"
      ? { countryCode: location.countryCode }
      : {}),
    ...(typeof location.region === "string" ? { region: location.region } : {}),
    ...(Number.isInteger(location.pathCount) && location.pathCount >= 2 && location.pathCount <= 5
      ? { pathCount: location.pathCount } : {}),
  };
}

function createVpnIpcHandlers({ connection, readSplitState }) {
  if (!connection || typeof readSplitState !== "function") {
    throw new TypeError("connection and readSplitState are required");
  }
  return Object.freeze({
    status() {
      return { ok: true, state: connection.getState() };
    },
    async connect(input) {
      try {
        const split = readSplitState();
        const state = await connection.connect({
          mode: split.mode,
          apps: split.selectedApps,
          ...normalizeLocation(input),
        });
        return { ok: true, state };
      } catch (error) {
        return safeFailure("VPN_CONNECT_FAILED", error);
      }
    },
    async disconnect() {
      try {
        return { ok: true, state: await connection.disconnect() };
      } catch (error) {
        return safeFailure("VPN_DISCONNECT_FAILED", error);
      }
    },
  });
}

module.exports = {
  createVpnIpcHandlers,
};

