const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  resolveBackendBaseUrl,
} = require("../auth/backend-url.cjs");

const {
  createDeviceIdentity,
  restoreDeviceIdentity,
  canonicalDeviceProofPayload,
  signDeviceProof,
} = require("../auth/device-identity.cjs");

test("development uses the local Backend only when no URL is configured", () => {
  assert.equal(
    resolveBackendBaseUrl({
      isPackaged: false,
      configuredUrl: "",
    }),
    "http://127.0.0.1:3100"
  );
});

test("packaged app defaults to HoaxConnect HTTPS Backend and accepts an override", () => {
  assert.equal(
    resolveBackendBaseUrl({
      isPackaged: true,
      configuredUrl: "",
    }),
    "https://hoaxnet.ir"
  );

  assert.equal(
    resolveBackendBaseUrl({
      isPackaged: true,
      configuredUrl: "https://api.example.com/",
    }),
    "https://api.example.com"
  );

});

test("Backend URL policy rejects insecure, local, IP, and credential URLs in production", () => {
  for (const configuredUrl of [
    "http://api.example.com",
    "https://127.0.0.1",
    "https://localhost",
    "https://user:password@api.example.com",
  ]) {
    assert.throws(
      () =>
        resolveBackendBaseUrl({
          isPackaged: true,
          configuredUrl,
        })
    );
  }
});

test("development URL configuration cannot select a remote HTTP endpoint", () => {
  assert.throws(
    () =>
      resolveBackendBaseUrl({
        isPackaged: false,
        configuredUrl: "http://198.51.100.20:3100",
      })
  );
});

test("device identity creates an Ed25519 key and a matching SHA-256 fingerprint", () => {
  const identity = createDeviceIdentity();

  assert.match(identity.deviceUid, /^[0-9a-f-]{36}$/i);
  assert.match(identity.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.match(identity.publicKeySpki, /BEGIN PUBLIC KEY/);
  assert.equal(identity.keyAlgorithm, "Ed25519");

  const publicKey = crypto.createPublicKey(identity.publicKeySpki);
  const publicKeyDer = publicKey.export({
    type: "spki",
    format: "der",
  });
  const expectedFingerprint = crypto
    .createHash("sha256")
    .update(publicKeyDer)
    .digest("hex");

  assert.equal(identity.keyFingerprint, expectedFingerprint);
});

test("canonical device-proof payload matches Backend byte-length framing", () => {
  const payload = canonicalDeviceProofPayload({
    version: 1,
    challengeId: "challenge-id",
    purpose: "login",
    nonce: "nonce-value",
    userId: "user-id",
    deviceUid: "device-id",
    keyFingerprint: "fingerprint",
    issuedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-09-30T00:05:00.000Z",
  });

  const expected =
    "hoaxconnect-device-proof-v1\n" +
    "version:1:1\n" +
    "challenge_id:12:challenge-id\n" +
    "purpose:5:login\n" +
    "nonce:11:nonce-value\n" +
    "user_id:7:user-id\n" +
    "device_uid:9:device-id\n" +
    "key_fingerprint:11:fingerprint\n" +
    "issued_at:24:2026-09-30T00:00:00.000Z\n" +
    "expires_at:24:2026-09-30T00:05:00.000Z";

  assert.equal(payload.toString("utf8"), expected);
});

test("device proof is signed by the private key corresponding to the public identity", () => {
  const identity = createDeviceIdentity();
  const proof = {
    version: 1,
    challengeId: "challenge-id",
    purpose: "login",
    nonce: "nonce-value",
    userId: "user-id",
    deviceUid: identity.deviceUid,
    keyFingerprint: identity.keyFingerprint,
    issuedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-09-30T00:05:00.000Z",
  };

  const payload = canonicalDeviceProofPayload(proof);
  const signature = signDeviceProof(
    identity.privateKeyPem,
    payload
  );

  assert.equal(
    crypto.verify(
      null,
      payload,
      crypto.createPublicKey(identity.publicKeySpki),
      Buffer.from(signature, "base64url")
    ),
    true
  );
});


test(
  "restored device identity derives the same public key and fingerprint",
  () => {
    const original = createDeviceIdentity();
    const restored = restoreDeviceIdentity(
      original.deviceUid,
      original.privateKeyPem
    );

    assert.equal(restored.deviceUid, original.deviceUid);
    assert.equal(restored.publicKeySpki, original.publicKeySpki);
    assert.equal(restored.keyFingerprint, original.keyFingerprint);
    assert.equal(restored.keyAlgorithm, "Ed25519");
  }
);
