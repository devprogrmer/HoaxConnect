import { createHash, randomUUID } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";

import { config } from "./config.js";
import { pool } from "./db.js";
import { ApiError } from "./errors.js";
import {
  type AdminPermission,
  type AdminRole,
  adminCookie,
  constantTimeSecretMatches,
  createAdminSessionSecrets,
  encryptProviderCredentials,
  hasAdminPermission,
  isAdminRole,
  maskProviderValue,
} from "./admin-security.js";
import { hashPassword, verifyPassword } from "./security.js";

const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const ADMIN_COOKIE_NAME = "hc_admin_session";
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_SECONDS = 15 * 60;
const bootstrapDummyPassword =
  `invalid-admin-password-${randomUUID()}-${randomUUID()}`;
const dummyPasswordHash = hashPassword(bootstrapDummyPassword);

interface AdminContext {
  id: string;
  email: string;
  role: AdminRole;
  sessionId: string;
  csrfTokenHash: string;
  mfaEnabled: boolean;
  sessionExpiresAt: Date;
}

type AdminHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  admin: AdminContext,
) => unknown | Promise<unknown>;

const uuidSchema = z.string().uuid();
const reasonSchema = z.string().trim().min(8).max(500);

function apiError(
  statusCode: number,
  code: string,
  message: string,
): ApiError {
  return new ApiError(statusCode, code, message);
}

function unauthenticated(): ApiError {
  return apiError(
    401,
    "ADMIN_AUTHENTICATION_REQUIRED",
    "Sign in to the HoaxConnect Admin Panel.",
  );
}

function forbidden(): ApiError {
  return apiError(
    403,
    "ADMIN_PERMISSION_DENIED",
    "Your Admin role cannot perform this action.",
  );
}

function requestAgent(request: FastifyRequest): string | null {
  const value = request.headers["user-agent"];
  return typeof value === "string" ? value.slice(0, 512) : null;
}

function cookieValue(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;

  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }

  return null;
}

function requireAllowedOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;

  if (
    typeof origin !== "string" ||
    !config.adminAllowedOrigins.has(origin)
  ) {
    throw apiError(
      403,
      "ADMIN_ORIGIN_REJECTED",
      "This Admin Panel origin is not allowed.",
    );
  }
}

function requireHttps(request: FastifyRequest): void {
  if (
    config.nodeEnv === "production" &&
    request.headers["x-forwarded-proto"] !== "https"
  ) {
    throw apiError(
      400,
      "HTTPS_REQUIRED",
      "Admin sign-in requires HTTPS.",
    );
  }
}

function writeSessionCookies(
  reply: FastifyReply,
  token: string,
  csrfToken: string,
  maxAgeSeconds = ADMIN_SESSION_SECONDS,
): void {
  const secure = config.nodeEnv === "production";
  reply.header(
    "set-cookie",
    [
      adminCookie(token, maxAgeSeconds, secure),
      `hc_admin_csrf=${csrfToken}; Path=/; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${secure ? "; Secure" : ""}`,
    ],
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  writeSessionCookies(reply, "", "", 0);
}

async function requireAdmin(
  request: FastifyRequest,
  requireCsrf: boolean,
): Promise<AdminContext> {
  if (requireCsrf) requireAllowedOrigin(request);

  const token = cookieValue(request, ADMIN_COOKIE_NAME);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw unauthenticated();
  }

  const result = await pool.query<{
    id: string;
    email: string;
    role: string;
    session_id: string;
    csrf_token_hash: string;
    mfa_enabled: boolean;
    session_expires_at: Date;
  }>(
    `SELECT
       a.id,
       a.email,
       a.role::text AS role,
       a.mfa_enabled,
       s.id AS session_id,
       s.csrf_token_hash,
       s.expires_at AS session_expires_at
     FROM admin_sessions s
     JOIN admin_accounts a ON a.id = s.admin_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND a.status = 'active'`,
    [createHashHex(token)],
  );

  const row = result.rows[0];
  if (!row || !isAdminRole(row.role)) throw unauthenticated();

  if (requireCsrf) {
    const csrfToken = request.headers["x-csrf-token"];
    if (
      typeof csrfToken !== "string" ||
      !constantTimeSecretMatches(csrfToken, row.csrf_token_hash)
    ) {
      throw apiError(
        403,
        "ADMIN_CSRF_REJECTED",
        "Refresh the Admin Panel and retry the action.",
      );
    }
  }

  await pool.query(
    "UPDATE admin_sessions SET last_used_at = now() WHERE id = $1",
    [row.session_id],
  );

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    sessionId: row.session_id,
    csrfTokenHash: row.csrf_token_hash,
    mfaEnabled: row.mfa_enabled,
    sessionExpiresAt: row.session_expires_at,
  };
}

function createHashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function adminHandler(
  permission: AdminPermission,
  handler: AdminHandler,
  requireCsrf = false,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const admin = await requireAdmin(request, requireCsrf);
    if (!hasAdminPermission(admin.role, permission)) throw forbidden();
    return handler(request, reply, admin);
  };
}

function adminLoginAudit(
  client: PoolClient,
  request: FastifyRequest,
  admin: { id: string; email: string; role: AdminRole },
  action: string,
  resourceType: string,
  resourceId: string | null,
  reason: string | null = null,
  metadata: Record<string, unknown> = {},
): Promise<unknown> {
  return client.query(
    `INSERT INTO admin_audit_logs (
       admin_id, admin_email, admin_role, action, resource_type,
       resource_id, reason, request_id, ip_address, metadata
     ) VALUES ($1, $2, $3::admin_role, $4, $5, $6, $7, $8, $9::inet, $10::jsonb)`,
    [
      admin.id,
      admin.email,
      admin.role,
      action,
      resourceType,
      resourceId,
      reason,
      request.id,
      request.ip,
      JSON.stringify(metadata),
    ],
  );
}

