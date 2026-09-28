process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  "postgresql://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "a".repeat(128);
process.env.JWT_ISSUER = "https://api.hoaxconnect.test";
process.env.JWT_AUDIENCE = "hoaxconnect-desktop";
process.env.REFRESH_TOKEN_PEPPER = "b".repeat(128);
process.env.ACCESS_TOKEN_TTL_SECONDS = "600";
process.env.REFRESH_TOKEN_TTL_DAYS = "30";
process.env.EMAIL_VERIFICATION_REQUIRED = "false";
process.env.EMAIL_PROVIDER = "none";
process.env.PAYMENT_PROVIDER = "none";
