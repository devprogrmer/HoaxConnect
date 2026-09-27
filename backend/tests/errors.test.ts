import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { installErrorHandlers } from "../src/errors.js";

test(
  "preserves Fastify client errors in the standard error envelope",
  async (context) => {
    const app = Fastify({
      genReqId: () => "00000000-0000-4000-8000-000000000001",
      logger: false
    });

    installErrorHandlers(app);

    app.post("/empty-json", async () => ({
      accepted: true
    }));

    context.after(async () => {
      await app.close();
    });

    const response = await app.inject({
      method: "POST",
      url: "/empty-json",
      headers: {
        "content-type": "application/json"
      },
      payload: ""
    });

    const body = JSON.parse(response.body) as {
      error: {
        code: string;
        message: string;
        request_id: string;
      };
    };

    assert.equal(response.statusCode, 400);
    assert.equal(body.error.code, "INVALID_REQUEST_BODY");
    assert.equal(
      body.error.request_id,
      "00000000-0000-4000-8000-000000000001"
    );
    assert.ok(body.error.message.length > 0);
  }
);