async function recordLoginEvent(
  client: PoolClient,
  request: FastifyRequest,
  emailNormalized: string,
  outcome: "success" | "failed" | "locked",
  adminId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO admin_login_events (
       admin_id, email_normalized, outcome, request_id, ip_address, user_agent
     ) VALUES ($1, $2, $3, $4, $5::inet, $6)`,
    [
      adminId,
      emailNormalized,
      outcome,
      request.id,
      request.ip,
      requestAgent(request),
    ],
  );
}

async function appendAudit(
  client: PoolClient,
  request: FastifyRequest,
  admin: AdminContext,
  action: string,
  resourceType: string,
  resourceId: string | null,
  reason: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await adminLoginAudit(
    client,
    request,
    admin,
    action,
    resourceType,
    resourceId,
    reason,
    metadata,
  );
}

async function auditSensitiveRead(
  request: FastifyRequest,
  admin: AdminContext,
  action: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await adminLoginAudit(
      client,
      request,
      admin,
      action,
      resourceType,
      resourceId,
      null,
      metadata,
    );
  } finally {
    client.release();
  }
}

async function auditedMutation<T>(
  request: FastifyRequest,
  admin: AdminContext,
  action: string,
  resourceType: string,
  resourceId: string | null,
  reason: string,
  operation: (client: PoolClient) => Promise<T>,
  metadata: Record<string, unknown> = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await appendAudit(
      client,
      request,
      admin,
      action,
      resourceType,
      resourceId,
      reason,
      metadata,
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function ensurePermission(
  admin: AdminContext,
  permission: AdminPermission,
): void {
  if (!hasAdminPermission(admin.role, permission)) throw forbidden();
}

function notFound(resource: string): ApiError {
  return apiError(404, "ADMIN_RESOURCE_NOT_FOUND", `${resource} was not found.`);
}

function conflict(message: string): ApiError {
  return apiError(409, "ADMIN_STATE_CONFLICT", message);
}

const userStatusActionSchema = z.object({
  action: z.enum(["suspend", "unsuspend", "ban", "unban"]),
  reason: reasonSchema,
});

async function changeUserStatus(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const userId = uuidSchema.parse(
    (request.params as { userId: string }).userId,
  );
  const input = userStatusActionSchema.parse(request.body);
  const permission: AdminPermission = input.action === "ban" || input.action === "unban"
    ? "users.ban"
    : "users.suspend";
  ensurePermission(admin, permission);

  return auditedMutation(
    request,
    admin,
    `user.${input.action}`,
    "user",
    userId,
    input.reason,
    async (client) => {
      const current = await client.query<{
        id: string;
        status: string;
        auth_version: number;
      }>(
        `SELECT id, status::text AS status, auth_version
         FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [userId],
      );
      const row = current.rows[0];
      if (!row) throw notFound("User");

      const allowedFrom: Record<string, string[]> = {
        suspend: ["active"],
        unsuspend: ["suspended"],
        ban: ["active", "suspended"],
        unban: ["banned"],
      };
      if (!allowedFrom[input.action]!.includes(row.status)) {
        throw conflict(`Cannot ${input.action} a user in state ${row.status}.`);
      }

      const updateSql: Record<string, string> = {
        suspend: `UPDATE users SET status = 'suspended', suspended_at = now(),
                    suspended_until = NULL, suspension_reason = $2,
                    auth_version = auth_version + 1, updated_at = now()
                  WHERE id = $1 RETURNING status::text AS status`,
        unsuspend: `UPDATE users SET status = 'active', suspended_at = NULL,
                      suspended_until = NULL, suspension_reason = NULL,
                      auth_version = auth_version + 1, updated_at = now()
                    WHERE id = $1 RETURNING status::text AS status`,
        ban: `UPDATE users SET status = 'banned', banned_at = now(),
                 ban_reason = $2, auth_version = auth_version + 1,
                 suspended_at = NULL, suspended_until = NULL,
                 suspension_reason = NULL,
                 updated_at = now()
               WHERE id = $1 RETURNING status::text AS status`,
        unban: `UPDATE users SET status = 'active', banned_at = NULL,
                   ban_reason = NULL, auth_version = auth_version + 1,
                   updated_at = now()
                 WHERE id = $1 RETURNING status::text AS status`,
      };
      const updated = await client.query(
        updateSql[input.action]!,
        [userId, input.reason],
      );

      if (input.action === "suspend" || input.action === "ban") {
        await client.query(
          `UPDATE sessions SET status = 'revoked', revoked_at = now(),
                 revoke_reason = $2
           WHERE user_id = $1 AND status = 'active'`,
          [userId, `admin_${input.action}`],
        );
        await client.query(
          `UPDATE vpn_peers SET status = 'revoked', revoked_at = now(),
                 revoke_reason = $2, updated_at = now()
           WHERE user_id = $1 AND status IN ('pending', 'active')`,
          [userId, `admin_${input.action}`],
        );
      }

      const version = await client.query<{ auth_version: number }>(
        "SELECT auth_version FROM users WHERE id = $1",
        [userId],
      );
      await client.query(
        `INSERT INTO policy_events (
           user_id, event_type, reason, auth_version, payload, expires_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, now() + interval '30 days')`,
        [
          userId,
          `admin_${input.action}`,
          input.reason,
          version.rows[0]?.auth_version ?? row.auth_version,
          JSON.stringify({ actor_role: admin.role }),
        ],
      );
      return { user_id: userId, status: updated.rows[0]?.status };
    },
    { action: input.action },
  ).then((data) => ({ data }));
}

const deviceActionSchema = z.object({
  action: z.enum(["revoke", "ban", "unban"]),
  reason: reasonSchema,
});

async function changeDevice(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const params = request.params as { userId: string; deviceId: string };
  const userId = uuidSchema.parse(params.userId);
  const deviceId = uuidSchema.parse(params.deviceId);
  const input = deviceActionSchema.parse(request.body);
  ensurePermission(
    admin,
    input.action === "ban" || input.action === "unban"
      ? "devices.ban"
      : "devices.revoke",
  );

  const data = await auditedMutation(
    request,
    admin,
    `device.${input.action}`,
    "device",
    deviceId,
    input.reason,
    async (client) => {
      const current = await client.query<{
        id: string;
        user_id: string;
        revoked_at: Date | null;
        banned_at: Date | null;
      }>(
        `SELECT id, user_id, revoked_at, banned_at
         FROM devices WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [deviceId, userId],
      );
      const row = current.rows[0];
      if (!row) throw notFound("Device");

      if (input.action === "unban" && !row.banned_at) {
        throw conflict("This device is not banned.");
      }
      if (input.action === "revoke" && row.revoked_at) {
        throw conflict("This device is already revoked.");
      }

      if (input.action === "unban") {
        await client.query(
          `UPDATE devices SET banned_at = NULL, ban_reason = NULL,
             updated_at = now() WHERE id = $1`,
          [deviceId],
        );
      } else if (input.action === "ban") {
        await client.query(
          `UPDATE devices SET banned_at = COALESCE(banned_at, now()),
             ban_reason = $2, revoked_at = COALESCE(revoked_at, now()),
             revoke_reason = $2, updated_at = now() WHERE id = $1`,
          [deviceId, input.reason],
        );
      } else {
        await client.query(
          `UPDATE devices SET revoked_at = now(), revoke_reason = $2,
             updated_at = now() WHERE id = $1`,
          [deviceId, input.reason],
        );
      }

      if (input.action !== "unban") {
        await client.query(
          `UPDATE sessions SET status = 'revoked', revoked_at = now(),
             revoke_reason = $2
           WHERE device_id = $1 AND status = 'active'`,
          [deviceId, `admin_device_${input.action}`],
        );
        await client.query(
          `UPDATE vpn_peers SET status = 'revoked', revoked_at = now(),
             revoke_reason = $2, updated_at = now()
           WHERE device_id = $1 AND status IN ('pending', 'active')`,
          [deviceId, `admin_device_${input.action}`],
        );
      }
      return { device_id: deviceId, action: input.action };
    },
    { user_id: userId, action: input.action },
  );

  return { data };
}

async function revokeUserSession(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const params = request.params as { userId: string; sessionId: string };
  const userId = uuidSchema.parse(params.userId);
  const sessionId = uuidSchema.parse(params.sessionId);
  const input = z.object({ reason: reasonSchema }).parse(request.body);

  const data = await auditedMutation(
    request,
    admin,
    "session.revoke",
    "session",
    sessionId,
    input.reason,
    async (client) => {
      const result = await client.query(
        `UPDATE sessions SET status = 'revoked', revoked_at = now(),
                revoke_reason = 'admin_session_revoked'
         WHERE id = $1 AND user_id = $2 AND status = 'active'
         RETURNING id`,
        [sessionId, userId],
      );
      if (!result.rowCount) throw notFound("Active session");
      return { session_id: sessionId, revoked: true };
    },
    { user_id: userId },
  );
  return { data };
}

async function revokeAllUserSessions(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const userId = uuidSchema.parse(
    (request.params as { userId: string }).userId,
  );
  const input = z.object({ reason: reasonSchema }).parse(request.body);
  const data = await auditedMutation(
    request,
    admin,
    "user.sessions.revoke_all",
    "user",
    userId,
    input.reason,
    async (client) => {
      const user = await client.query(
        `UPDATE users SET auth_version = auth_version + 1,
                updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id`,
        [userId],
      );
      if (!user.rowCount) throw notFound("User");
      const sessions = await client.query(
        `UPDATE sessions SET status = 'revoked', revoked_at = now(),
                revoke_reason = 'admin_recovery'
         WHERE user_id = $1 AND status = 'active'
         RETURNING id`,
        [userId],
      );
      await client.query(
        `UPDATE vpn_peers SET status = 'revoked', revoked_at = now(),
                revoke_reason = 'admin_recovery', updated_at = now()
         WHERE user_id = $1 AND status IN ('pending', 'active')`,
        [userId],
      );
      return { user_id: userId, revoked_sessions: sessions.rowCount ?? 0 };
    },
  );
  return { data };
}

const sessionListQuery = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

async function listUserSessions(request: FastifyRequest) {
  const query = sessionListQuery.parse(request.query);
  const params: unknown[] = [];
  let where = "TRUE";
  if (query.search) {
    params.push(`%${query.search}%`);
    where = "(u.email ILIKE $1 OR d.name ILIKE $1)";
  }
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const result = await pool.query(
    `SELECT s.id, s.user_id, u.email, u.username,
            s.device_id, d.name AS device_name,
            s.status::text AS status, s.issued_at, s.last_used_at,
            s.expires_at, s.revoked_at, s.revoke_reason
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN devices d ON d.id = s.device_id
     WHERE ${where}
     ORDER BY s.issued_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { data: { items: result.rows, page: query.page, page_size: query.pageSize } };
}

const unsignedBigintString = z.string()
  .regex(/^\d{1,19}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);

const planSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
  name: z.string().trim().min(2).max(120),
  duration_days: z.number().int().min(1).max(3650),
  traffic_quota_bytes: unsignedBigintString,
  device_limit: z.number().int().min(1).max(100),
  concurrent_session_limit: z.number().int().min(1).max(100),
  price_irr: unsignedBigintString,
  enabled: z.boolean(),
  reason: reasonSchema,
});

async function listPlans() {
  const result = await pool.query(
    `SELECT id, code, name, duration_days,
            traffic_quota_bytes::text AS traffic_quota_bytes,
            device_limit, concurrent_session_limit,
            price_minor::text AS price_irr, currency, enabled,
            created_at, updated_at
     FROM plans ORDER BY created_at DESC`,
  );
  return { data: result.rows };
}

async function savePlan(
  request: FastifyRequest,
  admin: AdminContext,
  planId?: string,
) {
  const input = planSchema.parse(request.body);
  const id = planId ? uuidSchema.parse(planId) : randomUUID();
  const data = await auditedMutation(
    request,
    admin,
    planId ? "plan.update" : "plan.create",
    "plan",
    id,
    input.reason,
    async (client) => {
      try {
        const result = planId
          ? await client.query(
            `UPDATE plans SET
               code = $2, name = $3, duration_days = $4,
               traffic_quota_bytes = $5::bigint, device_limit = $6,
               concurrent_session_limit = $7, price_minor = $8::bigint,
               currency = 'IRR', enabled = $9, updated_at = now()
             WHERE id = $1
             RETURNING id, code, name, duration_days,
                       traffic_quota_bytes::text AS traffic_quota_bytes,
                       device_limit, concurrent_session_limit,
                       price_minor::text AS price_irr, currency, enabled`,
            [
              id,
              input.code,
              input.name,
              input.duration_days,
              input.traffic_quota_bytes,
              input.device_limit,
              input.concurrent_session_limit,
              input.price_irr,
              input.enabled,
            ],
          )
          : await client.query(
            `INSERT INTO plans (
               id, code, name, duration_days, traffic_quota_bytes,
               device_limit, concurrent_session_limit, price_minor,
               currency, enabled
             ) VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8::bigint, 'IRR', $9)
             RETURNING id, code, name, duration_days,
                       traffic_quota_bytes::text AS traffic_quota_bytes,
                       device_limit, concurrent_session_limit,
                       price_minor::text AS price_irr, currency, enabled`,
            [
              id,
              input.code,
              input.name,
              input.duration_days,
              input.traffic_quota_bytes,
              input.device_limit,
              input.concurrent_session_limit,
              input.price_irr,
              input.enabled,
            ],
          );
        if (planId && !result.rowCount) throw notFound("Plan");
        return result.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw conflict("A plan with this code already exists.");
        }
        throw error;
      }
    },
    { code: input.code },
  );
  return { data };
}

