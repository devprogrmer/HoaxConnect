const {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} = require("node:crypto");

function createDeviceIdentity() {
  const {
    privateKey,
    publicKey,
  } = generateKeyPairSync("ed25519");

  const publicKeyDer = publicKey.export({
    type: "spki",
    format: "der",
  });

  return Object.freeze({
    deviceUid: randomUUID(),
    privateKeyPem: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }).toString(),
    publicKeySpki: publicKey.export({
      type: "spki",
      format: "pem",
    }).toString(),
    keyFingerprint: createHash("sha256")
      .update(publicKeyDer)
      .digest("hex"),
    keyAlgorithm: "Ed25519",
  });
}

function restoreDeviceIdentity(
  deviceUid,
  privateKeyPem
) {
  if (
    typeof deviceUid !== "string" ||
    !deviceUid ||
    typeof privateKeyPem !== "string" ||
    !privateKeyPem
  ) {
    throw new TypeError("Stored device identity is invalid");
  }

  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);

  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Stored device key is not Ed25519");
  }

  const publicKeyDer = publicKey.export({
    type: "spki",
    format: "der",
  });

  return Object.freeze({
    deviceUid,
    privateKeyPem,
    publicKeySpki: publicKey.export({
      type: "spki",
      format: "pem",
    }).toString(),
    keyFingerprint: createHash("sha256")
      .update(publicKeyDer)
      .digest("hex"),
    keyAlgorithm: "Ed25519",
  });
}

function canonicalDeviceProofPayload(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("Device proof fields are required");
  }

  const fields = [
    ["version", String(input.version)],
    ["challenge_id", input.challengeId],
    ["purpose", input.purpose],
    ["nonce", input.nonce],
    ["user_id", input.userId],
    ["device_uid", input.deviceUid],
    ["key_fingerprint", input.keyFingerprint],
    ["issued_at", input.issuedAt],
    ["expires_at", input.expiresAt],
  ];

  const encoded = fields
    .map(([name, value]) => {
      const content = value ?? "";

      if (typeof content !== "string") {
        throw new TypeError(
          `Invalid device proof field: ${name}`
        );
      }

      return (
        `${name}:${Buffer.byteLength(content, "utf8")}:` +
        content
      );
    })
    .join("\n");

  return Buffer.from(
    `hoaxconnect-device-proof-v1\n${encoded}`,
    "utf8"
  );
}

function signDeviceProof(privateKeyPem, payload) {
  if (
    typeof privateKeyPem !== "string" ||
    !Buffer.isBuffer(payload)
  ) {
    throw new TypeError(
      "A device private key and proof payload are required"
    );
  }

  return sign(
    null,
    payload,
    createPrivateKey(privateKeyPem)
  ).toString("base64url");
}

module.exports = {
  createDeviceIdentity,
  restoreDeviceIdentity,
  canonicalDeviceProofPayload,
  signDeviceProof,
};
