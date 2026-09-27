import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase } from "./db.js";

const app = await buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Shutting down");

  await app.close();
  await closeDatabase();

  process.exit(0);
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

try {
  await app.listen({
    host: config.host,
    port: config.port
  });
} catch (error) {
  app.log.fatal({ err: error }, "Backend startup failed");
  await closeDatabase();
  process.exit(1);
}
