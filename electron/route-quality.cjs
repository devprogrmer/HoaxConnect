"use strict";

function summarizeRoute(samples) {
  if (!Array.isArray(samples) || samples.length < 3 ||
      !samples.every((value) => value === null || (Number.isFinite(value) && value >= 0))) {
    return null;
  }
  const received = samples.filter((value) => value !== null);
  if (received.length < 2) return null;
  const sorted = [...received].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const latencyMs = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  const variation = received.slice(1).reduce(
    (sum, value, index) => sum + Math.abs(value - received[index]),
    0,
  );
  return {
    latencyMs,
    jitterMs: variation / (received.length - 1),
    lossPercent: 100 * (samples.length - received.length) / samples.length,
  };
}

function rankMeasuredRoutes(eligibleNodes, observations, nowMs) {
  const byNode = new Map();
  for (const observation of observations) {
    const age = nowMs - observation.measuredAt;
    if (!Number.isFinite(age) || age < 0 || age > 30_000) continue;
    const previous = byNode.get(observation.nodeId);
    if (!previous || previous.measuredAt < observation.measuredAt) {
      byNode.set(observation.nodeId, observation);
    }
  }
  const ranked = [];
  for (const node of eligibleNodes) {
    const metrics = summarizeRoute(byNode.get(node.id)?.samples);
    if (!metrics) continue;
    // Convert each percentage point of probe loss to 10 ms of ranking penalty.
    const score = metrics.latencyMs + 2 * metrics.jitterMs + 10 * metrics.lossPercent;
    ranked.push({ nodeId: node.id, ...metrics, score });
  }
  return ranked.sort((left, right) => left.score - right.score);
}

module.exports = { summarizeRoute, rankMeasuredRoutes };