const subscriptionListQuery = z.object({
  status: z.enum(["pending", "active", "paused", "expired", "cancelled"])
    .optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

async function listSubscriptions(request: FastifyRequest) {
  const query = subscriptionListQuery.parse(request.query);
  const params: unknown[] = [];
  let where = "TRUE";
  if (query.status) {
    params.push(query.status);
    where = `s.status = $${params.length}::subscription_status`;
  }
  const count = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM subscriptions s WHERE ${where}`,
    params,
  );
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const result = await pool.query(
    `SELECT s.id, s.user_id, u.email, u.username,
            s.plan_id, p.code AS plan_code, p.name AS plan_name,
            s.status::text AS status, s.starts_at, s.ends_at,
            s.traffic_quota_bytes::text AS traffic_quota_bytes,
            (s.used_rx_bytes + s.used_tx_bytes)::text AS used_bytes,
            s.device_limit, s.concurrent_session_limit,
            s.created_at, s.updated_at
     FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     JOIN plans p ON p.id = s.plan_id
     WHERE ${where}
     ORDER BY s.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    data: {
      items: result.rows,
      page: query.page,
      page_size: query.pageSize,
      total: Number(count.rows[0]?.total ?? 0),
    },
  };
}

const subscriptionAdjustmentSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("extend_days"),
    days: z.number().int().min(1).max(3650),
    reason: reasonSchema,
  }),
  z.object({
    action: z.literal("add_traffic"),
    bytes: unsignedBigintString,
    reason: reasonSchema,
  }),
  z.object({
    action: z.literal("change_plan"),
    plan_id: z.string().uuid(),
    reason: reasonSchema,
  }),
]);

async function adjustSubscription(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const subscriptionId = uuidSchema.parse(
    (request.params as { subscriptionId: string }).subscriptionId,
  );
  const input = subscriptionAdjustmentSchema.parse(request.body);
  ensurePermission(
    admin,
    input.action === "add_traffic"
      ? "subscriptions.traffic"
      : "subscriptions.write",
  );

  const data = await auditedMutation(
    request,
    admin,
    `subscription.${input.action}`,
    "subscription",
    subscriptionId,
    input.reason,
    async (client) => {
      const current = await client.query<{
        id: string;
        status: string;
      }>(
        `SELECT id, status::text AS status FROM subscriptions
         WHERE id = $1 FOR UPDATE`,
        [subscriptionId],
      );
      if (!current.rowCount) throw notFound("Subscription");
      if (current.rows[0]?.status !== "active") {
        throw conflict("Only an active subscription can be adjusted.");
      }

      let result;
      if (input.action === "extend_days") {
        result = await client.query(
          `UPDATE subscriptions
           SET ends_at = GREATEST(COALESCE(ends_at, now()), now())
                          + ($2 * interval '1 day'),
               updated_at = now()
           WHERE id = $1
           RETURNING id, status::text AS status, ends_at`,
          [subscriptionId, input.days],
        );
      } else if (input.action === "add_traffic") {
        result = await client.query(
          `UPDATE subscriptions
           SET traffic_quota_bytes = traffic_quota_bytes + $2::bigint,
               updated_at = now()
           WHERE id = $1
           RETURNING id, status::text AS status,
                     traffic_quota_bytes::text AS traffic_quota_bytes`,
          [subscriptionId, input.bytes],
        );
      } else {
        const plan = await client.query(
          `SELECT id, traffic_quota_bytes, device_limit,
                  concurrent_session_limit
           FROM plans WHERE id = $1 AND enabled = true`,
          [input.plan_id],
        );
        if (!plan.rowCount) throw notFound("Enabled plan");
        result = await client.query(
          `UPDATE subscriptions
           SET plan_id = $2,
               traffic_quota_bytes = $3,
               device_limit = $4,
               concurrent_session_limit = $5,
               updated_at = now()
           WHERE id = $1
           RETURNING id, plan_id, status::text AS status,
                     traffic_quota_bytes::text AS traffic_quota_bytes,
                     device_limit, concurrent_session_limit`,
          [
            subscriptionId,
            input.plan_id,
            plan.rows[0].traffic_quota_bytes,
            plan.rows[0].device_limit,
            plan.rows[0].concurrent_session_limit,
          ],
        );
      }
      return result.rows[0];
    },
    input.action === "extend_days"
      ? { days: input.days }
      : input.action === "add_traffic"
        ? { bytes: input.bytes }
        : { plan_id: input.plan_id },
  );
  return { data };
}

