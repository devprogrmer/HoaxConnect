import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migrationPath = new URL(
  "../migrations/004_stage2d_admin_foundation.sql",
  import.meta.url
);

test("Stage 2D migration creates isolated Admin identities and sessions", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const required of [
    "CREATE TYPE admin_role",
    "'superadmin'",
    "'admin'",
    "'support'",
    "'read_only'",
    "CREATE TABLE admin_accounts",
    "CREATE TABLE admin_sessions",
    "token_hash",
    "csrf_token_hash",
    "CREATE TABLE admin_login_events",
    "CREATE TABLE admin_audit_logs",
    "CREATE TABLE admin_provider_secrets",
    "CREATE INDEX traffic_usage_period_date_idx",
    "ON traffic_usage (period_date, period_start DESC)",
  ]) {
    assert.ok(sql.includes(required), `migration is missing ${required}`);
  }

  assert.doesNotMatch(
    sql,
    /REFERENCES\s+users\s*\(id\)/i,
    "Admin identities must not reuse consumer accounts"
  );
});
