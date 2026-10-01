import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticate } from "./auth.js";
import { pool } from "./db.js";
import { ApiError } from "./errors.js";

const text = z.string().trim().min(1).max(160);
export const clientReportSchema = z.object({
  version: z.literal(1),
  app_state: z.enum(["running", "closed"]),
  permissions: z.object({
    hardware: z.boolean(), network: z.boolean(), applications: z.boolean(),
  }).strict(),
  hardware: z.object({
    hwid_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    manufacturer: text.nullable(), model: text.nullable(), cpu: text.nullable(),
    memory_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).strict().nullable(),
  network: z.object({
    interface_online: z.boolean(),
    backend_rtt_ms: z.number().int().min(0).max(120_000).nullable(),
    failed_heartbeats: z.number().int().min(0).max(1_000_000),
  }).strict().nullable(),
  applications: z.array(z.string().min(1).max(80)
    .regex(/^[\p{L}\p{N} _().+-]+$/u)).max(64).nullable(),
}).strict().superRefine((value, ctx) => {
  for (const key of ["hardware", "network", "applications"] as const) {
    if ((!value.permissions[key] || value.app_state === "closed") && value[key] !== null) {
      ctx.addIssue({ code: "custom", path: [key], message: "Unshared data must be omitted" });
    }
  }
});

export async function registerClientReportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/client/device-report", {
    bodyLimit: 16_384,
    // Several devices can share one public IP; each sends two heartbeats/minute.
    config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
  }, async (request) => {
    const auth = await authenticate(request);
    const input = clientReportSchema.parse(request.body);
    // Bind the report to the authenticated session, never a client-supplied ID/IP.
    const result = await pool.query(
      `INSERT INTO client_device_reports
         (device_id, session_id, ip_address, app_state, permissions, hardware, network, applications)
       SELECT d.id, s.id, $3::inet, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb
       FROM devices d JOIN sessions s ON s.device_id = d.id
       JOIN users u ON u.id = d.user_id
       WHERE s.id = $1 AND d.id = $2 AND s.status = 'active'
         AND s.expires_at > now() AND d.revoked_at IS NULL AND d.banned_at IS NULL
         AND u.status = 'active' AND u.auth_version = $9
       ON CONFLICT (device_id) DO UPDATE SET
         session_id = EXCLUDED.session_id, received_at = now(), ip_address = EXCLUDED.ip_address,
         app_state = EXCLUDED.app_state, permissions = EXCLUDED.permissions,
         hardware = EXCLUDED.hardware, network = EXCLUDED.network, applications = EXCLUDED.applications
       RETURNING received_at`,
      [auth.sessionId, auth.deviceId, request.ip, input.app_state,
        JSON.stringify(input.permissions), input.hardware && JSON.stringify(input.hardware),
        input.network && JSON.stringify(input.network), input.applications && JSON.stringify(input.applications),
        auth.authVersion],
    );
    if (!result.rowCount) throw new ApiError(401, "SESSION_INVALID", "The session is no longer active.");
    return { data: { received_at: result.rows[0].received_at } };
  });

  let cleanup: ReturnType<typeof setInterval> | undefined;
  const purge = () => pool.query("DELETE FROM client_device_reports WHERE received_at < now() - interval '24 hours'")
    .catch(() => app.log.warn("Expired device reports could not be removed"));
  app.addHook("onReady", async () => {
    await purge();
    cleanup = setInterval(() => { void purge(); }, 60 * 60 * 1000);
    cleanup.unref();
  });
  app.addHook("onClose", async () => { clearInterval(cleanup); });
}