async function listPayments(request: FastifyRequest) {
  const query = z.object({
    status: z.enum(["pending", "authorized", "paid", "failed", "refunded", "cancelled"])
      .optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  }).parse(request.query);
  const params: unknown[] = [];
  let where = "TRUE";
  if (query.status) {
    params.push(query.status);
    where = `p.status = $${params.length}::payment_status`;
  }
  const count = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM payments p WHERE ${where}`,
    params,
  );
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const result = await pool.query(
    `SELECT p.id, p.user_id, u.email, p.subscription_id, p.provider,
            p.amount_minor::text AS amount_irr, p.currency,
            p.status::text AS status, p.failure_code, p.paid_at, p.created_at
     FROM payments p JOIN users u ON u.id = p.user_id
     WHERE ${where}
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    data: {
      items: result.rows,
      page: query.page,
      page_size: query.pageSize,
      total: Number(count.rows[0]?.total ?? 0),
      provider_writes_enabled: false,
    },
  };
}

const nodeCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  country_code: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((v) => v.toUpperCase()),
  region: z.string().trim().min(2).max(120),
  city: z.string().trim().max(120).nullable().optional(),
  hostname: z.string().trim().min(3).max(255),
  public_endpoint: z.string().trim().min(3).max(255),
  public_key: z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/),
  capacity_peers: z.number().int().min(0).max(1_000_000),
  reason: reasonSchema,
});

async function listNodes() {
  const result = await pool.query(
    `SELECT n.id, n.name, n.country_code, n.region, n.city,
            n.hostname, n.public_endpoint,
            CASE WHEN n.status = 'online' THEN 'offline'
                 ELSE n.status::text END AS status,
            n.capacity_peers, n.current_peers, n.enabled, n.last_seen_at,
            n.created_at, n.updated_at,
            (SELECT COALESCE(sum(t.rx_bytes + t.tx_bytes), 0)::text
               FROM traffic_usage t WHERE t.vpn_node_id = n.id) AS reported_traffic_bytes
     FROM vpn_nodes n ORDER BY n.country_code, n.region, n.name`,
  );
  return {
    data: {
      items: result.rows,
      online_status_source: "node_agent_not_connected",
    },
  };
}

async function createNode(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const input = nodeCreateSchema.parse(request.body);
  const nodeId = randomUUID();
  const data = await auditedMutation(
    request,
    admin,
    "node.create",
    "vpn_node",
    nodeId,
    input.reason,
    async (client) => {
      try {
        const result = await client.query(
          `INSERT INTO vpn_nodes (
             id, name, country_code, region, city, hostname,
             public_endpoint, public_key, capacity_peers, enabled, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, 'offline')
           RETURNING id, name, country_code, region, city, hostname,
                     public_endpoint, status::text AS status,
                     capacity_peers, current_peers, enabled, last_seen_at`,
          [
            nodeId,
            input.name,
            input.country_code,
            input.region,
            input.city ?? null,
            input.hostname,
            input.public_endpoint,
            input.public_key,
            input.capacity_peers,
          ],
        );
        return result.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw conflict("Node hostname or public key already exists.");
        }
        throw error;
      }
    },
    { country_code: input.country_code, region: input.region },
  );
  return { data };
}

const nodePatchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  country_code: z.string().trim().regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase()).optional(),
  region: z.string().trim().min(2).max(120).optional(),
  city: z.string().trim().max(120).nullable().optional(),
  hostname: z.string().trim().min(3).max(255).optional(),
  public_endpoint: z.string().trim().min(3).max(255).optional(),
  capacity_peers: z.number().int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["offline", "maintenance", "disabled"]).optional(),
  reason: reasonSchema,
}).refine((value) => Object.keys(value).some((key) => key !== "reason"));

async function updateNode(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const nodeId = uuidSchema.parse(
    (request.params as { nodeId: string }).nodeId,
  );
  const input = nodePatchSchema.parse(request.body);
  const fields: Array<[keyof typeof input, string]> = [
    ["name", "name"],
    ["country_code", "country_code"],
    ["region", "region"],
    ["city", "city"],
    ["hostname", "hostname"],
    ["public_endpoint", "public_endpoint"],
    ["capacity_peers", "capacity_peers"],
    ["enabled", "enabled"],
    ["status", "status"],
  ];
  const data = await auditedMutation(
    request,
    admin,
    "node.update",
    "vpn_node",
    nodeId,
    input.reason,
    async (client) => {
      const current = await client.query<{
        status: string;
        enabled: boolean;
      }>(
        `SELECT status::text AS status, enabled
         FROM vpn_nodes WHERE id = $1 FOR UPDATE`,
        [nodeId],
      );
      const existing = current.rows[0];
      if (!existing) throw notFound("VPN node");

      const nextStatus = input.status ?? existing.status;
      const nextEnabled = input.status === "disabled"
        ? input.enabled ?? false
        : input.enabled ?? existing.enabled;
      if (nextStatus === "disabled" && nextEnabled) {
        throw conflict("A disabled VPN node cannot be enabled for assignment.");
      }
      const values = {
        ...input,
        enabled: nextEnabled,
      };
      const updates = fields.filter(([key]) =>
        key === "enabled" ? input.enabled !== undefined || input.status === "disabled"
          : input[key] !== undefined,
      );
      const params: unknown[] = [nodeId];
      const assignments = updates.map(([key, column]) => {
        params.push(values[key]);
        const cast = column === "status" ? "::vpn_node_status" : "";
        return `${column} = $${params.length}${cast}`;
      });
      const result = await client.query(
        `UPDATE vpn_nodes
         SET ${assignments.join(", ")}, updated_at = now()
         WHERE id = $1
         RETURNING id, name, country_code, region, city, hostname,
                   public_endpoint, status::text AS status,
                   capacity_peers, current_peers, enabled, last_seen_at`,
        params,
      );
      if (!result.rowCount) throw notFound("VPN node");
      return result.rows[0];
    },
    {
      fields: [
        ...Object.keys(input).filter((key) => key !== "reason"),
        ...(input.status === "disabled" && input.enabled === undefined
          ? ["enabled"]
          : []),
      ].sort(),
    },
  );
  return { data };
}

