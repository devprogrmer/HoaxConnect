import { randomUUID } from "node:crypto";

import type {
  FastifyInstance,
  FastifyRequest
} from "fastify";

import type { PoolClient } from "pg";
import { z } from "zod";

import { config } from "./config.js";
import { pool } from "./db.js";
import { ApiError } from "./errors.js";
import {
  decryptRecoveryResponse,
  encryptRecoveryResponse,
  hashRecoverySecret,
  recoverySecretMatches,
} from "./refresh-recovery.js";
import {
  prepareAuthDevice,
  type AuthDeviceRow,
} from "./auth-devices.js";
import {
  issueDeviceChallenge,
  verifyPendingDeviceProof,
} from "./device-auth.js";

import {
  createRefreshCredential,
  hashPassword,
  parseRefreshToken,
  refreshHashMatches,
  signAccessToken,
  verifyAccessToken,
  verifyPassword
} from "./security.js";

const deviceSchema = z.object({
  uid: z.string().min(16).max(255),
  name: z.string().min(1).max(120),
  os: z.string().min(1).max(80),
  platform: z.string().min(1).max(80),
  os_version: z.string().min(1).max(120),
  architecture: z.string().min(1).max(40),
  client_version: z.string().min(1).max(40),
  public_key_spki: z.string().min(64).max(4096)
});

const registerSchema = z.object({
  email: z.string().email().max(320),
  phone: z.string()
    .regex(/^\+[1-9][0-9]{7,14}$/),
  username: z.string()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(12).max(128),
  device: deviceSchema
});

const loginSchema = z.object({
  identifier: z.string().min(3).max(320),
  password: z.string().min(1).max(128),
  device: deviceSchema
});

const refreshChallengeSchema = z.object({
  refresh_token: z.string().min(40).max(1024)
});

const refreshRotationSchema = z.object({
  refresh_token: z.string().min(40).max(1024),
  challenge_id: z.string().uuid(),
  flow_token: z.string().min(40).max(256),
  nonce: z.string().min(40).max(256),
  signature: z.string().min(80).max(256),
  recovery_id: z.string().uuid(),
  recovery_secret: z.string().min(40).max(256)
});

const deviceProofSchema = z.object({
  challenge_id: z.string().uuid(),
  flow_token: z.string().min(40).max(256),
  nonce: z.string().min(40).max(256),
  signature: z.string().min(80).max(256)
});

type UserRow = {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  email_verified_at: Date | null;
  phone: string | null;
  phone_normalized: string | null;
  phone_verified_at: Date | null;
  suspended_at: Date | null;
  suspension_reason: string | null;
  banned_at: Date | null;
  ban_reason: string | null;
  auth_version: number;
};

type DeviceRow = {
  id: string;
  user_id: string;
  device_uid: string;
  name: string;
  os: string;
  client_version: string;
  first_seen_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
};

type SessionRow = {
  id: string;
  family_id: string;
  user_id: string;
  device_id: string;
  refresh_token_hash: string;
  status: string;
  expires_at: Date;
};

type RefreshRecoveryRow = {
  id: string;
  session_family_id: string;
  previous_session_id: string;
  replacement_session_id: string;
  device_id: string;
  recovery_id: string;
  recovery_secret_hash: string;
  response_ciphertext: Buffer;
  expires_at: Date;
  consumed_at: Date | null;
};

type RefreshRotationResponse = {
  tokens: Awaited<ReturnType<typeof createSession>>;
};

