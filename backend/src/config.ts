import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();

  if (!raw) {
    return fallback;
  }

  if (raw === "true") return true;
  if (raw === "false") return false;

  throw new Error(`${name} must be true or false`);
}

const jwtAccessSecret = required("JWT_ACCESS_SECRET");
const jwtIssuer = required("JWT_ISSUER");
const jwtAudience = required("JWT_AUDIENCE");
const refreshTokenPepper = required("REFRESH_TOKEN_PEPPER");
const refreshRecoveryEncryptionKeyRaw = required(
  "REFRESH_RECOVERY_ENCRYPTION_KEY"
);

if (jwtAccessSecret.length < 64) {
  throw new Error("JWT_ACCESS_SECRET must contain at least 64 characters");
}

if (refreshTokenPepper.length < 64) {
  throw new Error("REFRESH_TOKEN_PEPPER must contain at least 64 characters");
}

const refreshRecoveryEncryptionKey = Buffer.from(
  refreshRecoveryEncryptionKeyRaw,
  "base64"
);

if (
  refreshRecoveryEncryptionKey.length !== 32 ||
  refreshRecoveryEncryptionKey.toString("base64") !==
    refreshRecoveryEncryptionKeyRaw
) {
  throw new Error(
    "REFRESH_RECOVERY_ENCRYPTION_KEY must be exactly 32 bytes encoded as canonical base64"
  );
}

const emailVerificationRequired = boolean(
  "EMAIL_VERIFICATION_REQUIRED",
  false
);

const emailProvider = process.env.EMAIL_PROVIDER?.trim() || "none";

function origins(name: string): Set<string> {
  return new Set(
    (process.env[name] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

const nodeEnv = process.env.NODE_ENV?.trim() || "development";
const corsAllowedOrigins = origins("CORS_ALLOWED_ORIGINS");
const adminAllowedOrigins = origins("ADMIN_ALLOWED_ORIGINS");
if (nodeEnv !== "production") {
  adminAllowedOrigins.add("http://localhost:5174");
  adminAllowedOrigins.add("http://127.0.0.1:5174");
}
const adminSecretEncryptionKeyRaw =
  process.env.ADMIN_SECRET_ENCRYPTION_KEY?.trim() || "";
let adminSecretEncryptionKey: Buffer | null = null;

if (adminSecretEncryptionKeyRaw) {
  const key = Buffer.from(adminSecretEncryptionKeyRaw, "base64");
  if (
    key.length !== 32 ||
    key.toString("base64") !== adminSecretEncryptionKeyRaw
  ) {
    throw new Error(
      "ADMIN_SECRET_ENCRYPTION_KEY must be exactly 32 bytes encoded as canonical base64",
    );
  }
  adminSecretEncryptionKey = key;
}

if (emailVerificationRequired && emailProvider === "none") {
  throw new Error(
    "EMAIL_VERIFICATION_REQUIRED=true requires a real EMAIL_PROVIDER"
  );
}

export const config = Object.freeze({
  nodeEnv,
  host: process.env.HOST?.trim() || "0.0.0.0",
  port: integer("PORT", 3100),
  logLevel: process.env.LOG_LEVEL?.trim() || "info",

  databaseUrl: required("DATABASE_URL"),
  databaseSsl: boolean("DATABASE_SSL", false),

  jwtAccessSecret,
  jwtIssuer,
  jwtAudience,
  refreshTokenPepper,
  refreshRecoveryEncryptionKey,
  refreshRecoveryTtlSeconds: integer(
    "REFRESH_RECOVERY_TTL_SECONDS",
    120
  ),
  accessTokenTtlSeconds: integer("ACCESS_TOKEN_TTL_SECONDS", 600),
  refreshTokenTtlDays: integer("REFRESH_TOKEN_TTL_DAYS", 30),

  emailVerificationRequired,
  emailProvider,
  paymentProvider: process.env.PAYMENT_PROVIDER?.trim() || "none",

  corsAllowedOrigins: new Set([
    ...corsAllowedOrigins,
    ...adminAllowedOrigins,
  ]),
  adminAllowedOrigins,
  adminSecretEncryptionKey,
});