const auditListQuery = z.object({
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

async function listAdminAudit(request: FastifyRequest) {
  const query = auditListQuery.parse(request.query);
  const params: unknown[] = [];
  let where = "TRUE";
  if (query.search) {
    params.push(`%${query.search}%`);
    where = `(admin_email ILIKE $1 OR action ILIKE $1 OR resource_type ILIKE $1)`;
  }
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const result = await pool.query(
    `SELECT id, admin_email, admin_role::text AS admin_role,
            action, resource_type, resource_id, reason,
            request_id, created_at, metadata
     FROM admin_audit_logs WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { data: { items: result.rows, page: query.page, page_size: query.pageSize } };
}

async function listAdminLogins(
  request: FastifyRequest,
  _reply: FastifyReply,
  admin: AdminContext,
) {
  const query = auditListQuery.parse(request.query);
  const params: unknown[] = [];
  let where = "TRUE";
  if (query.search) {
    params.push(`%${query.search}%`);
    where = "email_normalized ILIKE $1";
  }
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const result = await pool.query(
    `SELECT id, admin_id, email_normalized, outcome,
            request_id, created_at
     FROM admin_login_events WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  await auditSensitiveRead(
    request,
    admin,
    "admin.login_history.read",
    "admin_login_event",
    null,
    { page: query.page, page_size: query.pageSize, search_applied: Boolean(query.search) },
  );
  return { data: { items: result.rows, page: query.page, page_size: query.pageSize } };
}

async function listAdmins(
  request: FastifyRequest,
  _reply: FastifyReply,
  admin: AdminContext,
) {
  const result = await pool.query(
    `SELECT id, email, role::text AS role, status::text AS status,
            mfa_enabled, last_login_at, created_at,
            (SELECT count(*)::text FROM admin_sessions s
             WHERE s.admin_id = a.id AND s.revoked_at IS NULL
               AND s.expires_at > now()) AS active_sessions
     FROM admin_accounts a
     ORDER BY created_at ASC`,
  );
  await auditSensitiveRead(
    request,
    admin,
    "admin.accounts.read",
    "admin_account",
    null,
    { count: result.rowCount ?? 0 },
  );
  return { data: result.rows };
}

const createAdminSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(16).max(128),
  role: z.enum(["superadmin", "admin", "support", "read_only"]),
  reason: reasonSchema,
});

async function createAdmin(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const input = createAdminSchema.parse(request.body);
  const email = input.email.trim();
  const emailNormalized = email.toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const id = randomUUID();
  const data = await auditedMutation(
    request,
    admin,
    "admin.create",
    "admin_account",
    id,
    input.reason,
    async (client) => {
      try {
        const result = await client.query(
          `INSERT INTO admin_accounts (
             id, email, email_normalized, password_hash,
             role, created_by_admin_id
           ) VALUES ($1, $2, $3, $4, $5::admin_role, $6)
           RETURNING id, email, role::text AS role,
                     status::text AS status, mfa_enabled, created_at`,
          [id, email, emailNormalized, passwordHash, input.role, admin.id],
        );
        return result.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw conflict("An Admin account with this email already exists.");
        }
        throw error;
      }
    },
    { role: input.role },
  );
  return { data };
}

const adminUpdateSchema = z.object({
  role: z.enum(["superadmin", "admin", "support", "read_only"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  reason: reasonSchema,
}).refine((value) => value.role !== undefined || value.status !== undefined);

async function updateAdmin(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const targetId = uuidSchema.parse(
    (request.params as { adminId: string }).adminId,
  );
  const input = adminUpdateSchema.parse(request.body);

  const data = await auditedMutation(
    request,
    admin,
    "admin.update",
    "admin_account",
    targetId,
    input.reason,
    async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        ["hoaxconnect_admin_superadmin_guard"],
      );
      const currentResult = await client.query<{
        id: string;
        email: string;
        role: AdminRole;
        status: string;
      }>(
        `SELECT id, email, role::text AS role, status::text AS status
         FROM admin_accounts WHERE id = $1 FOR UPDATE`,
        [targetId],
      );
      const current = currentResult.rows[0];
      if (!current) throw notFound("Admin account");
      const nextRole = input.role ?? current.role;
      const nextStatus = input.status ?? current.status;

      if (
        current.role === "superadmin" &&
        current.status === "active" &&
        (nextRole !== "superadmin" || nextStatus !== "active")
      ) {
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM admin_accounts
           WHERE role = 'superadmin' AND status = 'active'`,
        );
        if (Number(count.rows[0]?.count ?? 0) <= 1) {
          throw conflict("The last active superadmin cannot be disabled or demoted.");
        }
      }

      if (
        targetId === admin.id &&
        (nextRole !== "superadmin" || nextStatus !== "active")
      ) {
        throw conflict("You cannot disable or demote your current Admin account.");
      }

      const result = await client.query(
        `UPDATE admin_accounts
         SET role = $2::admin_role, status = $3::admin_account_status,
             updated_at = now()
         WHERE id = $1
         RETURNING id, email, role::text AS role,
                   status::text AS status, mfa_enabled,
                   last_login_at, created_at`,
        [targetId, nextRole, nextStatus],
      );
      if (nextStatus === "disabled") {
        await client.query(
          `UPDATE admin_sessions SET revoked_at = now()
           WHERE admin_id = $1 AND revoked_at IS NULL`,
          [targetId],
        );
      }
      return result.rows[0];
    },
    { role: input.role, status: input.status },
  );
  return { data };
}

async function revokeAdminSessions(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const targetId = uuidSchema.parse(
    (request.params as { adminId: string }).adminId,
  );
  const input = z.object({ reason: reasonSchema }).parse(request.body);
  const data = await auditedMutation(
    request,
    admin,
    "admin.sessions.revoke_all",
    "admin_account",
    targetId,
    input.reason,
    async (client) => {
      const target = await client.query(
        "SELECT id FROM admin_accounts WHERE id = $1 FOR UPDATE",
        [targetId],
      );
      if (!target.rowCount) throw notFound("Admin account");
      const revoked = await client.query(
        `UPDATE admin_sessions SET revoked_at = now()
         WHERE admin_id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [targetId],
      );
      return { revoked_sessions: revoked.rowCount ?? 0 };
    },
  );
  return { data };
}

const providerNameSchema = z.enum(["sms.ir", "zarinpal"]);
const providerCredentialsSchema = z.object({
  credentials: z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
    z.string().min(1).max(2048),
  ).refine((value) => Object.keys(value).length > 0),
  reason: reasonSchema,
});

async function listProviderStatuses() {
  const result = await pool.query<{
    provider: string;
    masked_metadata: Record<string, string>;
    enabled: boolean;
    updated_at: Date;
  }>(
    `SELECT provider, masked_metadata, enabled, updated_at
     FROM admin_provider_secrets`,
  );
  const stored = new Map(result.rows.map((row) => [row.provider, row]));
  return {
    data: ["sms.ir", "zarinpal"].map((provider) => {
      const row = stored.get(provider);
      return {
        provider,
        credentials_saved: Boolean(row),
        masked_metadata: row?.masked_metadata ?? {},
        enabled: row?.enabled ?? false,
        adapter_available: false,
        updated_at: row?.updated_at ?? null,
      };
    }),
  };
}

async function saveProviderCredentials(
  request: FastifyRequest,
  admin: AdminContext,
) {
  const provider = providerNameSchema.parse(
    (request.params as { provider: string }).provider,
  );
  const input = providerCredentialsSchema.parse(request.body);
  const key = config.adminSecretEncryptionKey;
  if (!key) {
    throw apiError(
      503,
      "ADMIN_SECRET_KEY_NOT_CONFIGURED",
      "Provider credential storage is not configured on the Backend.",
    );
  }

  const encrypted = encryptProviderCredentials(input.credentials, key);
  const masked = Object.fromEntries(
    Object.entries(input.credentials).map(([name, value]) => [
      name,
      maskProviderValue(value),
    ]),
  );
  const data = await auditedMutation(
    request,
    admin,
    "provider.credentials.rotate",
    "provider",
    provider,
    input.reason,
    async (client) => {
      const result = await client.query(
        `INSERT INTO admin_provider_secrets (
           provider, credentials_ciphertext, credentials_nonce,
           credentials_tag, masked_metadata, enabled, updated_by_admin_id
         ) VALUES ($1, $2, $3, $4, $5::jsonb, false, $6)
         ON CONFLICT (provider) DO UPDATE SET
           credentials_ciphertext = EXCLUDED.credentials_ciphertext,
           credentials_nonce = EXCLUDED.credentials_nonce,
           credentials_tag = EXCLUDED.credentials_tag,
           masked_metadata = EXCLUDED.masked_metadata,
           enabled = false,
           updated_by_admin_id = EXCLUDED.updated_by_admin_id,
           updated_at = now()
         RETURNING provider, masked_metadata, enabled, updated_at`,
        [
          provider,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          JSON.stringify(masked),
          admin.id,
        ],
      );
      return {
        ...result.rows[0],
        adapter_available: false,
      };
    },
    { provider, credential_names: Object.keys(input.credentials) },
  );
  return { data };
}

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128),
});