export interface AuthContext {
  userId: string;
  deviceId: string;
  sessionId: string;
  role: string;
  authVersion: number;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function requestUserAgent(request: FastifyRequest): string | null {
  const value = request.headers["user-agent"];
  return typeof value === "string"
    ? value.slice(0, 512)
    : null;
}

async function audit(
  client: PoolClient,
  request: FastifyRequest,
  action: string,
  resourceType: string,
  resourceId: string | null,
  actorUserId: string | null,
  actorRole: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (
       actor_user_id,
       actor_role,
       action,
       resource_type,
       resource_id,
       request_id,
       ip_address,
       metadata
     )
     VALUES ($1, $2::user_role, $3, $4, $5, $6, $7::inet, $8::jsonb)`,
    [
      actorUserId,
      actorRole,
      action,
      resourceType,
      resourceId,
      request.id,
      request.ip,
      JSON.stringify(metadata)
    ]
  );
}

async function createSession(
  client: PoolClient,
  request: FastifyRequest,
  user: UserRow,
  device: DeviceRow,
  familyId: string = randomUUID(),
  expiresAt = new Date(
    Date.now() +
      config.refreshTokenTtlDays * 24 * 60 * 60 * 1000
  ),
  parentSessionId: string | null = null
) {
  const refresh = createRefreshCredential();

  await client.query(
    `INSERT INTO sessions (
       id,
       family_id,
       user_id,
       device_id,
       refresh_token_hash,
       parent_session_id,
       expires_at,
       ip_address,
       user_agent
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, $9)`,
    [
      refresh.sessionId,
      familyId,
      user.id,
      device.id,
      refresh.hash,
      parentSessionId,
      expiresAt,
      request.ip,
      requestUserAgent(request)
    ]
  );

  const accessToken = await signAccessToken({
    sub: user.id,
    sid: refresh.sessionId,
    did: device.id,
    role: user.role,
    auth_version: user.auth_version
  });

  return {
    sessionId: refresh.sessionId,
    accessToken,
    refreshToken: refresh.token,
    accessExpiresIn: config.accessTokenTtlSeconds,
    refreshExpiresAt: expiresAt.toISOString()
  };
}

function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    username: user.username,
    role: user.role,
    status: user.status,
    email_verified: Boolean(user.email_verified_at),
    phone_verified: Boolean(user.phone_verified_at)
  };
}

function publicDevice(device: AuthDeviceRow) {
  return {
    id: device.id,
    device_uid: device.device_uid,
    name: device.name,
    os: device.os,
    platform: device.platform,
    os_version: device.os_version,
    architecture: device.architecture,
    client_version: device.client_version
  };
}

function assertUserCanAuthenticate(
  user: UserRow
): void {
  if (user.status === "suspended") {
    throw new ApiError(
      403,
      "ACCOUNT_SUSPENDED",
      user.suspension_reason ||
        "This account is suspended."
    );
  }

  if (user.status === "banned") {
    throw new ApiError(
      403,
      "ACCOUNT_BANNED",
      user.ban_reason ||
        "This account is banned."
    );
  }

  if (user.status !== "active") {
    throw new ApiError(
      403,
      user.status === "pending_verification"
        ? "EMAIL_VERIFICATION_REQUIRED"
        : "ACCOUNT_UNAVAILABLE",
      user.status === "pending_verification"
        ? "Email verification is required."
        : "This account is unavailable."
    );
  }

  if (
    config.emailVerificationRequired &&
    !user.email_verified_at
  ) {
    throw new ApiError(
      403,
      "EMAIL_VERIFICATION_REQUIRED",
      "Email verification is required."
    );
  }
}

export async function authenticate(
  request: FastifyRequest
): Promise<AuthContext> {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    throw new ApiError(
      401,
      "AUTHENTICATION_REQUIRED",
      "A valid access token is required."
    );
  }

  const claims = await verifyAccessToken(
    authorization.slice("Bearer ".length)
  );

  const result = await pool.query<{
    user_id: string;
    device_id: string;
    session_id: string;
    role: string;
    auth_version: number;
  }>(
    `SELECT
       u.id AS user_id,
       d.id AS device_id,
       s.id AS session_id,
       u.role::text AS role,
       u.auth_version
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN devices d ON d.id = s.device_id
     WHERE s.id = $1
       AND s.user_id = $2
       AND s.device_id = $3
       AND s.status = 'active'
       AND s.expires_at > now()
       AND u.status = 'active'
       AND u.auth_version = $4
       AND d.revoked_at IS NULL`,
    [
      claims.sid,
      claims.sub,
      claims.did,
      claims.auth_version
    ]
  );

  const context = result.rows[0];

  if (!context) {
    throw new ApiError(
      401,
      "SESSION_INVALID",
      "The session is expired, revoked, or no longer valid."
    );
  }

  await pool.query(
    "UPDATE devices SET last_seen_at = now() WHERE id = $1",
    [context.device_id]
  );

  return {
    userId: context.user_id,
    deviceId: context.device_id,
    sessionId: context.session_id,
    role: context.role,
    authVersion: context.auth_version
  };
}

async function register(
  request: FastifyRequest
) {
  const input = registerSchema.parse(request.body);
  const emailNormalized = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query<UserRow>(
      `INSERT INTO users (
         email,
         email_normalized,
         phone,
         phone_normalized,
         username,
         password_hash,
         status
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7::user_status
       )
       RETURNING *`,
      [
        input.email.trim(),
        emailNormalized,
        input.phone,
        input.phone,
        input.username.trim(),
        passwordHash,
        config.emailVerificationRequired
          ? "pending_verification"
          : "active",
      ]
    );

    const user = userResult.rows[0];

    if (!user) {
      throw new Error("User insert returned no row");
    }

    const prepared = await prepareAuthDevice(
      client,
      request,
      user.id,
      input.device
    );

    if (!prepared.ok) {
      throw new Error(
        "First device unexpectedly exceeded device limit"
      );
    }

    const proof = await issueDeviceChallenge(
      client,
      {
        userId: user.id,
        deviceId: prepared.device.id,
        purpose: "enrollment",
        deviceUid: prepared.device.device_uid,
        keyFingerprint:
          prepared.device.key_fingerprint,
      }
    );

    await audit(
      client,
      request,
      "auth.register_challenge",
      "user",
      user.id,
      user.id,
      user.role,
      {
        device_id: prepared.device.id,
        phone_verified: false,
      }
    );

    await client.query("COMMIT");

    return {
      user: publicUser(user),
      device: publicDevice(prepared.device),
      verification_required:
        config.emailVerificationRequired,
      proof,
    };
  } catch (error: unknown) {
    await client.query("ROLLBACK");

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new ApiError(
        409,
        "ACCOUNT_ALREADY_EXISTS",
        "An account with this email or username already exists."
      );
    }

    throw error;
  } finally {
    client.release();
  }
}

async function login(
  request: FastifyRequest
) {
  const input = loginSchema.parse(request.body);
  const identifier =
    input.identifier.trim().toLowerCase();

  const found = await pool.query<UserRow>(
    `SELECT *
     FROM users
     WHERE email_normalized = $1
        OR lower(username) = $1
     LIMIT 1`,
    [identifier]
  );

  const user = found.rows[0];

  if (
    !user ||
    !(await verifyPassword(
      user.password_hash,
      input.password
    ))
  ) {
    throw new ApiError(
      401,
      "INVALID_CREDENTIALS",
      "The username, email, or password is incorrect."
    );
  }

  assertUserCanAuthenticate(user);

  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const lockedResult =
      await client.query<UserRow>(
        `SELECT *
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [user.id]
      );

