import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import {
  normalizeDevicePublicKey,
} from "./device-auth.js";
import { ApiError } from "./errors.js";

export interface DeviceAuthInput {
  uid: string;
  name: string;
  os: string;
  platform: string;
  os_version: string;
  architecture: string;
  client_version: string;
  public_key_spki: string;
}

export interface AuthDeviceRow {
  id: string;
  user_id: string;
  device_uid: string;
  name: string;
  os: string;
  platform: string;
  os_version: string;
  architecture: string;
  client_version: string;
  public_key_spki: string;
  key_fingerprint: string;
  key_algorithm: string;
  first_seen_at: Date;
  last_seen_at: Date;
  proof_verified_at: Date | null;
  revoked_at: Date | null;
  banned_at: Date | null;
}

export type PreparedAuthDevice =
  | {
      ok: true;
      device: AuthDeviceRow;
      purpose: "enrollment" | "login";
    }
  | {
      ok: false;
      code: "DEVICE_LIMIT_EXCEEDED";
      effectiveLimit: number;
      activeDeviceCount: number;
    };

function requestUserAgent(
  request: FastifyRequest
): string | null {
  const value = request.headers["user-agent"];

  return typeof value === "string"
    ? value.slice(0, 512)
    : null;
}

export async function prepareAuthDevice(
  client: PoolClient,
  request: FastifyRequest,
  userId: string,
  input: DeviceAuthInput
): Promise<PreparedAuthDevice> {
  const identity = normalizeDevicePublicKey(
    input.public_key_spki
  );

  const existingResult =
    await client.query<AuthDeviceRow>(
      `SELECT *
       FROM devices
       WHERE user_id = $1
         AND device_uid = $2
       FOR UPDATE`,
      [userId, input.uid]
    );

  const existing = existingResult.rows[0];

  if (existing) {
    if (existing.revoked_at) {
      throw new ApiError(
        403,
        "DEVICE_REVOKED",
        "This device has been revoked."
      );
    }

    if (existing.banned_at) {
      throw new ApiError(
        403,
        "DEVICE_BANNED",
        "This device is banned."
      );
    }

    if (
      existing.key_fingerprint &&
      existing.key_fingerprint !==
        identity.keyFingerprint
    ) {
      throw new ApiError(
        403,
        "DEVICE_KEY_MISMATCH",
        "The device identity does not match."
      );
    }

    const updated =
      await client.query<AuthDeviceRow>(
        `UPDATE devices
         SET
           name = $3,
           os = $4,
           platform = $5,
           os_version = $6,
           architecture = $7,
           client_version = $8,
           public_key_spki = COALESCE(
             public_key_spki,
             $9
           ),
           key_fingerprint = COALESCE(
             key_fingerprint,
             $10
           ),
           key_algorithm = COALESCE(
             key_algorithm,
             $11
           ),
           last_seen_at = now(),
           updated_at = now()
         WHERE user_id = $1
           AND device_uid = $2
         RETURNING *`,
        [
          userId,
          input.uid,
          input.name,
          input.os,
          input.platform,
          input.os_version,
          input.architecture,
          input.client_version,
          identity.publicKeySpki,
          identity.keyFingerprint,
          identity.keyAlgorithm,
        ]
      );

    const updatedDevice = updated.rows[0];

    if (!updatedDevice) {
      throw new Error(
        "Device update returned no row"
      );
    }

    return {
      ok: true,
      device: updatedDevice,
      purpose: existing.key_fingerprint
        ? "login"
        : "enrollment",
    };
  }

  const limitResult = await client.query<{
    effective_limit: number;
    active_device_count: number;
  }>(
    `SELECT
       COALESCE(
         (
           SELECT s.device_limit
           FROM subscriptions s
           WHERE s.user_id = $1
             AND s.status = 'active'
             AND (
               s.starts_at IS NULL OR
               s.starts_at <= now()
             )
             AND (
               s.ends_at IS NULL OR
               s.ends_at > now()
             )
           ORDER BY s.created_at DESC
           LIMIT 1
         ),
         1
       )::integer AS effective_limit,
       (
         SELECT count(*)::integer
         FROM devices d
         WHERE d.user_id = $1
           AND d.revoked_at IS NULL
           AND d.banned_at IS NULL
       ) AS active_device_count`,
    [userId]
  );

  const limit = limitResult.rows[0];

  if (!limit) {
    throw new Error(
      "Device limit query returned no row"
    );
  }

  const {
    effective_limit: effectiveLimit,
    active_device_count: activeDeviceCount,
  } = limit;

  if (activeDeviceCount >= effectiveLimit) {
    await client.query(
      `INSERT INTO device_limit_violations (
         user_id,
         device_uid,
         device_name,
         platform,
         os_version,
         architecture,
         client_version,
         effective_limit,
         active_device_count,
         decision,
         ip_address,
         user_agent,
         request_id
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, 'rejected', $10::inet, $11, $12
       )`,
      [
        userId,
        input.uid,
        input.name,
        input.platform,
        input.os_version,
        input.architecture,
        input.client_version,
        effectiveLimit,
        activeDeviceCount,
        request.ip,
        requestUserAgent(request),
        request.id,
      ]
    );

    return {
      ok: false,
      code: "DEVICE_LIMIT_EXCEEDED",
      effectiveLimit,
      activeDeviceCount,
    };
  }

  const inserted = await client.query<AuthDeviceRow>(
    `INSERT INTO devices (
       user_id,
       device_uid,
       name,
       os,
       platform,
       os_version,
       architecture,
       client_version,
       public_key_spki,
       key_fingerprint,
       key_algorithm
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11
     )
     RETURNING *`,
    [
      userId,
      input.uid,
      input.name,
      input.os,
      input.platform,
      input.os_version,
      input.architecture,
      input.client_version,
      identity.publicKeySpki,
      identity.keyFingerprint,
      identity.keyAlgorithm,
    ]
  );

  const insertedDevice = inserted.rows[0];

  if (!insertedDevice) {
    throw new Error(
      "Device insert returned no row"
    );
  }

  return {
    ok: true,
    device: insertedDevice,
    purpose: "enrollment",
  };
}