async function loginAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  requireAllowedOrigin(request);
  requireHttps(request);
  const input = loginSchema.parse(request.body);
  const emailNormalized = input.email.trim().toLowerCase();
  const client = await pool.connect();
  const secrets = createAdminSessionSecrets();

  try {
    await client.query("BEGIN");
    const found = await client.query<{
      id: string;
      email: string;
      password_hash: string;
      role: string;
      status: string;
      failed_login_count: number;
      locked_until: Date | null;
      mfa_enabled: boolean;
    }>(
      `SELECT id, email, password_hash, role::text AS role, status::text AS status,
              failed_login_count, locked_until, mfa_enabled
       FROM admin_accounts
       WHERE email_normalized = $1
       FOR UPDATE`,
      [emailNormalized],
    );

    const row = found.rows[0];
    const hash = row?.password_hash ?? await dummyPasswordHash;
    const validPassword = await verifyPassword(hash, input.password);
    const locked = Boolean(
      row?.locked_until && new Date(row.locked_until).getTime() > Date.now(),
    );

    if (
      row?.mfa_enabled &&
      validPassword &&
      row.status === "active" &&
      !locked
    ) {
      await recordLoginEvent(
        client,
        request,
        emailNormalized,
        "failed",
        row.id,
      );
      await client.query("COMMIT");
      throw apiError(
        403,
        "ADMIN_MFA_REQUIRED",
        "This Admin account requires multi-factor sign-in, which is not available yet.",
      );
    }

    if (
      !row ||
      !validPassword ||
      row.status !== "active" ||
      locked ||
      !isAdminRole(row.role)
    ) {
      const nextFailures = (row?.failed_login_count ?? 0) + 1;
      const outcome = locked ? "locked" : "failed";

      if (row && row.status === "active" && !locked) {
        await client.query(
          `UPDATE admin_accounts
           SET failed_login_count = $2,
               locked_until = CASE
                 WHEN $2 >= $3 THEN now() + ($4 * interval '1 second')
                 ELSE locked_until
               END,
               updated_at = now()
           WHERE id = $1`,
          [row.id, nextFailures, MAX_LOGIN_FAILURES, LOGIN_LOCK_SECONDS],
        );
      }

      await recordLoginEvent(
        client,
        request,
        emailNormalized,
        outcome,
        row?.id ?? null,
      );
      await client.query("COMMIT");
      throw apiError(
        401,
        "ADMIN_LOGIN_REJECTED",
        "The email or password is incorrect, or this Admin account is unavailable.",
      );
    }

    const session = await client.query<{ id: string }>(
      `INSERT INTO admin_sessions (
         admin_id, token_hash, csrf_token_hash, expires_at,
         ip_address, user_agent
       ) VALUES ($1, $2, $3, now() + ($4 * interval '1 second'), $5::inet, $6)
       RETURNING id`,
      [
        row.id,
        secrets.sessionTokenHash,
        secrets.csrfTokenHash,
        ADMIN_SESSION_SECONDS,
        request.ip,
        requestAgent(request),
      ],
    );

    await client.query(
      `UPDATE admin_accounts
       SET failed_login_count = 0, locked_until = NULL,
           last_login_at = now(), updated_at = now()
       WHERE id = $1`,
      [row.id],
    );

    const admin = {
      id: row.id,
      email: row.email,
      role: row.role,
    } as const;
    await recordLoginEvent(
      client,
      request,
      emailNormalized,
      "success",
      row.id,
    );
    await adminLoginAudit(
      client,
      request,
      admin,
      "admin.login",
      "admin_session",
      session.rows[0]?.id ?? null,
    );
    await client.query("COMMIT");

    writeSessionCookies(reply, secrets.sessionToken, secrets.csrfToken);
    return {
      data: {
        id: row.id,
        email: row.email,
        role: row.role,
        mfa_enabled: row.mfa_enabled,
        csrf_token: secrets.csrfToken,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function dashboard() {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::text FROM users WHERE deleted_at IS NULL) AS users,
       (SELECT count(*)::text FROM sessions
          WHERE status = 'active' AND expires_at > now()) AS active_sessions,
       (SELECT count(*)::text FROM devices WHERE revoked_at IS NULL) AS active_devices,
       (SELECT count(*)::text FROM subscriptions WHERE status = 'active') AS active_subscriptions,
       (SELECT count(*)::text FROM vpn_nodes WHERE enabled) AS enabled_nodes,
       (SELECT count(*)::text FROM payments WHERE status = 'pending') AS pending_payments,
       (SELECT COALESCE(sum(rx_bytes + tx_bytes), 0)::text
          FROM traffic_usage WHERE period_date = current_date) AS traffic_today_bytes,
       (SELECT count(*)::text FROM device_limit_violations
          WHERE created_at >= now() - interval '24 hours'
            AND decision = 'rejected') AS rejected_devices_24h`,
  );

  return { data: result.rows[0] };
}

const userListQuery = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum([
    "active",
    "pending_verification",
    "suspended",
    "banned",
    "deleted",
  ]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

async function listUsers(request: FastifyRequest) {
  const query = userListQuery.parse(request.query);
  const conditions: string[] = ["u.deleted_at IS NULL"];
  const params: unknown[] = [];

  if (query.search) {
    params.push(`%${query.search.replace(/[\\%_]/g, "\\$&")}%`);
    conditions.push(
      `(u.email ILIKE $${params.length} ESCAPE '\\'
        OR u.username ILIKE $${params.length} ESCAPE '\\'
        OR COALESCE(u.phone, '') ILIKE $${params.length} ESCAPE '\\')`,
    );
  }
  if (query.status) {
    params.push(query.status);
    conditions.push(`u.status = $${params.length}::user_status`);
  }

  const where = conditions.join(" AND ");
  const count = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM users u WHERE ${where}`,
    params,
  );
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const rows = await pool.query(
    `SELECT
       u.id, u.email, u.username, u.status::text AS status,
       u.email_verified_at, u.phone,
       (u.phone_verified_at IS NOT NULL) AS phone_verified,
       u.created_at, u.last_login_at,
       (SELECT count(*)::text FROM devices d
          WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS active_devices,
       (SELECT count(*)::text FROM sessions s
          WHERE s.user_id = u.id AND s.status = 'active'
            AND s.expires_at > now()) AS active_sessions
     FROM users u
     WHERE ${where}
     ORDER BY u.created_at DESC, u.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    data: {
      items: rows.rows,
      page: query.page,
      page_size: query.pageSize,
      total: Number(count.rows[0]?.total ?? 0),
    },
  };
}

async function getUserDetail(
  request: FastifyRequest,
  _reply: FastifyReply,
  admin: AdminContext,
) {
  const userId = uuidSchema.parse(
    (request.params as { userId: string }).userId,
  );
  const user = await pool.query(
    `SELECT
       id, email, username, role::text AS role, status::text AS status,
       email_verified_at, phone, phone_verified_at,
       created_at, last_login_at, suspended_at, suspended_until,
       suspension_reason, banned_at, ban_reason
     FROM users
     WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );

  if (!user.rowCount) {
    throw apiError(404, "USER_NOT_FOUND", "The user was not found.");
  }

  const [devices, sessions, subscriptions, payments, audit] =
    await Promise.all([
      pool.query(
        `SELECT d.id, d.device_uid, d.name, d.os, d.platform, d.os_version,
                d.architecture, d.client_version, d.first_seen_at, d.last_seen_at,
                d.revoked_at, d.revoke_reason, d.banned_at, d.ban_reason, d.key_fingerprint,
                r.received_at AS report_received_at,
                CASE WHEN $2::boolean THEN host(r.ip_address) END AS reported_ip,
                CASE WHEN r.device_id IS NULL THEN 'not_reported'
                     WHEN d.revoked_at IS NOT NULL OR d.banned_at IS NOT NULL
                       OR s.status <> 'active' OR s.expires_at <= now() OR u.status <> 'active'
                       THEN 'session_inactive'
                     WHEN r.app_state = 'closed' THEN 'closed'
                     WHEN r.received_at < now() - interval '90 seconds' THEN 'not_reporting'
                     ELSE 'online' END AS presence,
                CASE WHEN $2::boolean THEN r.permissions END AS report_permissions,
                $2::boolean AS report_details_allowed,
                CASE WHEN $2::boolean THEN r.hardware END AS hardware,
                CASE WHEN $2::boolean THEN r.network END AS network,
                CASE WHEN $2::boolean AND r.received_at >= now() - interval '90 seconds'
                     AND r.app_state = 'running' AND s.status = 'active' AND s.expires_at > now()
                     AND d.revoked_at IS NULL AND d.banned_at IS NULL AND u.status = 'active'
                     THEN r.applications END AS applications
         FROM devices d JOIN users u ON u.id = d.user_id
         LEFT JOIN client_device_reports r ON r.device_id = d.id
           AND r.received_at >= now() - interval '24 hours'
         LEFT JOIN sessions s ON s.id = r.session_id
         WHERE d.user_id = $1 ORDER BY d.last_seen_at DESC`,
        [userId, hasAdminPermission(admin.role, "telemetry.read")],
      ),
      pool.query(
        `SELECT s.id, s.family_id, s.device_id, d.name AS device_name,
                s.status::text AS status, s.issued_at, s.last_used_at,
                s.expires_at, s.revoked_at, s.revoke_reason, host(s.ip_address) AS ip_address
         FROM sessions s JOIN devices d ON d.id = s.device_id
         WHERE s.user_id = $1 ORDER BY s.issued_at DESC LIMIT 100`,
        [userId],
      ),
      pool.query(
        `SELECT s.id, s.plan_id, p.code AS plan_code, p.name AS plan_name,
                s.status::text AS status, s.starts_at, s.ends_at,
                s.traffic_quota_bytes::text AS traffic_quota_bytes,
                (s.used_rx_bytes + s.used_tx_bytes)::text AS used_bytes,
                s.device_limit, s.concurrent_session_limit
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id
         WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 100`,
        [userId],
      ),
      pool.query(
        `SELECT id, provider, amount_minor::text AS amount_minor,
                currency, status::text AS status, failure_code,
                paid_at, created_at
         FROM payments WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 100`,
        [userId],
      ),
      pool.query(
        `SELECT action, resource_type, resource_id, request_id,
                created_at, metadata
         FROM audit_logs
         WHERE resource_type = 'user' AND resource_id = $1
         ORDER BY created_at DESC LIMIT 100`,
        [userId],
      ),
    ]);

  await auditSensitiveRead(
    request,
    admin,
    "user.detail.read",
    "user",
    userId,
  );

  return {
    data: {
      user: user.rows[0],
      devices: devices.rows,
      sessions: sessions.rows,
      subscriptions: subscriptions.rows,
      payments: payments.rows,
      audit: audit.rows,
    },
  };
}

async function alerts() {
  const result = await pool.query(
    `SELECT id::text AS id, user_id::text AS user_id,
            'device_limit'::text AS category,
            decision::text AS event,
            'Device enrollment decision'::text AS summary,
            created_at
     FROM device_limit_violations
     WHERE decision IN ('rejected', 'held')
     UNION ALL
     SELECT id::text, user_id::text, 'policy'::text,
            event_type, COALESCE(reason, event_type), created_at
     FROM policy_events
     ORDER BY created_at DESC
     LIMIT 100`,
  );
  return { data: result.rows };
}

const trafficDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value;
  });

