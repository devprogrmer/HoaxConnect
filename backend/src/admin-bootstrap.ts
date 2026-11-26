import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { z } from "zod";

import { pool } from "./db.js";
import { hashPassword } from "./security.js";

const emailSchema = z.string().email().max(320);
const passwordSchema = z.string().min(16).max(128);
const bootstrapLockName = "hoaxconnect_admin_first_superadmin";

export async function bootstrapFirstSuperadmin(
  emailInput: string,
  password: string,
): Promise<{ id: string; email: string; role: "superadmin" }> {
  const email = emailSchema.parse(emailInput.trim());
  const emailNormalized = email.toLowerCase();
  passwordSchema.parse(password);
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [bootstrapLockName],
    );

    const existing = await client.query(
      `SELECT id FROM admin_accounts
       WHERE role = 'superadmin'
       LIMIT 1`,
    );

    if (existing.rowCount) {
      throw new Error("The one-time Admin bootstrap has already been used");
    }

    const inserted = await client.query<{
      id: string;
      email: string;
    }>(
      `INSERT INTO admin_accounts (
         email,
         email_normalized,
         password_hash,
         role
       ) VALUES ($1, $2, $3, 'superadmin')
       RETURNING id, email`,
      [email, emailNormalized, passwordHash],
    );
    const admin = inserted.rows[0];

    if (!admin) {
      throw new Error("The first superadmin could not be created");
    }

    await client.query(
      `INSERT INTO admin_audit_logs (
         admin_id,
         admin_email,
         admin_role,
         action,
         resource_type,
         resource_id,
         request_id,
         metadata
       ) VALUES ($1, $2, 'superadmin', 'admin.bootstrap',
                 'admin_account', $5, $3, $4::jsonb)`,
      [
        admin.id,
        admin.email,
        randomUUID(),
        JSON.stringify({ source: "local_one_time_bootstrap" }),
        admin.id,
      ],
    );

    await client.query("COMMIT");

    return {
      id: admin.id,
      email: admin.email,
      role: "superadmin",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;

  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(
      new Error("Run the one-time bootstrap in an interactive terminal"),
    );
  }

  return new Promise((resolveValue, reject) => {
    const wasRaw = input.isRaw;
    let value = "";

    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolveValue(value);
    };

    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          finish(new Error("Bootstrap cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " " && character !== "\u007f") {
          value += character;
        }
      }
    };

    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function runInteractiveBootstrap(): Promise<void> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const email = (await prompt.question("First superadmin email: ")).trim();
    prompt.close();
    const password = await readHidden("Password (16+ characters): ");
    const confirmation = await readHidden("Confirm password: ");

    if (password !== confirmation) {
      throw new Error("Passwords do not match");
    }

    const admin = await bootstrapFirstSuperadmin(email, password);
    process.stdout.write(
      `Created the one-time superadmin ${admin.email}.\n`,
    );
  } finally {
    prompt.close();
    await pool.end();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";

if (invokedPath === import.meta.url) {
  runInteractiveBootstrap().catch((error: unknown) => {
    const message = error instanceof Error
      ? error.message
      : "Admin bootstrap failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
