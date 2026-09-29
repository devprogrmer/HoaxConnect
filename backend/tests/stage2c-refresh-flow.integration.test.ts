import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import assert from "node:assert/strict";
import {
  after,
  before,
  test,
} from "node:test";

import {
  canonicalDeviceProofPayload,
} from "../src/device-proof.js";

const databaseUrl =
  process.env.HC_STAGE2C_TEST_DATABASE_URL;

const integrationOptions = {
  skip: !databaseUrl,
};

let app: any;
let pool: any;
let refreshToken = "";

const userId = randomUUID();
const deviceId = randomUUID();
let sessionId = "";
const sessionFamilyId = randomUUID();
const deviceUid =
  `stage2c-refresh-${randomUUID()}`;

const {
  publicKey,
  privateKey,
} = generateKeyPairSync("ed25519");

const publicKeySpki = publicKey.export({
  type: "spki",
  format: "pem",
}).toString();

const publicKeyDer = publicKey.export({
  type: "spki",
  format: "der",
});

const keyFingerprint = createHash("sha256")
  .update(publicKeyDer)
  .digest("hex");

before(async () => {
  if (!databaseUrl) {
    return;
  }

  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_SSL = "false";
  process.env.JWT_ACCESS_SECRET = "a".repeat(128);
  process.env.JWT_ISSUER = "hoaxconnect-api";
  process.env.JWT_AUDIENCE = "hoaxconnect-desktop";
  process.env.REFRESH_TOKEN_PEPPER = "b".repeat(128);
  process.env.ACCESS_TOKEN_TTL_SECONDS = "600";
  process.env.REFRESH_TOKEN_TTL_DAYS = "30";
  process.env.REFRESH_RECOVERY_ENCRYPTION_KEY =
    Buffer.alloc(32, 7).toString("base64");
  process.env.REFRESH_RECOVERY_TTL_SECONDS = "120";
  process.env.EMAIL_VERIFICATION_REQUIRED = "false";
  process.env.EMAIL_PROVIDER = "none";
  process.env.PAYMENT_PROVIDER = "none";

  const appModule = await import("../src/app.js");
  const dbModule = await import("../src/db.js");

  app = await appModule.buildApp();
  pool = dbModule.pool;

  const {
    createRefreshCredential,
    hashPassword,
  } = await import("../src/security.js");

  const credential = createRefreshCredential();
  const passwordHash = await hashPassword(
    "Stage2C-Refresh-Test-Password-123!"
  );

  refreshToken = credential.token;
  sessionId = credential.sessionId;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO users (
         id,
         email,
         email_normalized,
         username,
         password_hash,
         status
       )
       VALUES ($1, $2, $2, $3, $4, 'active')`,
      [
        userId,
        `stage2c-refresh-${randomUUID()}@example.test`,
        `refresh_${randomUUID()
          .replaceAll("-", "")
          .slice(0, 20)}`,
        passwordHash,
      ]
    );

    await client.query(
      `INSERT INTO devices (
         id,
         user_id,
         device_uid,
         name,
         os,
         client_version,
         platform,
         os_version,
         architecture,
         public_key_spki,
         key_fingerprint,
         key_algorithm,
         proof_verified_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, 'Ed25519', now()
       )`,
      [
        deviceId,
        userId,
        deviceUid,
        "Stage 2C Refresh Device",
        "windows",
        "0.1.0",
        "win32",
        "11",
        "x64",
        publicKeySpki,
        keyFingerprint,
      ]
    );

    await client.query(
      `INSERT INTO sessions (
         id,
         family_id,
         user_id,
         device_id,
         refresh_token_hash,
         status,
         expires_at,
         proof_verified_at
       )
       VALUES (
         $1, $2, $3, $4, $5,
         'active',
         now() + interval '30 days',
         now()
       )`,
      [
        sessionId,
        sessionFamilyId,
        userId,
        deviceId,
        credential.hash,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

after(async () => {
  if (app) {
    await app.close();
  }

  if (pool) {
    await pool.end();
  }
});

async function createRotatedFamily() {
  const {
    createRefreshCredential,
  } = await import("../src/security.js");

  const credential = createRefreshCredential();
  const familyId = randomUUID();

  await pool.query(
    `INSERT INTO sessions (
       id,
       family_id,
       user_id,
       device_id,
       refresh_token_hash,
       status,
       expires_at,
       proof_verified_at
     )
     VALUES (
       $1, $2, $3, $4, $5,
       'active',
       now() + interval '30 days',
       now()
     )`,
    [
      credential.sessionId,
      familyId,
      userId,
      deviceId,
      credential.hash,
    ]
  );

  const challengeResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh/challenge",
    payload: {
      refresh_token: credential.token,
    },
  });

  assert.equal(
    challengeResponse.statusCode,
    200,
    challengeResponse.body
  );

  const proof =
    challengeResponse.json().data.proof;

  const signedPayload =
    canonicalDeviceProofPayload({
      version: 1,
      challengeId: proof.challenge_id,
      purpose: proof.purpose,
      nonce: proof.nonce,
      userId,
      deviceUid,
      keyFingerprint: proof.key_fingerprint,
      issuedAt: proof.issued_at,
      expiresAt: proof.expires_at,
    });

  const signature = sign(
    null,
    signedPayload,
    privateKey
  ).toString("base64url");

  const recoveryId = randomUUID();
  const recoverySecret =
    randomBytes(32).toString("base64url");

  const payload = {
    refresh_token: credential.token,
    challenge_id: proof.challenge_id,
    flow_token: proof.flow_token,
    nonce: proof.nonce,
    signature,
    recovery_id: recoveryId,
    recovery_secret: recoverySecret,
  };

  const rotationResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload,
  });

  assert.equal(
    rotationResponse.statusCode,
    200,
    rotationResponse.body
  );

  return {
    familyId,
    previousSessionId: credential.sessionId,
    replacementSessionId:
      rotationResponse.json().data.tokens.sessionId,
    recoveryId,
    recoverySecret,
    payload,
    tokens: rotationResponse.json().data.tokens,
  };
}

test(
  "refresh challenge endpoint exists",
  integrationOptions,
  async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh/challenge",
      payload: {
        refresh_token:
          "11111111-1111-4111-8111-111111111111." +
          "A".repeat(43),
      },
    });

    assert.notEqual(
      response.statusCode,
      404,
      response.body
    );

    assert.notEqual(
      response.json().error?.code,
      "NOT_FOUND"
    );
  }
);

test(
  "valid refresh token receives a device-bound hashed challenge",
  integrationOptions,
  async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh/challenge",
      payload: {
        refresh_token: refreshToken,
      },
    });

    assert.equal(
      response.statusCode,
      200,
      response.body
    );

    const data = response.json().data;
    const proof = data.proof;

    assert.equal(proof.purpose, "refresh");
    assert.equal(
      proof.key_fingerprint,
      keyFingerprint
    );
    assert.equal(
      typeof proof.challenge_id,
      "string"
    );
    assert.equal(typeof proof.nonce, "string");
    assert.equal(typeof proof.flow_token, "string");
    assert.equal(data.tokens, undefined);

    const challengeResult = await pool.query(
      `SELECT
         user_id,
         device_id,
         purpose,
         challenge_hash,
         flow_token_hash,
         consumed_at
       FROM device_challenges
       WHERE id = $1`,
      [proof.challenge_id]
    );

    assert.equal(challengeResult.rowCount, 1);

    const challenge = challengeResult.rows[0];

    assert.equal(challenge.user_id, userId);
    assert.equal(challenge.device_id, deviceId);
    assert.equal(challenge.purpose, "refresh");
    assert.equal(challenge.consumed_at, null);

    assert.equal(
      challenge.challenge_hash,
      createHash("sha256")
        .update(proof.nonce)
        .digest("hex")
    );

    assert.equal(
      challenge.flow_token_hash,
      createHash("sha256")
        .update(proof.flow_token)
        .digest("hex")
    );

    assert.notEqual(
      challenge.challenge_hash,
      proof.nonce
    );

    assert.notEqual(
      challenge.flow_token_hash,
      proof.flow_token
    );
  }
);

test(
  "signed refresh proof rotates atomically and stores recovery state",
  integrationOptions,
  async () => {
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh/challenge",
      payload: {
        refresh_token: refreshToken,
      },
    });

    assert.equal(
      challengeResponse.statusCode,
      200,
      challengeResponse.body
    );

    const proof =
      challengeResponse.json().data.proof;

    const signedPayload =
      canonicalDeviceProofPayload({
        version: 1,
        challengeId: proof.challenge_id,
        purpose: proof.purpose,
        nonce: proof.nonce,
        userId,
        deviceUid,
        keyFingerprint: proof.key_fingerprint,
        issuedAt: proof.issued_at,
        expiresAt: proof.expires_at,
      });

    const signature = sign(
      null,
      signedPayload,
      privateKey
    ).toString("base64url");

    const recoveryId = randomUUID();
    const recoverySecret =
      randomBytes(32).toString("base64url");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {
        refresh_token: refreshToken,
        challenge_id: proof.challenge_id,
        flow_token: proof.flow_token,
        nonce: proof.nonce,
        signature,
        recovery_id: recoveryId,
        recovery_secret: recoverySecret,
      },
    });

    assert.equal(
      response.statusCode,
      200,
      response.body
    );

    const tokens = response.json().data.tokens;

    assert.equal(
      typeof tokens?.accessToken,
      "string"
    );
    assert.equal(
      typeof tokens?.refreshToken,
      "string"
    );
    assert.notEqual(
      tokens.refreshToken,
      refreshToken
    );

    const sessionResult = await pool.query(
      `SELECT
         id,
         status,
         replaced_by_session_id
       FROM sessions
       WHERE id = $1`,
      [sessionId]
    );

    assert.equal(sessionResult.rowCount, 1);
    assert.equal(
      sessionResult.rows[0].status,
      "rotated"
    );
    assert.equal(
      sessionResult.rows[0].replaced_by_session_id,
      tokens.sessionId
    );

    const replacementResult = await pool.query(
      `SELECT
         id,
         family_id,
         parent_session_id,
         status,
         proof_verified_at
       FROM sessions
       WHERE id = $1`,
      [tokens.sessionId]
    );

    assert.equal(replacementResult.rowCount, 1);
    assert.equal(
      replacementResult.rows[0].family_id,
      sessionFamilyId
    );
    assert.equal(
      replacementResult.rows[0].parent_session_id,
      sessionId
    );
    assert.equal(
      replacementResult.rows[0].status,
      "active"
    );
    assert.notEqual(
      replacementResult.rows[0].proof_verified_at,
      null
    );

    const challengeResult = await pool.query(
      `SELECT consumed_at
       FROM device_challenges
       WHERE id = $1`,
      [proof.challenge_id]
    );

    assert.equal(challengeResult.rowCount, 1);
    assert.notEqual(
      challengeResult.rows[0].consumed_at,
      null
    );

    const recoveryResult = await pool.query(
      `SELECT
         session_family_id,
         previous_session_id,
         replacement_session_id,
         device_id,
         recovery_secret_hash,
         response_ciphertext,
         expires_at,
         consumed_at
       FROM refresh_rotation_recoveries
       WHERE recovery_id = $1`,
      [recoveryId]
    );

    assert.equal(recoveryResult.rowCount, 1);

    const recovery = recoveryResult.rows[0];

    assert.equal(
      recovery.session_family_id,
      sessionFamilyId
    );
    assert.equal(
      recovery.previous_session_id,
      sessionId
    );
    assert.equal(
      recovery.replacement_session_id,
      tokens.sessionId
    );
    assert.equal(recovery.device_id, deviceId);
    assert.equal(
      recovery.recovery_secret_hash,
      createHash("sha256")
        .update(recoverySecret)
        .digest("hex")
    );
    assert.equal(
      Buffer.isBuffer(recovery.response_ciphertext),
      true
    );
    assert.equal(
      recovery.response_ciphertext.length > 32,
      true
    );
    assert.equal(recovery.consumed_at, null);
    assert.equal(
      new Date(recovery.expires_at).getTime() >
        Date.now(),
      true
    );

    // Simulate a committed rotation whose response was lost.
    const recoveryPayload = {
      refresh_token: refreshToken,
      challenge_id: proof.challenge_id,
      flow_token: proof.flow_token,
      nonce: proof.nonce,
      signature,
      recovery_id: recoveryId,
      recovery_secret: recoverySecret,
    };

    const recoveredResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: recoveryPayload,
    });

    assert.equal(
      recoveredResponse.statusCode,
      200,
      recoveredResponse.body
    );

    assert.deepEqual(
      recoveredResponse.json().data.tokens,
      tokens,
      "lost refresh response is recovered exactly once"
    );

    const consumedRecovery = await pool.query(
      `SELECT consumed_at
       FROM refresh_rotation_recoveries
       WHERE recovery_id = $1`,
      [recoveryId]
    );

    assert.equal(consumedRecovery.rowCount, 1);
    assert.notEqual(
      consumedRecovery.rows[0].consumed_at,
      null
    );

    const replayResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: recoveryPayload,
    });

    assert.equal(
      replayResponse.statusCode,
      401,
      replayResponse.body
    );

    assert.equal(
      replayResponse.json().error.code,
      "REFRESH_TOKEN_REUSED"
    );

    const familyResult = await pool.query(
      `SELECT status
       FROM sessions
       WHERE family_id = $1
       ORDER BY id`,
      [sessionFamilyId]
    );

    assert.equal(familyResult.rowCount, 2);
    assert.deepEqual(
      familyResult.rows.map(
        (row) => row.status
      ),
      ["compromised", "compromised"]
    );
  }
);


test(
  "wrong recovery secret compromises the token family",
  integrationOptions,
  async () => {
    const {
      createRefreshCredential,
    } = await import("../src/security.js");

    const credential = createRefreshCredential();
    const wrongSecretFamilyId = randomUUID();

    await pool.query(
      `INSERT INTO sessions (
         id,
         family_id,
         user_id,
         device_id,
         refresh_token_hash,
         status,
         expires_at,
         proof_verified_at
       )
       VALUES (
         $1, $2, $3, $4, $5,
         'active',
         now() + interval '30 days',
         now()
       )`,
      [
        credential.sessionId,
        wrongSecretFamilyId,
        userId,
        deviceId,
        credential.hash,
      ]
    );

    const challengeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh/challenge",
      payload: {
        refresh_token: credential.token,
      },
    });

    assert.equal(
      challengeResponse.statusCode,
      200,
      challengeResponse.body
    );

    const proof =
      challengeResponse.json().data.proof;

    const signedPayload =
      canonicalDeviceProofPayload({
        version: 1,
        challengeId: proof.challenge_id,
        purpose: proof.purpose,
        nonce: proof.nonce,
        userId,
        deviceUid,
        keyFingerprint: proof.key_fingerprint,
        issuedAt: proof.issued_at,
        expiresAt: proof.expires_at,
      });

    const signature = sign(
      null,
      signedPayload,
      privateKey
    ).toString("base64url");

    const recoveryId = randomUUID();
    const recoverySecret =
      randomBytes(32).toString("base64url");

    const rotationPayload = {
      refresh_token: credential.token,
      challenge_id: proof.challenge_id,
      flow_token: proof.flow_token,
      nonce: proof.nonce,
      signature,
      recovery_id: recoveryId,
      recovery_secret: recoverySecret,
    };

    const rotationResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: rotationPayload,
    });

    assert.equal(
      rotationResponse.statusCode,
      200,
      rotationResponse.body
    );

    const wrongSecretResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {
        ...rotationPayload,
        recovery_secret:
          randomBytes(32).toString("base64url"),
      },
    });

    assert.equal(
      wrongSecretResponse.statusCode,
      401,
      wrongSecretResponse.body
    );

    assert.equal(
      wrongSecretResponse.json().error.code,
      "REFRESH_TOKEN_REUSED"
    );

    assert.equal(
      JSON.stringify(wrongSecretResponse.json())
        .includes(
          rotationResponse.json().data.tokens.refreshToken
        ),
      false
    );

    const recoveryResult = await pool.query(
      `SELECT consumed_at
       FROM refresh_rotation_recoveries
       WHERE recovery_id = $1`,
      [recoveryId]
    );

    assert.equal(recoveryResult.rowCount, 1);
    assert.equal(
      recoveryResult.rows[0].consumed_at,
      null
    );

    const familyResult = await pool.query(
      `SELECT status
       FROM sessions
       WHERE family_id = $1
       ORDER BY id`,
      [wrongSecretFamilyId]
    );

    assert.equal(familyResult.rowCount, 2);
    assert.deepEqual(
      familyResult.rows.map(
        (row) => row.status
      ),
      ["compromised", "compromised"]
    );
  }
);

test(
  "expired recovery cannot restore tokens",
  integrationOptions,
  async () => {
    const rotated = await createRotatedFamily();

    await pool.query(
      `UPDATE refresh_rotation_recoveries
       SET
         created_at = now() - interval '10 minutes',
         expires_at = now() - interval '1 second'
       WHERE recovery_id = $1`,
      [rotated.recoveryId]
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: rotated.payload,
    });

    assert.equal(
      response.statusCode,
      401,
      response.body
    );

    assert.equal(
      response.json().error.code,
      "REFRESH_TOKEN_REUSED"
    );

    assert.equal(
      JSON.stringify(response.json())
        .includes(rotated.tokens.refreshToken),
      false
    );

    const recoveryResult = await pool.query(
      `SELECT consumed_at
       FROM refresh_rotation_recoveries
       WHERE recovery_id = $1`,
      [rotated.recoveryId]
    );

    assert.equal(recoveryResult.rowCount, 1);
    assert.equal(
      recoveryResult.rows[0].consumed_at,
      null
    );

    const familyResult = await pool.query(
      `SELECT status
       FROM sessions
       WHERE family_id = $1
       ORDER BY id`,
      [rotated.familyId]
    );

    assert.equal(familyResult.rowCount, 2);
    assert.deepEqual(
      familyResult.rows.map(
        (row) => row.status
      ),
      ["compromised", "compromised"]
    );
  }
);

test(
  "concurrent recovery attempts allow exactly one recovery",
  integrationOptions,
  async () => {
    const rotated = await createRotatedFamily();

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: rotated.payload,
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: rotated.payload,
      }),
    ]);

    const statusCodes = responses
      .map((response) => response.statusCode)
      .sort((left, right) => left - right);

    assert.deepEqual(
      statusCodes,
      [200, 401]
    );

    const successful = responses.find(
      (response) => response.statusCode === 200
    );

    const rejected = responses.find(
      (response) => response.statusCode === 401
    );

    assert.ok(successful);
    assert.ok(rejected);

    assert.deepEqual(
      successful.json().data.tokens,
      rotated.tokens
    );

    assert.equal(
      rejected.json().error.code,
      "REFRESH_TOKEN_REUSED"
    );

    const recoveryResult = await pool.query(
      `SELECT consumed_at
       FROM refresh_rotation_recoveries
       WHERE recovery_id = $1`,
      [rotated.recoveryId]
    );

    assert.equal(recoveryResult.rowCount, 1);
    assert.notEqual(
      recoveryResult.rows[0].consumed_at,
      null
    );

    const familyResult = await pool.query(
      `SELECT status
       FROM sessions
       WHERE family_id = $1
       ORDER BY id`,
      [rotated.familyId]
    );

    assert.equal(familyResult.rowCount, 2);
    assert.deepEqual(
      familyResult.rows.map(
        (row) => row.status
      ),
      ["compromised", "compromised"]
    );
  }
);
