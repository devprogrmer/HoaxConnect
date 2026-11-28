"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { summarizeRoute, rankMeasuredRoutes } = require("../route-quality.cjs");

test("summarizes median RTT, consecutive RTT variation and unanswered probes", () => {
  assert.deepEqual(summarizeRoute([20, null, 30, 40]), {
    latencyMs: 30, jitterMs: 10, lossPercent: 25,
  });
  assert.equal(summarizeRoute([null, 30, null]), null);
  assert.equal(summarizeRoute([20, -1, 30]), null);
});

test("prefers stable routes and excludes stale, future and ineligible observations", () => {
  const now = 60_000;
  const nodes = ["fast", "stable", "stale", "future"].map((id) => ({ id }));
  const observations = [
    { nodeId: "fast", measuredAt: now, samples: [10, null, 11, 12] },
    { nodeId: "stable", measuredAt: now, samples: [32, 33, 34, 33] },
    { nodeId: "stale", measuredAt: 0, samples: [1, 1, 1] },
    { nodeId: "future", measuredAt: now + 1, samples: [1, 1, 1] },
    { nodeId: "other", measuredAt: now, samples: [1, 1, 1] },
  ];
  assert.deepEqual(rankMeasuredRoutes(nodes, observations, now).map((item) => item.nodeId),
    ["stable", "fast"]);
});
