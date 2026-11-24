const net = require("node:net");
const { randomUUID } = require("node:crypto");

const PIPE_PATH = "\\\\.\\pipe\\HoaxConnect.Control.v1";
const MAX_MESSAGE_BYTES = 65_536;

function createVpnServiceClient({
  connect = net.createConnection,
  timeoutMs = 5_000,
  pipePath = PIPE_PATH,
} = {}) {
  if (typeof connect !== "function") throw new TypeError("connect is required");

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const request = `${JSON.stringify({ version: 1, id, method, params })}\n`;
      if (Buffer.byteLength(request, "utf8") > MAX_MESSAGE_BYTES) {
        reject(new Error("VPN service request exceeds the maximum message size."));
        return;
      }

      let settled = false;
      let buffer = "";
      let socket;
      const timer = setTimeout(() => {
        finish(new Error("VPN service request timed out."));
      }, timeoutMs);

      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket && !socket.destroyed) socket.end();
        if (error) reject(error);
        else resolve(result);
      }

      try {
        socket = connect({ path: pipePath }, () => socket.write(request));
      } catch (error) {
        finish(new Error(`HoaxConnect VPN service is not available: ${error.message}`));
        return;
      }

      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) {
          finish(new Error("VPN service response exceeds the maximum message size."));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;

        let response;
        try {
          response = JSON.parse(buffer.slice(0, newline));
        } catch {
          finish(new Error("The VPN service returned an invalid response."));
          return;
        }
        if (!response || response.version !== 1 || response.id !== id) {
          finish(new Error("The VPN service response identifier is invalid."));
          return;
        }
        if (response.ok !== true) {
          const code = typeof response.error?.code === "string"
            ? response.error.code
            : "VPN_SERVICE_REJECTED";
          finish(new Error(`The VPN service rejected the request (${code}).`));
          return;
        }
        finish(null, response.result ?? {});
      });
      socket.on("error", (error) => {
        const message = error?.code === "ENOENT" || error?.code === "ECONNREFUSED"
          ? "HoaxConnect VPN service is not available."
          : "HoaxConnect VPN service connection failed.";
        finish(new Error(message));
      });
      socket.on("close", () => {
        if (!settled) finish(new Error("HoaxConnect VPN service closed the connection."));
      });
    });
  }

  return Object.freeze({
    status: () => call("status", {}),
    identity: () => call("identity", {}),
    connect: (params) => call("connect", params),
    disconnect: (params) => call("disconnect", params),
  });
}

module.exports = {
  createVpnServiceClient,
  PIPE_PATH,
  MAX_MESSAGE_BYTES,
};

