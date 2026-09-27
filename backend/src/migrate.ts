import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { config } from "./config.js";

const { Client } = pg;
const migrationsDirectory = path.resolve(process.cwd(), "migrations");
const lockName = "hoaxconnect_schema_migrations";

async function migrate(): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl
      ? { rejectUnauthorized: true }
      : false
  });

  await client.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockName]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
      .sort();

    for (const file of files) {
      const sql = await readFile(
        path.join(migrationsDirectory, file),
        "utf8"
      );

      const checksum = createHash("sha256")
        .update(sql)
        .digest("hex");

      const existing = await client.query<{
        checksum: string;
      }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [file]
      );

      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${file}`
          );
        }

        console.log(`Migration already applied: ${file}`);
        continue;
      }

      await client.query("BEGIN");

      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (version, checksum)
           VALUES ($1, $2)`,
          [file, checksum]
        );
        await client.query("COMMIT");
        console.log(`Migration applied: ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext($1))",
      [lockName]
    ).catch(() => undefined);

    await client.end();
  }
}

await migrate();
