const net = require("node:net");

function backendUrlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveBackendBaseUrl({
  isPackaged,
  configuredUrl = "",
}) {
  const configured =
    typeof configuredUrl === "string"
      ? configuredUrl.trim()
      : "";

  const effectiveUrl =
    configured ||
    (isPackaged ? "https://hoaxnet.ir" : "");

  if (!effectiveUrl && !isPackaged) {
    return "http://127.0.0.1:3100";
  }

  if (!effectiveUrl) {
    throw backendUrlError(
      "BACKEND_API_URL_UNCONFIGURED",
      "The secure Backend address is not configured."
    );
  }

  let parsed;

  try {
    parsed = new URL(effectiveUrl);
  } catch {
    throw backendUrlError(
      "BACKEND_API_URL_INVALID",
      "The Backend address is invalid."
    );
  }

  const hostname = parsed.hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();

  const isLocalHost =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1";

  const isIpAddress = net.isIP(hostname) !== 0;

  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" &&
      parsed.pathname !== "/")
  ) {
    throw backendUrlError(
      "BACKEND_API_URL_INVALID",
      "The Backend address is invalid."
    );
  }

  if (isPackaged) {
    if (
      parsed.protocol !== "https:" ||
      isLocalHost ||
      isIpAddress
    ) {
      throw backendUrlError(
        "BACKEND_API_URL_INVALID",
        "The packaged app requires an HTTPS Backend hostname."
      );
    }
  } else if (
    parsed.protocol === "http:" &&
    !isLocalHost
  ) {
    throw backendUrlError(
      "BACKEND_API_URL_INVALID",
      "Development HTTP is allowed only for a local Backend."
    );
  } else if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw backendUrlError(
      "BACKEND_API_URL_INVALID",
      "The Backend address must use HTTP or HTTPS."
    );
  }

  return parsed.origin;
}

module.exports = {
  resolveBackendBaseUrl,
};
