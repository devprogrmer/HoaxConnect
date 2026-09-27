import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";

import { registerAuthRoutes } from "./auth.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { ApiError, installErrorHandlers } from "./errors.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function buildApp() {
  const app = Fastify({
    trustProxy: "127.0.0.1",
    genReqId(request) {
      const incoming = request.headers["x-request-id"];

      return (
        typeof incoming === "string" &&
        uuidPattern.test(incoming)
      )
        ? incoming
        : randomUUID();
    },
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.body.password",
          "req.body.refresh_token",
          "res.headers.set-cookie"
        ],
        censor: "[REDACTED]"
      }
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: false
  });

  await app.register(cors, {
    credentials: false,
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      callback(
        null,
        config.corsAllowedOrigins.has(origin)
      );
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute"
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  installErrorHandlers(app);

  app.get("/api/v1/health/live", async () => ({
    status: "live",
    service: "hoaxconnect-backend"
  }));

  app.get("/api/v1/health/ready", async () => {
    try {
      await pool.query("SELECT 1");
    } catch {
      throw new ApiError(
        503,
        "DATABASE_NOT_READY",
        "PostgreSQL is not ready."
      );
    }

    return {
      status: "ready",
      service: "hoaxconnect-backend",
      database: "ready"
    };
  });

  await registerAuthRoutes(app);

  return app;
}
