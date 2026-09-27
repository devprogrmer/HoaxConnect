const { spawn } = require("child_process");
const https = require("https");
const dns = require("dns");
const net = require("net");
const os = require("os");

function validateHost(value) {
  if (typeof value !== "string") {
    throw new Error("Target must be a string");
  }

  const host = value.trim();

  if (!host || host.length > 253) {
    throw new Error("Invalid target");
  }

  if (!/^[a-zA-Z0-9._:-]+$/.test(host)) {
    throw new Error("Invalid target characters");
  }

  return host;
}

function clampCount(value) {
  const count = Number(value || 6);

  if (!Number.isFinite(count)) return 6;

  return Math.max(1, Math.min(20, Math.trunc(count)));
}

function runProcess(command, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;

      finished = true;
      child.kill();

      reject(new Error(`${command} timed out`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}

function parseRTTs(output) {
  const values = [];

  for (const line of String(output).split(/\r?\n/)) {
    const isReply =
      /TTL[=\s]/i.test(line) ||
      /bytes from/i.test(line);

    if (!isReply) {
      continue;
    }

    let match = line.match(
      /(?:time|zeit|temps|tempo|süre|время|زمان)?\s*[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/i
    );

    if (!match) {
      match = line.match(/(\d+(?:[.,]\d+)?)\s*ms/i);
    }

    if (!match) {
      continue;
    }

    const value = Number(match[1].replace(",", "."));

    if (Number.isFinite(value)) {
      values.push(value);
    }
  }

  return values;
}

function average(values) {
  if (!values.length) return null;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateJitter(values) {
  if (values.length < 2) return 0;

  const differences = [];

  for (let index = 1; index < values.length; index++) {
    differences.push(
      Math.abs(values[index] - values[index - 1])
    );
  }

  return average(differences) || 0;
}

function round(value, digits = 1) {
  if (value === null || value === undefined) {
    return null;
  }

  const multiplier = 10 ** digits;

  return Math.round(value * multiplier) / multiplier;
}

async function pingHost(inputHost, inputCount = 6) {
  const host = validateHost(inputHost);
  const count = clampCount(inputCount);

  let command;
  let args;

  if (process.platform === "win32") {
    command = "ping.exe";

    args = [
      "-n",
      String(count),
      "-w",
      "1200",
      host,
    ];
  } else {
    command = "ping";

    args = [
      "-c",
      String(count),
      "-W",
      "2",
      host,
    ];
  }

  let execution;

  try {
    execution = await runProcess(
      command,
      args,
      Math.max(12000, count * 2500)
    );
  } catch (error) {
    throw new Error(
      `Ping failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const rtts = parseRTTs(execution.stdout);

  const sent = count;
  const received = Math.min(rtts.length, sent);
  const lost = Math.max(0, sent - received);

  const packetLossPct =
    sent > 0 ? (lost / sent) * 100 : 100;

  const avg = average(rtts);

  return {
    target: host,

    sent,
    received,
    lost,

    packetLossPct: round(packetLossPct, 1),

    minMs:
      rtts.length > 0
        ? round(Math.min(...rtts), 1)
        : null,

    maxMs:
      rtts.length > 0
        ? round(Math.max(...rtts), 1)
        : null,

    averageMs:
      avg !== null
        ? round(avg, 1)
        : null,

    jitterMs: round(
      calculateJitter(rtts),
      1
    ),

    samples: rtts.map((value) => round(value, 1)),

    reachable: received > 0,
  };
}

function requestText(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "HoaxConnect/0.1",
          Accept: "*/*",
        },
      },
      (response) => {
        let data = "";

        response.setEncoding("utf8");

        response.on("data", (chunk) => {
          data += chunk;
        });

        response.on("end", () => {
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(
              new Error(
                `HTTP ${response.statusCode || "unknown"}`
              )
            );

            return;
          }

          resolve(data.trim());
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new Error("Request timed out")
      );
    });

    request.on("error", reject);
  });
}

async function getPublicIP() {
  const providers = [
    async () => {
      const body = await requestText(
        "https://api.ipify.org?format=json"
      );

      const parsed = JSON.parse(body);

      return parsed.ip;
    },

    async () => {
      return await requestText(
        "https://ifconfig.me/ip"
      );
    },

    async () => {
      return await requestText(
        "https://icanhazip.com"
      );
    },
  ];

  let lastError = null;

  for (const provider of providers) {
    try {
      const ip = String(await provider()).trim();

      if (ip) {
        return ip;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Unable to detect public IP${
      lastError instanceof Error
        ? `: ${lastError.message}`
        : ""
    }`
  );
}

function getDNSServers() {
  try {
    return dns.getServers();
  } catch {
    return [];
  }
}

async function tcpProbe(inputHost, inputPort, timeoutMs = 2500) {
  const host = validateHost(inputHost);
  const port = Number(inputPort);

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("Invalid TCP port");
  }

  return new Promise((resolve) => {
    const started = process.hrtime.bigint();

    const socket = net.createConnection({
      host,
      port,
    });

    let finished = false;

    function finish(success, error = null) {
      if (finished) return;

      finished = true;

      const elapsedNs =
        process.hrtime.bigint() - started;

      const latencyMs =
        Number(elapsedNs) / 1_000_000;

      socket.destroy();

      resolve({
        target: host,
        port,
        reachable: success,
        latencyMs: round(latencyMs, 1),
        error,
      });
    }

    socket.setTimeout(timeoutMs);

    socket.once("connect", () => {
      finish(true);
    });

    socket.once("timeout", () => {
      finish(false, "timeout");
    });

    socket.once("error", (error) => {
      finish(false, error.code || error.message);
    });
  });
}

async function traceroute(inputHost) {
  const host = validateHost(inputHost);

  let command;
  let args;

  if (process.platform === "win32") {
    command = "tracert.exe";

    args = [
      "-d",
      "-h",
      "20",
      "-w",
      "1200",
      host,
    ];
  } else {
    command = "traceroute";

    args = [
      "-n",
      "-m",
      "20",
      "-w",
      "2",
      host,
    ];
  }

  const result = await runProcess(
    command,
    args,
    35000
  );

  return {
    target: host,
    raw: result.stdout,
    lines: result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 50),
  };
}

async function runDiagnostic(target = "1.1.1.1") {
  const ping = await pingHost(target, 8);

  let publicIp = null;
  let publicIpError = null;

  try {
    publicIp = await getPublicIP();
  } catch (error) {
    publicIpError =
      error instanceof Error
        ? error.message
        : String(error);
  }

  return {
    target,
    ping,
    publicIp,
    publicIpError,

    dnsServers: getDNSServers(),

    system: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
    },

    testedAt: new Date().toISOString(),
  };
}

module.exports = {
  pingHost,
  getPublicIP,
  getDNSServers,
  tcpProbe,
  traceroute,
  runDiagnostic,
};
