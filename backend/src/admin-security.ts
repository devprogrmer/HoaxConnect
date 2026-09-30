import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ADMIN_ROLES = [
  "superadmin",
  "admin",
  "support",
  "read_only",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_PERMISSIONS = [
  "dashboard.read",
  "users.read",
  "users.detail",
  "users.recover",
  "users.suspend",
  "users.ban",
  "devices.read",
  "devices.revoke",
  "devices.ban",
  "sessions.read",
  "sessions.revoke",
  "plans.read",
  "plans.write",
  "subscriptions.read",
  "subscriptions.write",
  "subscriptions.traffic",
  "nodes.read",
  "nodes.write",
  "payments.read",
  "sms.status.read",
  "audit.read",
  "audit.sensitive.read",
  "admins.manage",
  "providers.status.read",
  "providers.secrets.write",
  "telemetry.read",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const allPermissions = new Set<AdminPermission>(ADMIN_PERMISSIONS);

const grants: Record<AdminRole, ReadonlySet<AdminPermission>> = {
  superadmin: allPermissions,
  admin: new Set([
    "dashboard.read",
    "users.read",
    "users.detail",
    "users.recover",
    "users.suspend",
    "users.ban",
    "devices.read",
    "devices.revoke",
    "devices.ban",
    "sessions.read",
    "sessions.revoke",
    "plans.read",
    "plans.write",
    "subscriptions.read",
    "subscriptions.write",
    "subscriptions.traffic",
    "nodes.read",
    "nodes.write",
    "payments.read",
    "sms.status.read",
    "audit.read",
    "providers.status.read",
    "telemetry.read",
  ]),
  support: new Set([
    "dashboard.read",
    "users.read",
    "users.detail",
    "users.recover",
    "devices.read",
    "devices.revoke",
    "sessions.read",
    "sessions.revoke",
    "subscriptions.read",
    "payments.read",
  ]),
  read_only: new Set([
    "dashboard.read",
    "users.read",
    "users.detail",
    "devices.read",
    "sessions.read",
    "plans.read",
    "subscriptions.read",
    "nodes.read",
    "payments.read",
    "providers.status.read",
    "sms.status.read",
  ]),
};

export interface AdminSessionSecrets {
  sessionToken: string;
  sessionTokenHash: string;
  csrfToken: string;
  csrfTokenHash: string;
}

export interface EncryptedProviderCredentials {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" &&
    (ADMIN_ROLES as readonly string[]).includes(value);
}

export function hasAdminPermission(
  role: AdminRole,
  permission: AdminPermission,
): boolean {
  return grants[role].has(permission);
}

export function maskProviderValue(value: string): string {
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createAdminSessionSecrets(): AdminSessionSecrets {
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");

  return {
    sessionToken,
    sessionTokenHash: hashSecret(sessionToken),
    csrfToken,
    csrfTokenHash: hashSecret(csrfToken),
  };
}

export function constantTimeSecretMatches(
  candidate: string,
  expectedHash: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    return false;
  }

  const actual = Buffer.from(hashSecret(candidate), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return timingSafeEqual(actual, expected);
}

export function adminCookie(
  sessionToken: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `hc_admin_session=${sessionToken}`,
    "Path=/api/v1/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function requireAesKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError("Provider encryption key must be 32 bytes");
  }
}

export function encryptProviderCredentials(
  credentials: Record<string, string>,
  key: Buffer,
): EncryptedProviderCredentials {
  requireAesKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext,
    nonce,
    tag: cipher.getAuthTag(),
  };
}

export function decryptProviderCredentials(
  encrypted: EncryptedProviderCredentials,
  key: Buffer,
): Record<string, string> {
  requireAesKey(key);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    encrypted.nonce,
  );
  decipher.setAuthTag(encrypted.tag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]).toString("utf8");
  const value: unknown = JSON.parse(plaintext);

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Provider credentials payload is invalid");
  }

  return value as Record<string, string>;
}
