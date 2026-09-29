import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { PoolClient } from "pg";

import {
  canonicalDeviceProofPayload,
  verifyDeviceProof,
} from "./device-proof.js";
import { ApiError } from "./errors.js";

export type DeviceChallengePurpose =
  | "enrollment"
  | "login"
  | "refresh"
  | "key_rotation";

export interface DeviceKeyIdentity {
  publicKeySpki: string;
  keyFingerprint: string;
  keyAlgorithm: "Ed25519";
}

export interface PublicDeviceChallenge {
  challenge_id: string;
  purpose: DeviceChallengePurpose;
  nonce: string;
  flow_token: string;
  key_fingerprint: string;
  issued_at: string;
  expires_at: string;
}

export interface VerifyPendingProofInput {
  challengeId: string;
  flowToken: string;
  nonce: string;
  signature: string;
}

type ChallengeRow = {
  id: string;
  user_id: string;
  device_id: string;
  session_id: string | null;
  purpose: DeviceChallengePurpose;
  device_uid: string;
  key_fingerprint: string;
  challenge_hash: string;
  flow_token_hash: string;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  failed_attempts: number;
  max_attempts: number;
  public_key_spki: string;
};

export type VerifiedPendingProof =
  | {
      ok: true;
      challenge: ChallengeRow;
    }
  | {
      ok: false;
      code: "INVALID_DEVICE_PROOF";
      message: string;
    };

const challengeTtlMilliseconds = 5 * 60 * 1000;
const challengeMaximumAttempts = 5;

function sha256(value: string | Buffer): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function secretHashMatches(
  expectedHex: string,
  value: string
): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(sha256(value), "hex");

  return (
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}

export function normalizeDevicePublicKey(
  publicKeySpki: string
): DeviceKeyIdentity {
  try {
    const key = createPublicKey(publicKeySpki);

    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("Unexpected key algorithm");
    }

    const der = key.export({
      type: "spki",
      format: "der",
    });

    const canonicalPem = key.export({
      type: "spki",
      format: "pem",
    }).toString();

    return {
      publicKeySpki: canonicalPem,
      keyFingerprint: sha256(der),
      keyAlgorithm: "Ed25519",
    };
  } catch {
    throw new ApiError(
      400,
      "INVALID_DEVICE_KEY",
      "The device public key is invalid."
    );
  }
}

export async function issueDeviceChallenge(
  client: PoolClient,
  input: {
    userId: string;
    deviceId: string;
    sessionId?: string | null;
    purpose: DeviceChallengePurpose;
    deviceUid: string;
    keyFingerprint: string;
  }
): Promise<PublicDeviceChallenge> {
  const challengeId = randomUUID();
  const nonce = randomBytes(32).toString("base64url");
  const flowToken = randomBytes(32).toString("base64url");
  const issuedAt = new Date();
  const expiresAt = new Date(
    issuedAt.getTime() + challengeTtlMilliseconds
  );

  await client.query(
    `INSERT INTO device_challenges (
       id,
       user_id,
       device_id,
       session_id,
       purpose,
       device_uid,
       key_fingerprint,
       challenge_hash,
       flow_token_hash,
       issued_at,
       expires_at,
       max_attempts
     )
     VALUES (
       $1, $2, $3, $4, $5::device_challenge_purpose, $6,
       $7, $8, $9, $10, $11, $12
     )`,
    [
      challengeId,
      input.userId,
      input.deviceId,
      input.sessionId ?? null,
      input.purpose,
      input.deviceUid,
      input.keyFingerprint,
      sha256(nonce),
      sha256(flowToken),
      issuedAt,
      expiresAt,
      challengeMaximumAttempts,
    ]
  );

  return {
    challenge_id: challengeId,
    purpose: input.purpose,
    nonce,
    flow_token: flowToken,
    key_fingerprint: input.keyFingerprint,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
}

export async function verifyPendingDeviceProof(
  client: PoolClient,
  input: VerifyPendingProofInput
): Promise<VerifiedPendingProof> {
  const result = await client.query<ChallengeRow>(
    `SELECT
       c.*,
       d.public_key_spki
     FROM device_challenges c
     JOIN devices d ON d.id = c.device_id
     WHERE c.id = $1
     FOR UPDATE OF c`,
    [input.challengeId]
  );

  const challenge = result.rows[0];

  if (
    !challenge ||
    challenge.consumed_at ||
    challenge.invalidated_at ||
    challenge.failed_attempts >= challenge.max_attempts ||
    challenge.expires_at.getTime() <= Date.now()
  ) {
    return {
      ok: false,
      code: "INVALID_DEVICE_PROOF",
      message: "The device proof is invalid or expired.",
    };
  }

  // Knowing a challenge UUID alone must not let an attacker exhaust it.
  if (
    !secretHashMatches(
      challenge.flow_token_hash,
      input.flowToken
    ) ||
    !secretHashMatches(
      challenge.challenge_hash,
      input.nonce
    )
  ) {
    return {
      ok: false,
      code: "INVALID_DEVICE_PROOF",
      message: "The device proof is invalid or expired.",
    };
  }

  const payload = canonicalDeviceProofPayload({
    version: 1,
    challengeId: challenge.id,
    purpose: challenge.purpose,
    nonce: input.nonce,
    userId: challenge.user_id,
    deviceUid: challenge.device_uid,
    keyFingerprint: challenge.key_fingerprint,
    issuedAt: challenge.issued_at.toISOString(),
    expiresAt: challenge.expires_at.toISOString(),
  });

  if (
    !verifyDeviceProof({
      publicKeySpki: challenge.public_key_spki,
      payload,
      signature: input.signature,
    })
  ) {
    await client.query(
      `UPDATE device_challenges
       SET
         failed_attempts = failed_attempts + 1,
         invalidated_at = CASE
           WHEN failed_attempts + 1 >= max_attempts
           THEN now()
           ELSE invalidated_at
         END
       WHERE id = $1`,
      [challenge.id]
    );

    return {
      ok: false,
      code: "INVALID_DEVICE_PROOF",
      message: "The device proof is invalid or expired.",
    };
  }

  const consumed = await client.query(
    `UPDATE device_challenges
     SET consumed_at = now()
     WHERE id = $1
       AND consumed_at IS NULL
       AND invalidated_at IS NULL
     RETURNING id`,
    [challenge.id]
  );

  if (!consumed.rowCount) {
    return {
      ok: false,
      code: "INVALID_DEVICE_PROOF",
      message: "The device proof is invalid or expired.",
    };
  }

  return {
    ok: true,
    challenge,
  };
}
