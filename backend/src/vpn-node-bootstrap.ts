import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { pool } from "./db.js";

const nodeIdSchema = z.string().uuid();
const ttlSchema = z.number().int().min(1).max(60);

export async function createVpnNodeEnrollmentToken(
  nodeIdInput: string,
  ttlMinutesInput = 15,
): Promise<{ token: string; expiresAt: string }> {
  const nodeId = nodeIdSchema.parse(nodeIdInput);
  const ttlMinutes = ttlSchema.parse(ttlMinutesInput);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const result = await pool.query<{ expires_at: Date }>(
    `INSERT INTO vpn_node_enrollment_tokens (
       vpn_node_id, token_hash, expires_at
     ) SELECT id, $2, now() + ($3 * interval '1 minute')
       FROM vpn_nodes WHERE id = $1
     RETURNING expires_at`,
    [nodeId, tokenHash, ttlMinutes],
  );
  if (!result.rows[0]) throw new Error("VPN node not found");
  return { token, expiresAt: result.rows[0].expires_at.toISOString() };
}

async function run() {
  const nodeId = process.argv[2];
  const ttl = process.argv[3] ? Number(process.argv[3]) : 15;
  if (!nodeId) throw new Error("Usage: npm run vpn-node:bootstrap -- <node-id> [ttl-minutes]");
  const enrollment = await createVpnNodeEnrollmentToken(nodeId, ttl);
  process.stdout.write(
    `VPN node enrollment token (shown once): ${enrollment.token}\nExpires: ${enrollment.expiresAt}\n`,
  );
}

if (process.argv[1]?.endsWith("vpn-node-bootstrap.js")) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "VPN node bootstrap failed"}\n`);
    process.exitCode = 1;
  }).finally(() => pool.end());
}
