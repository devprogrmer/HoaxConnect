import "./setup.ts";

import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeJwt,
  SignJWT,
} from "jose";

process.env.JWT_ISSUER = "https://api.hoaxconnect.test";
process.env.JWT_AUDIENCE = "hoaxconnect-desktop";

const migrationPath =
  new URL("../migrations/002_stage2c_auth_devices.sql", import.meta.url);
const accountScopedDeviceMigrationPath =
  new URL("../migrations/003_account_scoped_device_keys.sql", import.meta.url);

test("Stage 2C migration exists", () => {
  assert.equal(
    existsSync(migrationPath),
    true,
    "002_stage2c_auth_devices.sql is required"
  );
});

test("Stage 2C migration contains required auth contracts", () => {
  assert.equal(existsSync(migrationPath), true);

  const sql = readFileSync(migrationPath, "utf8");

  for (const marker of [
    "phone_normalized",
    "public_key_spki",
    "key_fingerprint",
    "device_challenges",
    "device_limit_violations",
    "policy_events",
    "refresh_rotation_recoveries",
    "recovery_secret_hash",
  ]) {
    assert.match(sql, new RegExp(`\\b${marker}\\b`));
  }
});

test("device key uniqueness is scoped to each account", () => {
  assert.equal(
    existsSync(accountScopedDeviceMigrationPath),
    true,
    "003_account_scoped_device_keys.sql is required"
  );

  const sql = readFileSync(
    accountScopedDeviceMigrationPath,
    "utf8"
  );

  assert.match(sql, /DROP INDEX IF EXISTS devices_key_fingerprint_unique/i);
  assert.match(sql, /UNIQUE INDEX devices_user_key_fingerprint_unique/i);
  assert.match(sql, /ON devices\s*\(user_id,\s*key_fingerprint\)/i);
});

test("access tokens bind issuer and audience", async () => {
  const {
    signAccessToken,
  } = await import("../src/security.js");

  const token = await signAccessToken({
    sub: "11111111-1111-4111-8111-111111111111",
    sid: "22222222-2222-4222-8222-222222222222",
    did: "33333333-3333-4333-8333-333333333333",
    role: "user",
    auth_version: 1,
  });

  const payload = decodeJwt(token);

  assert.equal(
    payload.iss,
    process.env.JWT_ISSUER
  );
  assert.deepEqual(
    payload.aud,
    process.env.JWT_AUDIENCE
  );
});

test("access-token verification rejects another issuer", async () => {
  const {
    verifyAccessToken,
  } = await import("../src/security.js");

  const secret = new TextEncoder().encode(
    process.env.JWT_ACCESS_SECRET
  );

  const token = await new SignJWT({
    sid: "22222222-2222-4222-8222-222222222222",
    did: "33333333-3333-4333-8333-333333333333",
    role: "user",
    auth_version: 1,
  })
    .setProtectedHeader({
      alg: "HS256",
      typ: "JWT",
    })
    .setSubject(
      "11111111-1111-4111-8111-111111111111"
    )
    .setIssuer("https://attacker.invalid")
    .setAudience(
      process.env.JWT_AUDIENCE!
    )
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);

  await assert.rejects(
    () => verifyAccessToken(token),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "INVALID_ACCESS_TOKEN"
      );
    }
  );
});

test("access-token verification rejects another audience", async () => {
  const {
    verifyAccessToken,
  } = await import("../src/security.js");

  const secret = new TextEncoder().encode(
    process.env.JWT_ACCESS_SECRET
  );

  const token = await new SignJWT({
    sid: "22222222-2222-4222-8222-222222222222",
    did: "33333333-3333-4333-8333-333333333333",
    role: "user",
    auth_version: 1,
  })
    .setProtectedHeader({
      alg: "HS256",
      typ: "JWT",
    })
    .setSubject(
      "11111111-1111-4111-8111-111111111111"
    )
    .setIssuer(process.env.JWT_ISSUER!)
    .setAudience("hoaxconnect-attacker")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);

  await assert.rejects(
    () => verifyAccessToken(token),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "INVALID_ACCESS_TOKEN"
      );
    }
  );
});

test("device proof verifies only the canonical signed payload", async () => {
  const modulePath = "../src/device-proof.js";

  const {
    canonicalDeviceProofPayload,
    verifyDeviceProof,
  } = await import(modulePath);

  const {
    publicKey,
    privateKey,
  } = generateKeyPairSync("ed25519");

  const publicKeySpki = publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();

  const input = {
    version: 1,
    challengeId:
      "44444444-4444-4444-8444-444444444444",
    purpose: "login",
    nonce: "sample-high-entropy-nonce",
    userId:
      "11111111-1111-4111-8111-111111111111",
    deviceUid: "stage2c-device-0001",
    keyFingerprint: "a".repeat(64),
    issuedAt: "2026-09-28T22:30:00.000Z",
    expiresAt: "2026-09-28T22:35:00.000Z",
  } as const;

  const payload =
    canonicalDeviceProofPayload(input);

  const signature = sign(
    null,
    payload,
    privateKey
  ).toString("base64url");

  assert.equal(
    verifyDeviceProof({
      publicKeySpki,
      payload,
      signature,
    }),
    true
  );

  const tampered = Buffer.concat([
    payload,
    Buffer.from("tampered"),
  ]);

  assert.equal(
    verifyDeviceProof({
      publicKeySpki,
      payload: tampered,
      signature,
    }),
    false
  );
});
