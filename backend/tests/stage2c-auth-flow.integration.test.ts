import {
  createHash,
  generateKeyPairSync,
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

const password = "Stage2C-Real-Password-123!";
const loginEmail =
  `stage2c-login-${randomUUID()}@example.test`;
const loginUsername =
  `stage2c_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const knownDeviceUid =
  `stage2c-known-${randomUUID()}`;

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

const {
  publicKey: registrationPublicKey,
} = generateKeyPairSync("ed25519");

const registrationPublicKeySpki =
  registrationPublicKey.export({
    type: "spki",
    format: "pem",
  }).toString();

const registrationPublicKeyDer =
  registrationPublicKey.export({
    type: "spki",
    format: "der",
  });

const registrationKeyFingerprint =
  createHash("sha256")
    .update(registrationPublicKeyDer)
    .digest("hex");

const {
  publicKey: secondPublicKey,
} = generateKeyPairSync("ed25519");

const secondPublicKeySpki = secondPublicKey.export({
  type: "spki",
  format: "pem",
}).toString();

function device(
  uid: string,
  publicKey: string = publicKeySpki
) {
  return {
    uid,
    name: "Stage 2C Test Device",
    os: "windows",
    platform: "win32",
    os_version: "11",
    architecture: "x64",
    client_version: "0.1.0",
    public_key_spki: publicKey,
  };
}

function assertPendingProof(
  response: any,
  purpose: "enrollment" | "login",
  expectedFingerprint: string = keyFingerprint
): void {
  assert.equal(
    response.statusCode >= 200 &&
      response.statusCode < 300,
    true,
    response.body
  );

  const body = response.json();
  const data = body.data;

  assert.equal(
    Boolean(data?.tokens),
    false,
    "pending proof response must not contain usable tokens"
  );

  assert.equal(data?.proof?.purpose, purpose);
  assert.equal(
    typeof data?.proof?.challenge_id,
    "string"
  );
  assert.equal(typeof data?.proof?.nonce, "string");
  assert.equal(
    typeof data?.proof?.flow_token,
    "string"
  );
  assert.equal(
    data?.proof?.key_fingerprint,
    expectedFingerprint
  );
}

before(async () => {
  if (!databaseUrl) {
    return;
  }

  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_ACCESS_SECRET = "a".repeat(128);
  process.env.JWT_ISSUER =
    "https://api.hoaxconnect.test";
  process.env.JWT_AUDIENCE =
    "hoaxconnect-desktop";
  process.env.REFRESH_TOKEN_PEPPER =
    "b".repeat(128);
  process.env.ACCESS_TOKEN_TTL_SECONDS = "600";
  process.env.REFRESH_TOKEN_TTL_DAYS = "30";
  process.env.EMAIL_VERIFICATION_REQUIRED = "false";
  process.env.EMAIL_PROVIDER = "none";
  process.env.PAYMENT_PROVIDER = "none";

  const [
    appModule,
    dbModule,
    securityModule,
  ] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("../src/security.js"),
  ]);

  app = await appModule.buildApp();
  pool = dbModule.pool;

  const passwordHash =
    await securityModule.hashPassword(password);

  const userResult = await pool.query(
    `INSERT INTO users (
       email,
       email_normalized,
       username,
       password_hash,
       status
     )
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING id`,
    [
      loginEmail,
      loginEmail,
      loginUsername,
      passwordHash,
    ]
  );

  await pool.query(
    `INSERT INTO devices (
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
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       'Ed25519', now()
     )`,
    [
      userResult.rows[0].id,
      knownDeviceUid,
      "Stage 2C Known Device",
      "windows",
      "0.1.0",
      "win32",
      "11",
      "x64",
      publicKeySpki,
      keyFingerprint,
    ]
  );
});

after(async () => {
  if (app) {
    await app.close();
  }

  if (pool) {
    await pool.end();
  }
});

test(
  "registration returns enrollment proof instead of tokens",
  integrationOptions,
  async () => {
    const suffix =
      randomUUID().replaceAll("-", "").slice(0, 20);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: `stage2c-register-${suffix}@example.test`,
        phone: "+989121234567",
        username: `reg_${suffix}`,
        password,
        device: device(
          `stage2c-register-${randomUUID()}`,
          registrationPublicKeySpki
        ),
      },
    });

    assertPendingProof(
      response,
      "enrollment",
      registrationKeyFingerprint
    );
  }
);

test(
  "known-device login returns login proof instead of tokens",
  integrationOptions,
  async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifier: loginEmail,
        password,
        device: device(knownDeviceUid),
      },
    });

    assertPendingProof(response, "login");
  }
);

test(
  "valid signed device proof creates one session and rejects replay",
  integrationOptions,
  async () => {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifier: loginEmail,
        password,
        device: device(knownDeviceUid),
      },
    });

    assert.equal(
      loginResponse.statusCode,
      200,
      loginResponse.body
    );

    const loginData = loginResponse.json().data;
    const proof = loginData.proof;

    const payload = canonicalDeviceProofPayload({
      version: 1,
      challengeId: proof.challenge_id,
      purpose: proof.purpose,
      nonce: proof.nonce,
      userId: loginData.user.id,
      deviceUid: knownDeviceUid,
      keyFingerprint: proof.key_fingerprint,
      issuedAt: proof.issued_at,
      expiresAt: proof.expires_at,
    });

    const signature = sign(
      null,
      payload,
      privateKey
    ).toString("base64url");

    const proofRequest = {
      challenge_id: proof.challenge_id,
      flow_token: proof.flow_token,
      nonce: proof.nonce,
      signature,
    };

    const proofResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device-proof",
      payload: proofRequest,
    });

    assert.equal(
      proofResponse.statusCode,
      200,
      proofResponse.body
    );

    const authenticated =
      proofResponse.json().data;

    assert.equal(
      typeof authenticated.tokens?.accessToken,
      "string"
    );

    assert.equal(
      typeof authenticated.tokens?.refreshToken,
      "string"
    );

    const sessionResult = await pool.query(
      `SELECT
         status,
         proof_verified_at
       FROM sessions
       WHERE id = $1`,
      [authenticated.tokens.sessionId]
    );

    assert.equal(sessionResult.rowCount, 1);
    assert.equal(
      sessionResult.rows[0].status,
      "active"
    );
    assert.notEqual(
      sessionResult.rows[0].proof_verified_at,
      null
    );

    const replayResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device-proof",
      payload: proofRequest,
    });

    assert.equal(
      replayResponse.statusCode,
      401,
      replayResponse.body
    );

    assert.equal(
      replayResponse.json()?.error?.code,
      "INVALID_DEVICE_PROOF"
    );

    const activeCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM sessions
       WHERE device_id = $1
         AND status = 'active'`,
      [authenticated.device.id]
    );

    assert.equal(activeCount.rows[0].count, 1);
  }
);

