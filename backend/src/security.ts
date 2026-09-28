import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";

import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";

import { config } from "./config.js";
import { ApiError } from "./errors.js";

const accessSecret = new TextEncoder().encode(config.jwtAccessSecret);

export interface AccessClaims {
  sub: string;
  sid: string;
  did: string;
  role: string;
  auth_version: number;
}

export async function hashPassword(password: string): Promise<string> {
  return await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32
  });
}

export async function verifyPassword(
  hash: string,
  password: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function signAccessToken(
  claims: AccessClaims
): Promise<string> {
  return await new SignJWT({
    sid: claims.sid,
    did: claims.did,
    role: claims.role,
    auth_version: claims.auth_version
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(accessSecret);
}

export async function verifyAccessToken(
  token: string
): Promise<AccessClaims> {
  try {
    const result = await jwtVerify(token, accessSecret, {
      algorithms: ["HS256"],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience
    });

    const payload = result.payload;

    if (
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.did !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.auth_version !== "number"
    ) {
      throw new Error("Invalid access token claims");
    }

    return {
      sub: payload.sub,
      sid: payload.sid,
      did: payload.did,
      role: payload.role,
      auth_version: payload.auth_version
    };
  } catch {
    throw new ApiError(
      401,
      "INVALID_ACCESS_TOKEN",
      "The access token is invalid or expired."
    );
  }
}

export interface RefreshCredential {
  sessionId: string;
  token: string;
  hash: string;
}

export function createRefreshCredential(): RefreshCredential {
  const sessionId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `${sessionId}.${secret}`;

  return {
    sessionId,
    token,
    hash: hashRefreshToken(token)
  };
}

export function hashRefreshToken(token: string): string {
  return createHmac("sha256", config.refreshTokenPepper)
    .update(token)
    .digest("hex");
}

export function parseRefreshToken(
  token: string
): { sessionId: string; token: string } {
  const match = token.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{40,})$/i
  );

  if (!match?.[1]) {
    throw new ApiError(
      401,
      "INVALID_REFRESH_TOKEN",
      "The refresh token is invalid."
    );
  }

  return {
    sessionId: match[1],
    token
  };
}

export function refreshHashMatches(
  token: string,
  storedHash: string
): boolean {
  const actual = Buffer.from(hashRefreshToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");

  return (
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