const trafficListQuery = z.object({
  from: trafficDateSchema.optional(),
  to: trafficDateSchema.optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

async function listTraffic(
  request: FastifyRequest,
  _reply: FastifyReply,
  admin: AdminContext,
) {
  const query = trafficListQuery.parse(request.query);
  const today = new Date().toISOString().slice(0, 10);
  const to = query.to ?? today;
  const from = query.from ?? new Date(
    Date.parse(`${to}T00:00:00.000Z`) - 6 * 24 * 60 * 60 * 1000,
  ).toISOString().slice(0, 10);
  const rangeDays = (Date.parse(`${to}T00:00:00.000Z`) -
    Date.parse(`${from}T00:00:00.000Z`)) / (24 * 60 * 60 * 1000);
  if (rangeDays < 0 || rangeDays > 90) {
    throw apiError(
      400,
      "ADMIN_TRAFFIC_RANGE_INVALID",
      "Choose a traffic date range of at most 90 days.",
    );
  }

  const conditions = ["t.period_date >= $1::date", "t.period_date <= $2::date"];
  const filters: unknown[] = [from, to];
  if (query.search) {
    filters.push(`%${query.search.replace(/[\\%_]/g, "\\$&")}%`);
    const parameter = `$${filters.length}`;
    conditions.push(
      `(u.email ILIKE ${parameter} ESCAPE '\\'
        OR u.username ILIKE ${parameter} ESCAPE '\\'
        OR d.name ILIKE ${parameter} ESCAPE '\\'
        OR n.name ILIKE ${parameter} ESCAPE '\\')`,
    );
  }
  const where = conditions.join(" AND ");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const [rows, summary] = await Promise.all([
      client.query(
        `SELECT t.id::text AS id, t.user_id::text AS user_id,
                u.email, u.username, u.status::text AS account_status,
                t.device_id::text AS device_id, d.name AS device_name,
                d.os AS device_os, t.vpn_node_id::text AS node_id,
                n.name AS node_name, t.period_date::text AS period_date,
                t.period_start, t.period_end,
                t.rx_bytes::text AS rx_bytes, t.tx_bytes::text AS tx_bytes,
                (t.rx_bytes::numeric + t.tx_bytes::numeric)::text AS total_bytes,
                t.source
         FROM traffic_usage t
         JOIN users u ON u.id = t.user_id
         JOIN devices d ON d.id = t.device_id
         LEFT JOIN vpn_nodes n ON n.id = t.vpn_node_id
         WHERE ${where}
         ORDER BY t.period_start DESC, t.id DESC
         LIMIT $${filters.length + 1} OFFSET $${filters.length + 2}`,
        [...filters, query.pageSize, (query.page - 1) * query.pageSize],
      ),
      client.query(
        `SELECT count(*)::text AS total,
                COALESCE(sum(t.rx_bytes), 0)::text AS rx_bytes,
                COALESCE(sum(t.tx_bytes), 0)::text AS tx_bytes,
                COALESCE(sum(t.rx_bytes::numeric + t.tx_bytes::numeric), 0)::text AS total_bytes
         FROM traffic_usage t
         JOIN users u ON u.id = t.user_id
         JOIN devices d ON d.id = t.device_id
         LEFT JOIN vpn_nodes n ON n.id = t.vpn_node_id
         WHERE ${where}`,
        filters,
      ),
    ]);
    await adminLoginAudit(
      client,
      request,
      admin,
      "telemetry.traffic.read",
      "traffic_usage",
      null,
      null,
      {
        from,
        to,
        page: query.page,
        page_size: query.pageSize,
        search_applied: Boolean(query.search),
      },
    );
    await client.query("COMMIT");
    return {
      data: {
        items: rows.rows,
        page: query.page,
        page_size: query.pageSize,
        ...summary.rows[0],
        total: Number(summary.rows[0]?.total ?? 0),
        range: { from, to },
        source: "traffic_usage accounting records",
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function listAdminSessions(
  _request: FastifyRequest,
  _reply: FastifyReply,
  admin: AdminContext,
) {
  const result = await pool.query(
    `SELECT id, created_at, last_used_at, expires_at, revoked_at,
            replaced_by_session_id,
            CASE WHEN id = $2 THEN true ELSE false END AS current
     FROM admin_sessions
     WHERE admin_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [admin.id, admin.sessionId],
  );
  return { data: result.rows };
}

export async function registerAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/api/v1/admin/auth/login",
    {
      config: {
        rateLimit: {
          max: 8,
          timeWindow: "1 minute",
        },
      },
    },
    loginAdmin,
  );

  app.get(
    "/api/v1/admin/auth/me",
    adminHandler("dashboard.read", async (_request, _reply, admin) => ({
      data: {
        id: admin.id,
        email: admin.email,
        role: admin.role,
        mfa_enabled: admin.mfaEnabled,
        session_expires_at: admin.sessionExpiresAt,
      },
    })),
  );

  app.get(
    "/api/v1/admin/auth/sessions",
    adminHandler("dashboard.read", listAdminSessions),
  );

  app.post(
    "/api/v1/admin/auth/rotate",
    adminHandler(
      "dashboard.read",
      async (request, reply, admin) => {
        const secrets = createAdminSessionSecrets();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const current = await client.query<{ expires_at: Date }>(
            `SELECT expires_at FROM admin_sessions
             WHERE id = $1 AND revoked_at IS NULL
             FOR UPDATE`,
            [admin.sessionId],
          );
          if (!current.rowCount) throw unauthenticated();

          const inserted = await client.query<{ id: string }>(
            `INSERT INTO admin_sessions (
               admin_id, token_hash, csrf_token_hash, expires_at,
               ip_address, user_agent
             ) VALUES ($1, $2, $3, now() + ($4 * interval '1 second'), $5::inet, $6)
             RETURNING id`,
            [
              admin.id,
              secrets.sessionTokenHash,
              secrets.csrfTokenHash,
              ADMIN_SESSION_SECONDS,
              request.ip,
              requestAgent(request),
            ],
          );
          await client.query(
            `UPDATE admin_sessions
             SET revoked_at = now(), replaced_by_session_id = $2
             WHERE id = $1`,
            [admin.sessionId, inserted.rows[0]?.id],
          );
          await adminLoginAudit(
            client,
            request,
            admin,
            "admin.session.rotate",
            "admin_session",
            inserted.rows[0]?.id ?? null,
          );
          await client.query("COMMIT");
          writeSessionCookies(reply, secrets.sessionToken, secrets.csrfToken);
          return { data: { csrf_token: secrets.csrfToken } };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
      true,
    ),
  );

  app.post(
    "/api/v1/admin/auth/logout",
    adminHandler(
      "dashboard.read",
      async (_request, reply, admin) => {
        await pool.query(
          `UPDATE admin_sessions SET revoked_at = now()
           WHERE id = $1 AND revoked_at IS NULL`,
          [admin.sessionId],
        );
        clearSessionCookie(reply);
        return { data: { revoked: true } };
      },
      true,
    ),
  );

  app.post(
    "/api/v1/admin/auth/logout-all",
    adminHandler(
      "dashboard.read",
      async (request, reply, admin) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `UPDATE admin_sessions SET revoked_at = now()
             WHERE admin_id = $1 AND revoked_at IS NULL`,
            [admin.id],
          );
          await adminLoginAudit(
            client,
            request,
            admin,
            "admin.sessions.revoke_all",
            "admin_account",
            admin.id,
          );
          await client.query("COMMIT");
          clearSessionCookie(reply);
          return { data: { revoked: true } };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
      true,
    ),
  );

  app.get(
    "/api/v1/admin/dashboard",
    adminHandler("dashboard.read", dashboard),
  );

  app.get(
    "/api/v1/admin/alerts",
    adminHandler("dashboard.read", alerts),
  );

  app.get(
    "/api/v1/admin/traffic",
    adminHandler("telemetry.read", listTraffic),
  );

  app.get(
    "/api/v1/admin/users",
    adminHandler("users.read", listUsers),
  );

  app.get(
    "/api/v1/admin/users/:userId",
    adminHandler("users.detail", getUserDetail),
  );

  app.post(
    "/api/v1/admin/users/:userId/status",
    adminHandler(
      "users.suspend",
      async (request, _reply, admin) => changeUserStatus(request, admin),
      true,
    ),
  );

  app.post(
    "/api/v1/admin/users/:userId/devices/:deviceId",
    adminHandler(
      "devices.revoke",
      async (request, _reply, admin) => changeDevice(request, admin),
      true,
    ),
  );

  app.post(
    "/api/v1/admin/users/:userId/sessions/:sessionId/revoke",
    adminHandler(
      "sessions.revoke",
      async (request, _reply, admin) => revokeUserSession(request, admin),
      true,
    ),
  );

  app.post(
    "/api/v1/admin/users/:userId/revoke-sessions",
    adminHandler(
      "users.recover",
      async (request, _reply, admin) => revokeAllUserSessions(request, admin),
      true,
    ),
  );

  app.get(
    "/api/v1/admin/sessions",
    adminHandler("sessions.read", listUserSessions),
  );

  app.get(
    "/api/v1/admin/plans",
    adminHandler("plans.read", listPlans),
  );

  app.post(
    "/api/v1/admin/plans",
    adminHandler(
      "plans.write",
      async (request, _reply, admin) => savePlan(request, admin),
      true,
    ),
  );

  app.patch(
    "/api/v1/admin/plans/:planId",
    adminHandler(
      "plans.write",
      async (request, _reply, admin) => savePlan(
        request,
        admin,
        (request.params as { planId: string }).planId,
      ),
      true,
    ),
  );

  app.get(
    "/api/v1/admin/subscriptions",
    adminHandler("subscriptions.read", listSubscriptions),
  );

  app.post(
    "/api/v1/admin/subscriptions/:subscriptionId/adjust",
    adminHandler(
      "subscriptions.write",
      async (request, _reply, admin) => adjustSubscription(request, admin),
      true,
    ),
  );

  app.get(
    "/api/v1/admin/payments",
    adminHandler("payments.read", listPayments),
  );

  app.get(
    "/api/v1/admin/nodes",
    adminHandler("nodes.read", listNodes),
  );

  app.post(
    "/api/v1/admin/nodes",
    adminHandler(
      "nodes.write",
      async (request, _reply, admin) => createNode(request, admin),
      true,
    ),
  );

  app.patch(
    "/api/v1/admin/nodes/:nodeId",
    adminHandler(
      "nodes.write",
      async (request, _reply, admin) => updateNode(request, admin),
      true,
    ),
  );

  app.get(
    "/api/v1/admin/audit",
    adminHandler("audit.read", listAdminAudit),
  );

  app.get(
    "/api/v1/admin/security/logins",
    adminHandler("audit.sensitive.read", listAdminLogins),
  );

  app.get(
    "/api/v1/admin/admins",
    adminHandler("admins.manage", listAdmins),
  );

  app.post(
    "/api/v1/admin/admins",
    adminHandler(
      "admins.manage",
      async (request, _reply, admin) => createAdmin(request, admin),
      true,
    ),
  );

  app.patch(
    "/api/v1/admin/admins/:adminId",
    adminHandler(
      "admins.manage",
      async (request, _reply, admin) => updateAdmin(request, admin),
      true,
    ),
  );

  app.post(
    "/api/v1/admin/admins/:adminId/revoke-sessions",
    adminHandler(
      "admins.manage",
      async (request, _reply, admin) => revokeAdminSessions(request, admin),
      true,
    ),
  );

  app.get(
    "/api/v1/admin/providers",
    adminHandler("providers.status.read", listProviderStatuses),
  );

  app.put(
    "/api/v1/admin/providers/:provider/credentials",
    adminHandler(
      "providers.secrets.write",
      async (request, _reply, admin) => saveProviderCredentials(request, admin),
      true,
    ),
  );
}
