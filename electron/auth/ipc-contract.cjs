function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    phone:
      user.phone ?? null,
    username: user.username,
    role: user.role,
    status: user.status,
    email_verified:
      Boolean(
        user.email_verified
      ),
    phone_verified:
      Boolean(
        user.phone_verified
      ),
  };
}

function publicDevice(device) {
  if (!device) {
    return null;
  }

  return {
    id: device.id,
    device_uid:
      device.device_uid,
    name: device.name,
    platform:
      device.platform,
    os_version:
      device.os_version,
    architecture:
      device.architecture,
    client_version:
      device.client_version,
    revoked:
      Boolean(device.revoked),
    banned:
      Boolean(device.banned),
  };
}

function sanitizeAuthState(
  state
) {
  if (
    !state ||
    typeof state.status !==
      "string"
  ) {
    return {
      status: "signed_out",
      user: null,
      device: null,
    };
  }

  return {
    status:
      state.status,
    user:
      publicUser(
        state.user
      ),
    device:
      publicDevice(
        state.device
      ),
  };
}

module.exports = {
  sanitizeAuthState,
};
