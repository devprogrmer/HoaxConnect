const baseUrl =
  process.env.HOAXCONNECT_API_URL ||
  "http://127.0.0.1:3100";

const suffix = `${Date.now()}-${Math.random()
  .toString(16)
  .slice(2)}`;

const email = `stage2a-smoke-${suffix}@example.invalid`;
const username = `smoke_${Date.now()}`;
const password = "Stage2A-Real-Smoke-Password-947!";
const deviceUid = `stage2a-device-${suffix}`;

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});

  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers
  });

  const body = await response.json();

  return {
    response,
    body
  };
}

function requireStatus(result, expected, label) {
  if (result.response.status !== expected) {
    throw new Error(
      `${label}: expected ${expected}, got ` +
      `${result.response.status}: ${JSON.stringify(result.body)}`
    );
  }

  if (!result.response.headers.get("x-request-id")) {
    throw new Error(`${label}: x-request-id is missing`);
  }
}

const registration = await request("/api/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({
    email,
    username,
    password,
    device: {
      uid: deviceUid,
      name: "Stage 2A Smoke Device",
      os: "Windows",
      client_version: "0.3.9"
    }
  })
});

requireStatus(registration, 201, "register");

const firstTokens = registration.body.data.tokens;

if (!firstTokens?.accessToken || !firstTokens?.refreshToken) {
  throw new Error(
    "Registration did not return tokens while verification is disabled"
  );
}

const me = await request("/api/v1/client/me", {
  headers: {
    authorization: `Bearer ${firstTokens.accessToken}`
  }
});

requireStatus(me, 200, "me");

const rotation = await request("/api/v1/auth/refresh", {
  method: "POST",
  body: JSON.stringify({
    refresh_token: firstTokens.refreshToken
  })
});

requireStatus(rotation, 200, "refresh");

const secondTokens = rotation.body.data.tokens;

const reuse = await request("/api/v1/auth/refresh", {
  method: "POST",
  body: JSON.stringify({
    refresh_token: firstTokens.refreshToken
  })
});

requireStatus(reuse, 401, "refresh reuse");

if (reuse.body.error?.code !== "REFRESH_TOKEN_REUSED") {
  throw new Error(
    `Unexpected reuse error: ${JSON.stringify(reuse.body)}`
  );
}

const familyRevoked = await request("/api/v1/auth/refresh", {
  method: "POST",
  body: JSON.stringify({
    refresh_token: secondTokens.refreshToken
  })
});

requireStatus(familyRevoked, 401, "compromised family");

const login = await request("/api/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({
    identifier: email,
    password,
    device: {
      uid: deviceUid,
      name: "Stage 2A Smoke Device",
      os: "Windows",
      client_version: "0.3.9"
    }
  })
});

requireStatus(login, 200, "login");

const loginTokens = login.body.data.tokens;

const logout = await request("/api/v1/auth/logout", {
  method: "POST",
  headers: {
    authorization: `Bearer ${loginTokens.accessToken}`
  }
});

requireStatus(logout, 200, "logout");

const revokedAccess = await request("/api/v1/client/me", {
  headers: {
    authorization: `Bearer ${loginTokens.accessToken}`
  }
});

requireStatus(revokedAccess, 401, "revoked access");

const secondLogin = await request("/api/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({
    identifier: username,
    password,
    device: {
      uid: deviceUid,
      name: "Stage 2A Smoke Device",
      os: "Windows",
      client_version: "0.3.9"
    }
  })
});

requireStatus(secondLogin, 200, "second login");

const activeTokens = secondLogin.body.data.tokens;

const devices = await request("/api/v1/client/devices", {
  headers: {
    authorization: `Bearer ${activeTokens.accessToken}`
  }
});

requireStatus(devices, 200, "list devices");

const device = devices.body.data.find(
  (item) => item.device_uid === deviceUid
);

if (!device) {
  throw new Error("Smoke-test device was not returned");
}

const revoke = await request(
  `/api/v1/client/devices/${device.id}`,
  {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${activeTokens.accessToken}`
    }
  }
);

requireStatus(revoke, 200, "soft revoke device");

const afterRevoke = await request("/api/v1/client/me", {
  headers: {
    authorization: `Bearer ${activeTokens.accessToken}`
  }
});

requireStatus(afterRevoke, 401, "access after device revoke");

console.log(`SMOKE_USER_EMAIL=${email}`);
console.log("AUTH_SMOKE_TEST_PASSED");
