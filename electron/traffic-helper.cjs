const {
  app,
} = require("electron");

const fs = require("fs");
const path = require("path");

const {
  spawn,
} = require("child_process");

const readline =
  require("readline");

let child = null;

let stopping = false;
let restartNotBefore = 0;

let latest = {
  status: "starting",
  collectedAt: null,
  processes: [],
};

let health = {
  available: false,
  avgPingMs: null,
  jitterMs: null,
  packetLossPct: null,
  checkedAt: null,
};

let healthTimer = null;

const GAME_NAMES =
  new Set([
    "dota2.exe",
    "cs2.exe",
    "valorant-win64-shipping.exe",
    "fortniteclient-win64-shipping.exe",
    "tslgame.exe",
    "r5apex.exe",
    "gta5.exe",
    "fivem.exe",
  ]);

const CRITICAL_NAMES =
  new Set([
    "idle",
    "system",
    "registry",
    "memory compression",
    "secure system",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "svchost.exe",
    "fontdrvhost.exe",
    "dwm.exe",
    "explorer.exe",
    "hoaxconnect.exe",
    "hoaxtraffic.exe",
  ]);

function logPath() {
  return path.join(
    app.getPath("userData"),
    "traffic-helper.log"
  );
}

function log(message) {
  try {
    fs.appendFileSync(
      logPath(),
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8"
    );
  } catch {}
}

function helperPath() {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "traffic",
      "HoaxTraffic.exe"
    );
  }

  return path.join(
    __dirname,
    "..",
    "native-bin",
    "HoaxTraffic.exe"
  );
}

