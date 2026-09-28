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

if (jwtAccessSecret.length < 64) {
  throw new Error("JWT_ACCESS_SECRET must contain at least 64 characters");
}

if (refreshTokenPepper.length < 64) {
  throw new Error("REFRESH_TOKEN_PEPPER must contain at least 64 characters");
}

const emailVerificationRequired = boolean(
  "EMAIL_VERIFICATION_REQUIRED",
  false
);

const emailProvider = process.env.EMAIL_PROVIDER?.trim() || "none";

if (emailVerificationRequired && emailProvider === "none") {
  throw new Error(
    "EMAIL_VERIFICATION_REQUIRED=true requires a real EMAIL_PROVIDER"
  );
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV?.trim() || "development",
  host: process.env.HOST?.trim() || "0.0.0.0",
  port: integer("PORT", 3100),
  logLevel: process.env.LOG_LEVEL?.trim() || "info",

  databaseUrl: required("DATABASE_URL"),
  databaseSsl: boolean("DATABASE_SSL", false),

  jwtAccessSecret,
  jwtIssuer,
  jwtAudience,
  refreshTokenPepper,
  accessTokenTtlSeconds: integer("ACCESS_TOKEN_TTL_SECONDS", 600),
  refreshTokenTtlDays: integer("REFRESH_TOKEN_TTL_DAYS", 30),

  emailVerificationRequired,
  emailProvider,
  paymentProvider: process.env.PAYMENT_PROVIDER?.trim() || "none",

  corsAllowedOrigins: new Set(
    (process.env.CORS_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  )
});