test(
  "new device over the pre-subscription limit is rejected atomically",
  integrationOptions,
  async () => {
    const attemptedUid =
      `stage2c-excess-${randomUUID()}`;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifier: loginEmail,
        password,
        device: {
          ...device(attemptedUid),
          public_key_spki: secondPublicKeySpki,
        },
      },
    });

    assert.equal(
      response.statusCode,
      403,
      response.body
    );

    const body = response.json();

    assert.equal(
      body?.error?.code,
      "DEVICE_LIMIT_EXCEEDED"
    );

    const deviceCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM devices
       WHERE user_id = (
         SELECT id
         FROM users
         WHERE email_normalized = $1
       )
         AND device_uid = $2`,
      [loginEmail, attemptedUid]
    );

    assert.equal(deviceCount.rows[0].count, 0);

    const violationCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM device_limit_violations
       WHERE user_id = (
         SELECT id
         FROM users
         WHERE email_normalized = $1
       )
         AND device_uid = $2
         AND decision = 'rejected'`,
      [loginEmail, attemptedUid]
    );

    assert.equal(violationCount.rows[0].count, 1);
  }
);

test(
  "device-proof endpoint exists and rejects invalid proof",
  integrationOptions,
  async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device-proof",
      payload: {
        challenge_id: randomUUID(),
        flow_token: "invalid-flow-token",
        signature: "invalid-signature",
      },
    });

    assert.notEqual(
      response.statusCode,
      404,
      "device-proof route must be registered"
    );

    assert.equal(
      response.statusCode >= 400 &&
        response.statusCode < 500,
      true,
      response.body
    );

    const body = response.json();

    assert.equal(
      typeof body?.error?.code,
      "string"
    );
  }
);

test(
  "password changed while login waits for the user lock rejects the old password",
  integrationOptions,
  async () => {
    const {
      hashPassword,
    } = await import("../src/security.js");

    const replacementPassword =
      "Stage2C-Replaced-Password-456!";
    const replacementHash =
      await hashPassword(replacementPassword);
    const originalHash =
      await hashPassword(password);
    const locker = await pool.connect();
    let transactionOpen = false;

    try {
      await locker.query("BEGIN");
      transactionOpen = true;

      await locker.query(
        `SELECT id
         FROM users
         WHERE email_normalized = $1
         FOR UPDATE`,
        [loginEmail]
      );

      const loginPromise = app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          identifier: loginEmail,
          password,
          device: device(knownDeviceUid),
        },
      });

      let blockedOnUserLock = false;

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocked = await pool.query(
          `SELECT EXISTS (
             SELECT 1
             FROM pg_stat_activity
             WHERE pid <> pg_backend_pid()
               AND wait_event_type = 'Lock'
               AND query LIKE '%FROM users%'
               AND query LIKE '%FOR UPDATE%'
           ) AS blocked`
        );

        if (blocked.rows[0]?.blocked === true) {
          blockedOnUserLock = true;
          break;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, 10)
        );
      }

      assert.equal(
        blockedOnUserLock,
        true,
        "Login did not block on the locked user row"
      );

      await locker.query(
        `UPDATE users
         SET
           password_hash = $1,
           auth_version = auth_version + 1,
           updated_at = now()
         WHERE email_normalized = $2`,
        [replacementHash, loginEmail]
      );

      await locker.query("COMMIT");
      transactionOpen = false;

      const response = await loginPromise;

      assert.equal(
        response.statusCode,
        401,
        response.body
      );

      assert.equal(
        response.json().error?.code,
        "INVALID_CREDENTIALS"
      );
    } finally {
      if (transactionOpen) {
        await locker.query("ROLLBACK");
      }

      locker.release();

      await pool.query(
        `UPDATE users
         SET
           password_hash = $1,
           auth_version = auth_version + 1,
           updated_at = now()
         WHERE email_normalized = $2`,
        [originalHash, loginEmail]
      );
    }
  }
);