    const lockedUser = lockedResult.rows[0];

    if (
      !lockedUser ||
      !(await verifyPassword(
        lockedUser.password_hash,
        input.password
      ))
    ) {
      throw new ApiError(
        401,
        "INVALID_CREDENTIALS",
        "The username, email, or password is incorrect."
      );
    }

    assertUserCanAuthenticate(lockedUser);

    const prepared = await prepareAuthDevice(
      client,
      request,
      lockedUser.id,
      input.device
    );

    if (!prepared.ok) {
      await audit(
        client,
        request,
        "device.limit_exceeded",
        "user",
        lockedUser.id,
        lockedUser.id,
        lockedUser.role,
        {
          attempted_device_uid: input.device.uid,
          effective_limit:
            prepared.effectiveLimit,
          active_device_count:
            prepared.activeDeviceCount,
        }
      );

      await client.query("COMMIT");
      committed = true;

      throw new ApiError(
        403,
        "DEVICE_LIMIT_EXCEEDED",
        "The account device limit has been reached."
      );
    }

    const proof = await issueDeviceChallenge(
      client,
      {
        userId: lockedUser.id,
        deviceId: prepared.device.id,
        purpose: prepared.purpose,
        deviceUid: prepared.device.device_uid,
        keyFingerprint:
          prepared.device.key_fingerprint,
      }
    );