function wait(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

function runExe(
  executable,
  args,
  timeoutMs = 15000
) {
  return new Promise(
    (resolve, reject) => {
      const proc =
        spawn(
          executable,
          args,
          {
            windowsHide: true,
            shell: false,
          }
        );

      let stdout = "";
      let stderr = "";
      let done = false;

      const timeout =
        setTimeout(
          () => {
            if (done) return;

            done = true;

            try {
              proc.kill();
            } catch {}

            reject(
              new Error(
                "Command timed out."
              )
            );
          },
          timeoutMs
        );

      proc.stdout?.on(
        "data",
        data => {
          stdout +=
            data.toString();
        }
      );

      proc.stderr?.on(
        "data",
        data => {
          stderr +=
            data.toString();
        }
      );

      proc.once(
        "error",
        error => {
          if (done) return;

          done = true;

          clearTimeout(timeout);

          reject(error);
        }
      );

      proc.once(
        "close",
        code => {
          if (done) return;

          done = true;

          clearTimeout(timeout);

          resolve({
            code,
            stdout,
            stderr,
          });
        }
      );
    }
  );
}

async function probeHealth() {
  if (
    process.platform !== "win32"
  ) {
    return {
      available: false,
      avgPingMs: null,
      jitterMs: null,
      packetLossPct: null,
      checkedAt:
        new Date().toISOString(),
    };
  }

  try {
    const result =
      await runExe(
        "ping.exe",
        [
          "-n",
          "5",
          "-w",
          "1000",
          "1.1.1.1",
        ],
        9000
      );

    const text =
      `${result.stdout}\n${result.stderr}`;

    const times = [];

    const regex =
      /[=<]\s*(\d+)\s*ms/gi;

    let match;

    while (
      (
        match =
          regex.exec(text)
      )
    ) {
      times.push(
        Number(match[1])
      );
    }

    if (!times.length) {
      return {
        available: false,

        avgPingMs: null,
        jitterMs: null,

        packetLossPct: 100,

        checkedAt:
          new Date().toISOString(),
      };
    }

    const avg =
      times.reduce(
        (a, b) => a + b,
        0
      )
      /
      times.length;

    const diffs = [];

    for (
      let i = 1;
      i < times.length;
      i++
    ) {
      diffs.push(
        Math.abs(
          times[i] -
          times[i - 1]
        )
      );
    }

    const jitter =
      diffs.length
        ? diffs.reduce(
            (a, b) => a + b,
            0
          )
          /
          diffs.length
        : 0;

    const loss =
      (
        (
          5 -
          Math.min(
            times.length,
            5
          )
        )
        /
        5
      )
      *
      100;

    return {
      available: true,

      avgPingMs:
        Math.round(
          avg * 10
        ) / 10,

      jitterMs:
        Math.round(
          jitter * 10
        ) / 10,

      packetLossPct:
        Math.round(
          loss * 10
        ) / 10,

      checkedAt:
        new Date().toISOString(),
    };
  } catch (error) {
    log(
      `Health probe failed: ${error.message}`
    );

    return {
      available: false,
      avgPingMs: null,
      jitterMs: null,
      packetLossPct: null,
      checkedAt:
        new Date().toISOString(),
    };
  }
}

async function refreshHealth() {
  health =
    await probeHealth();
}

function startHealthLoop() {
  if (healthTimer) {
    return;
  }

  refreshHealth();

  healthTimer =
    setInterval(
      refreshHealth,
      10000
    );

  healthTimer.unref?.();
}

function startTrafficHelper() {
  if (
    process.platform !== "win32"
  ) {
    latest = {
      status: "unsupported",
      error:
        "Traffic monitoring requires Windows.",
      collectedAt: null,
      processes: [],
    };

    return;
  }

  if (
    stopping ||
    Date.now() <
      restartNotBefore
  ) {
    return;
  }

  if (
    child &&
    !child.killed
  ) {
    return;
  }

  const exe =
    helperPath();

  if (
    !fs.existsSync(exe)
  ) {
    latest = {
      status: "error",

      error:
        `Traffic helper not found: ${exe}`,

      collectedAt: null,
      processes: [],
    };

    restartNotBefore =
      Date.now() + 30000;

    log(
      latest.error
    );

    return;
  }

  log(
    `Starting helper: ${exe}`
  );

  latest = {
    status: "starting",
    error: null,
    collectedAt: null,
    processes: [],
  };

  child =
    spawn(
      exe,
      [],
      {
        windowsHide: true,
        shell: false,

        stdio: [
          "pipe",
          "pipe",
          "pipe",
        ],
      }
    );

  const startedChild =
    child;

  const rl =
    readline.createInterface({
      input:
        child.stdout,
    });

  rl.on(
    "line",
    line => {
      const trimmed =
        String(line || "")
          .trim();

      if (!trimmed) {
        return;
      }

      try {
        const value =
          JSON.parse(trimmed);

        if (
          value &&
          Array.isArray(
            value.processes
          )
        ) {
          latest = value;

          restartNotBefore =
            0;
        }
      } catch (error) {
        log(
          `Bad helper JSON: ${trimmed}`
        );
      }
    }
  );

  child.stderr?.on(
    "data",
    data => {
      log(
        `helper stderr: ${data.toString().trim()}`
      );
    }
  );

  child.once(
    "error",
    error => {
      latest = {
        status: "error",

        error:
          error.message,

        collectedAt: null,
        processes: [],
      };

      restartNotBefore =
        Date.now() + 5000;

      log(
        `helper error: ${error.stack || error}`
      );
    }
  );

  child.once(
    "exit",
    code => {
      log(
        `helper exited code=${code}`
      );

      if (
        child ===
        startedChild
      ) {
        child = null;
      }

      if (stopping) {
        latest = {
          ...latest,

          status: "stopped",
          error: null,
        };

        return;
      }

      restartNotBefore =
        Date.now() + 5000;

      latest = {
        ...latest,

        status: "error",

        error:
          `Traffic helper exited unexpectedly with code ${code}. Retrying shortly.`,
      };
    }
  );

  startHealthLoop();
}

function toMbps(bytesPerSecond) {
  return (
    Number(
      bytesPerSecond || 0
    )
    *
    8
    /
    1000000
  );
}

function normalizeName(name) {
  return String(
    name || ""
  )
    .trim()
    .toLowerCase();
}

function isGameProcess(name) {
  return GAME_NAMES.has(
    normalizeName(name)
  );
}

function canEndProcess(
  pid,
  name
) {
  if (
    !Number.isInteger(pid) ||
    pid <= 4
  ) {
    return false;
  }

  return !CRITICAL_NAMES.has(
    normalizeName(name)
  );
}

function analyzeProcess(
  item,
  totals
) {
  const rxMbps =
    toMbps(
      item.rxBps
    );

  const txMbps =
    toMbps(
      item.txBps
    );

  const tcpRxMbps =
    toMbps(
      item.tcpRxBps
    );

  const tcpTxMbps =
    toMbps(
      item.tcpTxBps
    );

  const udpRxMbps =
    toMbps(
      item.udpRxBps
    );

  const udpTxMbps =
    toMbps(
      item.udpTxBps
    );

  const totalMbps =
    rxMbps + txMbps;

  const overall =
    totals.rxMbps +
    totals.txMbps;

  const sharePct =
    overall > 0
      ? (
          totalMbps /
          overall
        )
        *
        100
      : 0;

  const rxShare =
    totals.rxMbps > 0
      ? (
          rxMbps /
          totals.rxMbps
        )
        *
        100
      : 0;

  const txShare =
    totals.txMbps > 0
      ? (
          txMbps /
          totals.txMbps
        )
        *
        100
      : 0;

  const game =
    isGameProcess(
      item.name
    );

  const badPing =
    health.available &&
    Number(
      health.avgPingMs
    ) >= 75;

  const badJitter =
    health.available &&
    Number(
      health.jitterMs
    ) >= 15;

  const hasLoss =
    health.available &&
    Number(
      health.packetLossPct
    ) >= 1;

  let score = 0;

  if (
    rxMbps >= 20 ||
    rxShare >= 50
  ) {
    score += 3;
  } else if (
    rxMbps >= 5 ||
    rxShare >= 30
  ) {
    score += 2;
  } else if (
    rxMbps >= 1
  ) {
    score += 1;
  }

  if (
    txMbps >= 5 ||
    txShare >= 50
  ) {
    score += 4;
  } else if (
    txMbps >= 1.5 ||
    txShare >= 30
  ) {
    score += 3;
  } else if (
    txMbps >= 0.5
  ) {
    score += 1;
  }

  if (
    sharePct >= 60
  ) {
    score += 2;
  } else if (
    sharePct >= 35
  ) {
    score += 1;
  }

  if (
    badPing &&
    totalMbps >= 1
  ) {
    score += 2;
  }

  if (
    (
      badJitter ||
      hasLoss
    )
    &&
    totalMbps >= 0.5
  ) {
    score += 2;
  }

  let impactLevel =
    "low";

  if (score >= 6) {
    impactLevel =
      "high";
  } else if (
    score >= 3
  ) {
    impactLevel =
      "medium";
  }

  let verdict;
  let reason;

  if (game) {
    verdict =
      "KEEP RUNNING";

    reason =
      "This appears to be an active game process. Closing it would end or interrupt the game.";
  } else if (
    impactLevel === "high" &&
    (
      badPing ||
      badJitter ||
      hasLoss
    )
  ) {
    verdict =
      "LIKELY TO HELP";

    reason =
      "This process is using a large share of current bandwidth while network latency or stability is degraded.";
  } else if (
    impactLevel === "high"
  ) {
    verdict =
      "FREES BANDWIDTH";

    reason =
      "This process is a major current bandwidth user, although latency is currently healthy.";
  } else if (
    impactLevel === "medium" &&
    (
      badPing ||
      badJitter ||
      hasLoss
    )
  ) {
    verdict =
      "MAY HELP";

    reason =
      "This process has noticeable traffic and may be contributing to current latency.";
  } else {
    verdict =
      "UNLIKELY TO HELP";

    reason =
      "Current traffic from this process is too low to strongly explain the network issue.";
  }

  return {
    pid:
      Number(item.pid),

    name:
      String(
        item.name || ""
      ),

    path:
      String(
        item.path || ""
      ),

    rxMbps,
    txMbps,

    tcpRxMbps,
    tcpTxMbps,

    udpRxMbps,
    udpTxMbps,

    rxTotal:
      Number(
        item.rxTotal || 0
      ),

    txTotal:
      Number(
        item.txTotal || 0
      ),

    bandwidthSharePct:
      Math.round(
        sharePct * 10
      ) / 10,

    downloadSharePct:
      Math.round(
        rxShare * 10
      ) / 10,

    uploadSharePct:
      Math.round(
        txShare * 10
      ) / 10,

    impactLevel,
    verdict,
    reason,

    isGame:
      game,

    canEnd:
      canEndProcess(
        Number(item.pid),
        item.name
      ),
  };
}

async function getDoctorSnapshot() {
  startTrafficHelper();

  const raw =
    latest;

  const processes =
    Array.isArray(
      raw.processes
    )
      ? raw.processes
      : [];

  const totals =
    processes.reduce(
      (acc, item) => {
        acc.rxMbps +=
          toMbps(
            item.rxBps
          );

        acc.txMbps +=
          toMbps(
            item.txBps
          );

        return acc;
      },
      {
        rxMbps: 0,
        txMbps: 0,
      }
    );

  const analyzed =
    processes
      .map(
        item =>
          analyzeProcess(
            item,
            totals
          )
      )
      .sort(
        (a, b) =>
          (
            b.rxMbps +
            b.txMbps
          )
          -
          (
            a.rxMbps +
            a.txMbps
          )
      );

  return {
    status:
      raw.status ||
      "starting",

    error:
      raw.error ||
      null,

    collectedAt:
      raw.collectedAt ||
      null,

    health,

    totalRxMbps:
      totals.rxMbps,

    totalTxMbps:
      totals.txMbps,

    processes:
      analyzed,
  };
}

async function endProcessAndMeasure(
  pid
) {
  startTrafficHelper();

  const numericPid =
    Number(pid);

  const item =
    (
      latest.processes ||
      []
    ).find(
      process =>
        Number(
          process.pid
        )
        ===
        numericPid
    );

  if (!item) {
    throw new Error(
      "Process is no longer available."
    );
  }

  if (
    !canEndProcess(
      numericPid,
      item.name
    )
  ) {
    throw new Error(
      "HoaxConnect blocked termination of this system-critical process."
    );
  }

  const before =
    await probeHealth();

  const kill =
    await runExe(
      "taskkill.exe",
      [
        "/PID",
        String(
          numericPid
        ),
        "/T",
        "/F",
      ],
      10000
    );

  if (
    kill.code !== 0
  ) {
    throw new Error(
      kill.stderr.trim() ||
      kill.stdout.trim() ||
      "Unable to end process."
    );
  }

  await wait(2500);

  const after =
    await probeHealth();

  health = after;

  let pingImprovementMs =
    null;

  let jitterImprovementMs =
    null;

  let lossImprovementPct =
    null;

  if (
    before.available &&
    after.available
  ) {
    pingImprovementMs =
      Number(
        (
          before.avgPingMs -
          after.avgPingMs
        ).toFixed(1)
      );

    jitterImprovementMs =
      Number(
        (
          before.jitterMs -
          after.jitterMs
        ).toFixed(1)
      );

    lossImprovementPct =
      Number(
        (
          before.packetLossPct -
          after.packetLossPct
        ).toFixed(1)
      );
  }

  const improved =
    (
      pingImprovementMs !== null &&
      pingImprovementMs >= 5
    )
    ||
    (
      jitterImprovementMs !== null &&
      jitterImprovementMs >= 3
    )
    ||
    (
      lossImprovementPct !== null &&
      lossImprovementPct >= 1
    );

  return {
    success: true,

    pid:
      numericPid,

    processName:
      item.name,

    before,
    after,

    pingImprovementMs,
    jitterImprovementMs,
    lossImprovementPct,

    improved,
  };
}

function stopTrafficHelper() {
  stopping = true;

  if (healthTimer) {
    clearInterval(
      healthTimer
    );

    healthTimer = null;
  }

  if (!child) {
    return;
  }

  try {
    child.stdin?.write(
      "stop\n"
    );

    child.stdin?.end();
  } catch {}

  const current =
    child;

  setTimeout(
    () => {
      try {
        if (
          current &&
          !current.killed
        ) {
          current.kill();
        }
      } catch {}
    },
    1500
  ).unref?.();

  child = null;
}

module.exports = {
  startTrafficHelper,
  getDoctorSnapshot,
  endProcessAndMeasure,
  stopTrafficHelper,
};
