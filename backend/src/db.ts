import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 15,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: config.databaseSsl
    ? { rejectUnauthorized: true }
    : false
});

pool.on("error", (error) => {
  console.error(JSON.stringify({
    level: "error",
    event: "postgres_pool_error",
    message: error.message
  }));
});

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