    await audit(
      client,
      request,
      "auth.login_challenge",
      "device",
      prepared.device.id,
      lockedUser.id,
      lockedUser.role,
      {
        challenge_purpose: prepared.purpose,
      }
    );

    await client.query("COMMIT");
    committed = true;

    return {
      user: publicUser(lockedUser),
      device: publicDevice(prepared.device),
      proof,
    };
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    client.release();
  }
}


async function completeDeviceProof(
  request: FastifyRequest
) {
  const input = deviceProofSchema.parse(request.body);
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const verified = await verifyPendingDeviceProof(
      client,
      {
        challengeId: input.challenge_id,
        flowToken: input.flow_token,
        nonce: input.nonce,
        signature: input.signature,
      }
    );

    if (!verified.ok) {
      await client.query("COMMIT");
      committed = true;

      throw new ApiError(
        401,
        verified.code,
        verified.message
      );
    }

    if (
      verified.challenge.purpose !== "enrollment" &&
      verified.challenge.purpose !== "login"
    ) {
      throw new ApiError(
        401,
        "INVALID_DEVICE_PROOF",
        "The device proof is invalid or expired."
      );
    }

    const userResult = await client.query<UserRow>(
      `SELECT *
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [verified.challenge.user_id]
    );

    const user = userResult.rows[0];

    if (!user) {
      throw new ApiError(
        401,
        "INVALID_DEVICE_PROOF",
        "The device proof is invalid or expired."
      );
    }

    assertUserCanAuthenticate(user);

    const deviceResult =
      await client.query<AuthDeviceRow>(
        `SELECT *
         FROM devices
         WHERE id = $1
           AND user_id = $2
         FOR UPDATE`,
        [
          verified.challenge.device_id,
          verified.challenge.user_id,
        ]
      );

    const device = deviceResult.rows[0];

    if (!device) {
      throw new ApiError(
        401,
        "INVALID_DEVICE_PROOF",
        "The device proof is invalid or expired."
      );
    }

    if (device.revoked_at) {
      throw new ApiError(
        403,
        "DEVICE_REVOKED",
        "This device has been revoked."
      );
    }

    if (device.banned_at) {
      throw new ApiError(
        403,
        "DEVICE_BANNED",
        "This device is banned."
      );
    }

    if (
      device.key_fingerprint !==
      verified.challenge.key_fingerprint
    ) {
      throw new ApiError(
        401,
        "INVALID_DEVICE_PROOF",
        "The device proof is invalid or expired."
      );
    }

    const tokens = await createSession(
      client,
      request,
      user,
      device
    );

    await client.query(
      `UPDATE sessions
       SET proof_verified_at = now()
       WHERE id = $1`,
      [tokens.sessionId]
    );

    await client.query(
      `UPDATE devices
       SET
         proof_verified_at = now(),
         last_seen_at = now(),
         updated_at = now()
       WHERE id = $1`,
      [device.id]
    );

    await client.query(
      `UPDATE users
       SET
         last_login_at = now(),
         updated_at = now()
       WHERE id = $1`,
      [user.id]
    );

    await audit(
      client,
      request,
      "auth.device_proof_verified",
      "session",
      tokens.sessionId,
      user.id,
      user.role,
      {
        device_id: device.id,
        challenge_id: verified.challenge.id,
        challenge_purpose:
          verified.challenge.purpose,
      }
    );

    await client.query("COMMIT");
    committed = true;

    return {
      user: publicUser(user),
      device: publicDevice(device),
      tokens,
    };
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    client.release();
  }
}


async function createRefreshChallenge(
  request: FastifyRequest
) {
  const input = refreshChallengeSchema.parse(request.body);
  const parsed = parseRefreshToken(input.refresh_token);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sessionResult =
      await client.query<SessionRow>(
        `SELECT *
         FROM sessions
         WHERE id = $1
         FOR UPDATE`,
        [parsed.sessionId]
      );

    const session = sessionResult.rows[0];

    if (
      !session ||
      !refreshHashMatches(
        parsed.token,
        session.refresh_token_hash
      )
    ) {
      throw new ApiError(
        401,
        "INVALID_REFRESH_TOKEN",
        "The refresh token is invalid."
      );
    }

    if (session.status !== "active") {
      throw new ApiError(
        401,
        "SESSION_INVALID",
        "The refresh session is not active."
      );
    }

    if (
      new Date(session.expires_at).getTime() <=
      Date.now()
    ) {
      throw new ApiError(
        401,
        "SESSION_EXPIRED",
        "The refresh session has expired."
      );
    }

    const userResult = await client.query<UserRow>(
      `SELECT *
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [session.user_id]
    );

    const user = userResult.rows[0];

    if (!user) {
      throw new ApiError(
        401,
        "SESSION_INVALID",
        "The refresh session is invalid."
      );
    }

    assertUserCanAuthenticate(user);

    const deviceResult =
      await client.query<AuthDeviceRow>(
        `SELECT *
         FROM devices
         WHERE id = $1
           AND user_id = $2
         FOR UPDATE`,
        [session.device_id, session.user_id]
      );

    const device = deviceResult.rows[0];

    if (!device) {
      throw new ApiError(
        401,
        "SESSION_INVALID",
        "The refresh session is invalid."
      );
    }

    if (device.revoked_at) {
      throw new ApiError(
        403,
        "DEVICE_REVOKED",
        "This device has been revoked."
      );
    }

    if (device.banned_at) {
      throw new ApiError(
        403,
        "DEVICE_BANNED",
        "This device is banned."
      );
    }

    if (
      !device.public_key_spki ||
      !device.key_fingerprint
    ) {
      throw new ApiError(
        401,
        "DEVICE_PROOF_REQUIRED",
        "The device must complete secure enrollment."
      );
    }

    const proof = await issueDeviceChallenge(
      client,
      {
        userId: user.id,
        deviceId: device.id,
        sessionId: session.id,
        purpose: "refresh",
        deviceUid: device.device_uid,
        keyFingerprint: device.key_fingerprint,
      }
    );

    await audit(
      client,
      request,
      "auth.refresh_challenge",
      "session",
      session.id,
      user.id,
      user.role,
      {
        device_id: device.id,
        challenge_id: proof.challenge_id,
      }
    );

    await client.query("COMMIT");

    return { proof };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


async function rotateRefreshToken(
  request: FastifyRequest
) {
  const input = refreshRotationSchema.parse(request.body);
  const parsed = parseRefreshToken(input.refresh_token);
  const client = await pool.connect();

  let committed = false;
  let reuseDetected = false;

  try {
    await client.query("BEGIN");

    const sessionResult = await client.query<SessionRow>(
      `SELECT *
       FROM sessions
       WHERE id = $1
       FOR UPDATE`,
      [parsed.sessionId]
    );

    const session = sessionResult.rows[0];

    if (
      !session ||
      !refreshHashMatches(
        parsed.token,
        session.refresh_token_hash
      )
    ) {
      throw new ApiError(
        401,
        "INVALID_REFRESH_TOKEN",
        "The refresh token is invalid."
      );
    }

    if (session.status === "rotated") {
      const recoveryResult =
        await client.query<RefreshRecoveryRow>(
          `SELECT *
           FROM refresh_rotation_recoveries
           WHERE previous_session_id = $1
             AND recovery_id = $2
           FOR UPDATE`,
          [session.id, input.recovery_id]
        );

      const recovery = recoveryResult.rows[0];

      if (
        recovery &&
        !recovery.consumed_at &&
        new Date(recovery.expires_at).getTime() >
          Date.now() &&
        recovery.device_id === session.device_id &&
        recovery.session_family_id ===
          session.family_id &&
        recoverySecretMatches(
          recovery.recovery_secret_hash,
          input.recovery_secret
        )
      ) {
        const binding = {
          recoveryId: recovery.recovery_id,
          sessionFamilyId:
            recovery.session_family_id,
          previousSessionId:
            recovery.previous_session_id,
          replacementSessionId:
            recovery.replacement_session_id,
          deviceId: recovery.device_id,
        };

        const response =
          decryptRecoveryResponse<RefreshRotationResponse>(
            binding,
            recovery.response_ciphertext
          );

        const consumed = await client.query(
          `UPDATE refresh_rotation_recoveries
           SET consumed_at = now()
           WHERE id = $1
             AND consumed_at IS NULL
             AND expires_at > now()
           RETURNING id`,
          [recovery.id]
        );

        if (!consumed.rowCount) {
          throw new ApiError(
            401,
            "REFRESH_RECOVERY_INVALID",
            "Refresh recovery is invalid or expired."
          );
        }

        await audit(
          client,
          request,
          "auth.refresh_recovered",
          "session",
          recovery.replacement_session_id,
          session.user_id,
          null,
          {
            previous_session_id: session.id,
            recovery_id: recovery.recovery_id,
          }
        );

        await client.query("COMMIT");
        committed = true;

        return response;
      }

      await client.query(
        `UPDATE sessions
         SET
           status = 'compromised',
           revoked_at = now(),
           revoke_reason = 'refresh_token_reuse'
         WHERE family_id = $1
           AND status IN ('active', 'rotated')`,
        [session.family_id]
      );

      await audit(
        client,
        request,
        "auth.refresh_reuse_detected",
        "session_family",
        session.family_id,
        session.user_id,
        null,
        {
          reused_session_id: session.id,
          recovery_id: input.recovery_id,
        }
      );

      await client.query("COMMIT");
      committed = true;
      reuseDetected = true;
    } else if (session.status !== "active") {
      throw new ApiError(
        401,
        "SESSION_INVALID",
        "The refresh session is not active."
      );
    } else if (
      new Date(session.expires_at).getTime() <=
      Date.now()
    ) {
      throw new ApiError(
        401,
        "SESSION_EXPIRED",
        "The refresh session has expired."
      );
    } else {
      const userResult = await client.query<UserRow>(
        `SELECT *
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [session.user_id]
      );

      const user = userResult.rows[0];

      if (!user) {
        throw new ApiError(
          401,
          "SESSION_INVALID",
          "The refresh session is invalid."
        );
      }

      assertUserCanAuthenticate(user);

      const deviceResult =
        await client.query<AuthDeviceRow>(
          `SELECT *
           FROM devices
           WHERE id = $1
             AND user_id = $2
           FOR UPDATE`,
          [session.device_id, session.user_id]
        );

      const device = deviceResult.rows[0];

      if (!device) {
        throw new ApiError(
          401,
          "SESSION_INVALID",
          "The refresh session is invalid."
        );
      }

      if (device.revoked_at) {
        throw new ApiError(
          403,
          "DEVICE_REVOKED",
          "This device has been revoked."
        );
      }

      if (device.banned_at) {
        throw new ApiError(
          403,
          "DEVICE_BANNED",
          "This device is banned."
        );
      }

      const verified = await verifyPendingDeviceProof(
        client,
        {
          challengeId: input.challenge_id,
          flowToken: input.flow_token,
          nonce: input.nonce,
          signature: input.signature,
        }
      );

      if (!verified.ok) {
        throw new ApiError(
          401,
          verified.code,
          verified.message
        );
      }

      if (
        verified.challenge.purpose !== "refresh" ||
        verified.challenge.user_id !== user.id ||
        verified.challenge.device_id !== device.id ||
        verified.challenge.session_id !== session.id
      ) {
        throw new ApiError(
          401,
          "INVALID_DEVICE_PROOF",
          "The device proof is invalid or expired."
        );
      }

      const tokens = await createSession(
        client,
        request,
        user,
        device,
        session.family_id,
        new Date(session.expires_at),
        session.id
      );

      await client.query(
        `UPDATE sessions
         SET proof_verified_at = now()
         WHERE id = $1`,
        [tokens.sessionId]
      );

      await client.query(
        `UPDATE sessions
         SET
           status = 'rotated',
           rotated_at = now(),
           last_used_at = now(),
           replaced_by_session_id = $2
         WHERE id = $1`,
        [session.id, tokens.sessionId]
      );

      const response: RefreshRotationResponse = {
        tokens,
      };

      const recoveryBinding = {
        recoveryId: input.recovery_id,
        sessionFamilyId: session.family_id,
        previousSessionId: session.id,
        replacementSessionId: tokens.sessionId,
        deviceId: device.id,
      };

      const encryptedResponse =
        encryptRecoveryResponse(
          recoveryBinding,
          response
        );

      await client.query(
        `INSERT INTO refresh_rotation_recoveries (
           session_family_id,
           previous_session_id,
           replacement_session_id,
           device_id,
           recovery_id,
           recovery_secret_hash,
           response_ciphertext,
           expires_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           now() + ($8 * interval '1 second')
         )`,
        [
          session.family_id,
          session.id,
          tokens.sessionId,
          device.id,
          input.recovery_id,
          hashRecoverySecret(
            input.recovery_secret
          ),
          encryptedResponse,
          config.refreshRecoveryTtlSeconds,
        ]
      );

      await audit(
        client,
        request,
        "auth.refresh_rotated",
        "session",
        tokens.sessionId,
        user.id,
        user.role,
        {
          replaced_session_id: session.id,
          challenge_id:
            verified.challenge.id,
          recovery_id: input.recovery_id,
        }
      );

      await client.query("COMMIT");
      committed = true;

      return response;
    }
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    client.release();
  }

  if (reuseDetected) {
    throw new ApiError(
      401,
      "REFRESH_TOKEN_REUSED",
      "Refresh-token reuse was detected and the token family was revoked."
    );
  }

  throw new ApiError(
    401,
    "SESSION_INVALID",
    "The refresh session is invalid."
  );
}

async function logout(
  request: FastifyRequest
) {
  const auth = await authenticate(request);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE sessions
       SET
         status = 'revoked',
         revoked_at = now(),
         revoke_reason = 'user_logout'
       WHERE id = $1
         AND status = 'active'`,
      [auth.sessionId]
    );

    await audit(
      client,
      request,
      "auth.logout",
      "session",
      auth.sessionId,
      auth.userId,
      auth.role
    );

    await client.query("COMMIT");

    return { revoked: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function logoutAll(
  request: FastifyRequest
) {
  const auth = await authenticate(request);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE users
       SET auth_version = auth_version + 1
       WHERE id = $1`,
      [auth.userId]
    );

    await client.query(
      `UPDATE sessions
       SET
         status = 'revoked',
         revoked_at = now(),
         revoke_reason = 'logout_all'
       WHERE user_id = $1
         AND status = 'active'`,
      [auth.userId]
    );

    await audit(
      client,
      request,
      "auth.logout_all",
      "user",
      auth.userId,
      auth.userId,
      auth.role
    );

    await client.query("COMMIT");

    return { revoked: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getMe(
  request: FastifyRequest
) {
  const auth = await authenticate(request);

  const result = await pool.query(
    `SELECT
       id,
       email,
       username,
       role,
       status,
       email_verified_at,
       created_at
     FROM users
     WHERE id = $1`,
    [auth.userId]
  );

  return result.rows[0];
}

async function listDevices(
  request: FastifyRequest
) {
  const auth = await authenticate(request);

  const result = await pool.query(
    `SELECT
       id,
       device_uid,
       name,
       os,
       client_version,
       first_seen_at,
       last_seen_at,
       revoked_at
     FROM devices
     WHERE user_id = $1
     ORDER BY last_seen_at DESC`,
    [auth.userId]
  );

  return result.rows;
}

async function revokeDevice(
  request: FastifyRequest<{
    Params: { deviceId: string };
  }>
) {
  const auth = await authenticate(request);
  const deviceId = z.string().uuid().parse(request.params.deviceId);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE devices
       SET
         revoked_at = COALESCE(revoked_at, now()),
         revoke_reason = COALESCE(revoke_reason, 'user_revoked')
       WHERE id = $1
         AND user_id = $2
       RETURNING id, revoked_at`,
      [deviceId, auth.userId]
    );

    if (!result.rowCount) {
      throw new ApiError(
        404,
        "DEVICE_NOT_FOUND",
        "The requested device was not found."
      );
    }

    await client.query(
      `UPDATE sessions
       SET
         status = 'revoked',
         revoked_at = now(),
         revoke_reason = 'device_revoked'
       WHERE device_id = $1
         AND status = 'active'`,
      [deviceId]
    );

    await audit(
      client,
      request,
      "device.revoke",
      "device",
      deviceId,
      auth.userId,
      auth.role
    );

    await client.query("COMMIT");

    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerAuthRoutes(
  app: FastifyInstance
): Promise<void> {
  app.post(
    "/api/v1/auth/register",
    {
      config: {
        rateLimit: {
          max: 8,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const result = await register(request);
      reply.status(201).send({ data: result });
    }
  );

  app.post(
    "/api/v1/auth/login",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute"
        }
      }
    },
    async (request) => ({
      data: await login(request)
    })
  );

  app.post(
    "/api/v1/auth/device-proof",
    {
      config: {
        rateLimit: {
          max: 12,
          timeWindow: "1 minute"
        }
      }
    },
    async (request) => ({
      data: await completeDeviceProof(request)
    })
  );

  app.post(
    "/api/v1/auth/refresh/challenge",
    {
      config: {
        rateLimit: {
          max: 12,
          timeWindow: "1 minute"
        }
      }
    },
    async (request) => ({
      data: await createRefreshChallenge(request)
    })
  );

  app.post(
    "/api/v1/auth/refresh",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute"
        }
      }
    },
    async (request) => ({
      data: await rotateRefreshToken(request)
    })
  );

  app.post(
    "/api/v1/auth/logout",
    async (request) => ({
      data: await logout(request)
    })
  );

  app.post(
    "/api/v1/auth/logout-all",
    async (request) => ({
      data: await logoutAll(request)
    })
  );

  app.post(
    "/api/v1/auth/password/forgot",
    async () => {
      throw new ApiError(
        503,
        "EMAIL_PROVIDER_NOT_CONFIGURED",
        "Password-reset email delivery is not configured."
      );
    }
  );

  app.post(
    "/api/v1/auth/email/verification/request",
    async () => {
      throw new ApiError(
        503,
        "EMAIL_PROVIDER_NOT_CONFIGURED",
        "Email verification delivery is not configured."
      );
    }
  );

  app.get(
    "/api/v1/client/me",
    async (request) => ({
      data: await getMe(request)
    })
  );

  app.get(
    "/api/v1/client/devices",
    async (request) => ({
      data: await listDevices(request)
    })
  );

  app.delete<{
    Params: { deviceId: string };
  }>(
    "/api/v1/client/devices/:deviceId",
    async (request) => ({
      data: await revokeDevice(request)
    })
  );

  app.post(
    "/api/v1/client/payments/checkout",
    async (request) => {
      await authenticate(request);

      throw new ApiError(
        503,
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "A payment provider has not been configured."
      );
    }
  );

  app.get(
    "/api/v1/admin/status",
    async (request) => {
      const auth = await authenticate(request);

      if (
        ![
          "superadmin",
          "admin",
          "support",
          "read_only"
        ].includes(auth.role)
      ) {
        throw new ApiError(
          403,
          "ADMIN_ACCESS_REQUIRED",
          "Administrative access is required."
        );
      }

      throw new ApiError(
        501,
        "ADMIN_API_NOT_ENABLED",
        "The administrative API is reserved but not enabled in Stage 2A."
      );
    }
  );
}
