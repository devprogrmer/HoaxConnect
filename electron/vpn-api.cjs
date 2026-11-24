const net = require("node:net");

const WIREGUARD_KEY = /^[A-Za-z0-9+/]{43}=$/;

function requiredString(value) {
  return typeof value === "string" && value.length > 0;
}

function validEndpoint(value) {
  if (!requiredString(value) || value.length > 255) return false;
  const separator = value.lastIndexOf(":");
  if (separator < 1) return false;
  const port = Number(value.slice(separator + 1));
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validateAuthorization(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !requiredString(value.vpn_session_id) ||
    !value.node ||
    !requiredString(value.node.id) ||
    !validEndpoint(value.node.endpoint) ||
    !WIREGUARD_KEY.test(value.node.public_key || "") ||
    !value.client ||
    net.isIP(value.client.assigned_ip) !== 4 ||
    !Array.isArray(value.client.dns_servers) ||
    value.client.dns_servers.some((server) => net.isIP(server) === 0) ||
    !requiredString(value.lease_expires_at) ||
    !Number.isFinite(Date.parse(value.lease_expires_at))
  ) {
    throw new Error("The Backend returned an invalid VPN authorization.");
  }

  return value;
}

function createVpnApi({ requestAuthenticated }) {
  if (typeof requestAuthenticated !== "function") {
    throw new TypeError("requestAuthenticated is required");
  }

  return Object.freeze({
    async authorize(input) {
      if (!WIREGUARD_KEY.test(input?.clientPublicKey || "")) {
        throw new Error("A valid WireGuard public key is required.");
      }
      if (
        input.countryCode !== undefined &&
        !/^[A-Z]{2}$/.test(input.countryCode)
      ) {
        throw new Error("A valid country code is required.");
      }
      if (
        input.region !== undefined &&
        (!requiredString(input.region) || input.region.length > 100)
      ) {
        throw new Error("A valid region is required.");
      }

      const payload = {
        client_public_key: input.clientPublicKey,
        ...(input.countryCode ? { country_code: input.countryCode } : {}),
        ...(input.region ? { region: input.region } : {}),
      };
      return validateAuthorization(
        await requestAuthenticated("/api/v1/vpn/authorize", payload),
      );
    },

    async disconnect() {
      const result = await requestAuthenticated(
        "/api/v1/vpn/disconnect",
        {},
      );
      if (!result || typeof result.disconnected !== "boolean") {
        throw new Error("The Backend returned an invalid VPN disconnect response.");
      }
      return result;
    },
  });
}

module.exports = {
  createVpnApi,
  validateAuthorization,
};

