type Path = "primary" | "relay";

export interface PathReading {
  lossPercent: number;
}

export class PathFailover {
  private active: Path = "primary";
  private unhealthyRounds = 0;
  private recoveryRounds = 0;

  constructor(
    private readonly apply: (path: Path) => Promise<void>,
    initialPath: Path = "primary",
  ) {
    this.active = initialPath;
  }

  // The caller serializes rounds so that probes and route updates never overlap.
  async observe(primary: PathReading, relay: PathReading): Promise<Path> {
    const primaryDegraded = primary.lossPercent >= 20;
    const relayHealthy = relay.lossPercent < 20;
    this.unhealthyRounds = primaryDegraded ? Math.min(this.unhealthyRounds + 1, 2) : 0;
    this.recoveryRounds = !primaryDegraded ? Math.min(this.recoveryRounds + 1, 5) : 0;

    let target = this.active;
    if (this.active === "primary" && this.unhealthyRounds >= 2 && relayHealthy) {
      target = "relay";
    } else if (this.active === "relay" &&
      (this.recoveryRounds >= 5 || (!relayHealthy && !primaryDegraded))) {
      target = "primary";
    }

    if (target !== this.active) {
      await this.apply(target);
      this.active = target;
      this.unhealthyRounds = 0;
      this.recoveryRounds = 0;
    }
    return this.active;
  }
}
