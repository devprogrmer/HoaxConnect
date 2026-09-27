import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ClientHttpError = Error & {
  statusCode: number;
  code?: string;
};

function isClientHttpError(
  error: unknown
): error is ClientHttpError {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as Error & {
    statusCode?: unknown;
  };

  return (
    typeof candidate.statusCode === "number" &&
    candidate.statusCode >= 400 &&
    candidate.statusCode < 500
  );
}

export function installErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "The requested endpoint does not exist.",
        request_id: request.id
      }
    });
  });

  app.setErrorHandler((error, request, reply) => {
    let statusCode = 500;
    let code = "INTERNAL_ERROR";
    let message = "An unexpected server error occurred.";

    if (error instanceof ApiError) {
      statusCode = error.statusCode;
      code = error.code;
      message = error.message;
    } else if (error instanceof ZodError) {
      statusCode = 400;
      code = "VALIDATION_ERROR";
      message = error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
    } else if (isClientHttpError(error)) {
      statusCode = error.statusCode;

      if (error.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
        code = "INVALID_REQUEST_BODY";
      } else if (statusCode === 429) {
        code = "RATE_LIMITED";
      } else {
        code = "BAD_REQUEST";
      }

      message = error.message;
    } else {
      request.log.error({ err: error }, "Unhandled request error");
    }

    reply.status(statusCode).send({
      error: {
        code,
        message,
        request_id: request.id
      }
    });
  });
}
