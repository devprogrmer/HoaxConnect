export type PathSamples = { id: string; samples: readonly (number | null)[] };
export type PathScore = {
  id: string; lossPercent: number; rttMs: number; jitterMs: number;
  p95Ms: number; score: number; healthy: boolean;
};

export function scorePath(reading: PathSamples): PathScore {
  if (!reading.samples.length || reading.samples.length > 20) {
    throw new Error("Path measurement needs 1 to 20 samples");
  }
  const received = reading.samples.filter((sample): sample is number => sample !== null);
  if (received.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("Invalid path latency sample");
  }
  const sorted = [...received].sort((a, b) => a - b);
  const lossPercent = 100 * (reading.samples.length - received.length) / reading.samples.length;
  const rttMs = received.length ? received.reduce((a, b) => a + b, 0) / received.length : Infinity;
  const p95Ms = sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : Infinity;
  const jitterMs = received.length > 1
    ? received.slice(1).reduce((sum, sample, i) => sum + Math.abs(sample - received[i]!), 0) / (received.length - 1)
    : 0;
  return { id: reading.id, lossPercent, rttMs, jitterMs, p95Ms,
    score: rttMs + jitterMs * 2 + p95Ms * 0.25 + lossPercent * 10,
    healthy: lossPercent < 20 && Number.isFinite(rttMs) };
}

export class MultiPathSelector {
  private active: string;
  private candidate: string | null = null;
  private candidateRounds = 0;
  private lastSwitchAt = -Infinity;

  constructor(private readonly options: {
    paths: readonly string[];
    apply: (path: string) => Promise<void>;
    now?: () => number;
    stableRounds?: number;
    cooldownMs?: number;
    improvementFraction?: number;
    initialPath?: string;
  }) {
    if (options.paths.length < 2 || new Set(options.paths).size !== options.paths.length ||
        options.paths.some((path) => !path)) throw new Error("Configure distinct paths");
    if (options.initialPath && !options.paths.includes(options.initialPath)) throw new Error("Unknown initial path");
    this.active = options.initialPath ?? options.paths[0]!;
  }

  get activePath() { return this.active; }

  async observe(readings: readonly PathSamples[]): Promise<{ path: string; scores: PathScore[]; reason: string }> {
    if (readings.length !== this.options.paths.length ||
        new Set(readings.map((r) => r.id)).size !== readings.length ||
        readings.some((r) => !this.options.paths.includes(r.id))) {
      throw new Error("Readings must cover each configured path exactly once");
    }
    const scores = readings.map(scorePath);
    const current = scores.find((score) => score.id === this.active)!;
    const healthy = scores.filter((score) => score.healthy);
    // Keep the current route when every probe path is impaired: switching blind can amplify an outage.
    if (!healthy.length) { this.candidate = null; this.candidateRounds = 0; return { path: this.active, scores, reason: "all_degraded" }; }
    const best = healthy.reduce((a, b) => b.score < a.score ? b : a);
    const improvement = this.options.improvementFraction ?? 0.15;
    const worthwhile = !current.healthy || best.score < current.score * (1 - improvement);
    if (best.id === this.active || !worthwhile) {
      this.candidate = null; this.candidateRounds = 0;
      return { path: this.active, scores, reason: "held" };
    }
    if (this.candidate === best.id) this.candidateRounds += 1;
    else { this.candidate = best.id; this.candidateRounds = 1; }
    const now = (this.options.now ?? Date.now)();
    if (this.candidateRounds < (this.options.stableRounds ?? 2) ||
        now - this.lastSwitchAt < (this.options.cooldownMs ?? 2000)) {
      return { path: this.active, scores, reason: "hysteresis" };
    }
    // Commit only after route replacement succeeds, so a failed kernel update is retried.
    await this.options.apply(best.id);
    this.active = best.id;
    this.lastSwitchAt = now;
    this.candidate = null;
    this.candidateRounds = 0;
    return { path: this.active, scores, reason: "selected" };
  }
}
