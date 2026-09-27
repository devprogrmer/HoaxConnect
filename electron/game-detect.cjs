const { spawn } = require("child_process");
const net = require("net");

const GAME_CATALOG = [
  {
    id: "dota2",
    name: "Dota 2",
    processes: [/^dota2\.exe$/i],
  },
  {
    id: "cs2",
    name: "Counter-Strike 2",
    processes: [/^cs2\.exe$/i],
  },
  {
    id: "valorant",
    name: "Valorant",
    processes: [/^VALORANT-Win64-Shipping\.exe$/i],
  },
  {
    id: "fortnite",
    name: "Fortnite",
    processes: [/^FortniteClient-Win64-Shipping\.exe$/i],
  },
  {
    id: "pubg",
    name: "PUBG",
    processes: [/^TslGame\.exe$/i],
  },
  {
    id: "fivem",
    name: "FiveM",
    processes: [
      /^FiveM\.exe$/i,
      /^FiveM.*GTAProcess\.exe$/i,
    ],
  },
  {
    id: "gta5",
    name: "GTA V",
    processes: [
      /^GTA5\.exe$/i,
      /^GTA5_Enhanced\.exe$/i,
    ],
  },
  {
    id: "apex",
    name: "Apex Legends",
    processes: [/^r5apex\.exe$/i],
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runProcess(command, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;

      finished = true;

      try {
        child.kill();
      } catch {}

      reject(new Error(`${command} timed out`));
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
    }

    child.once("error", (error) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      reject(error);
    });

    child.once("close", (code) => {
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

async function powershellJSON(script, timeoutMs = 15000) {
  const result = await runProcess(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    timeoutMs
  );

  if (result.stderr.trim() && result.code !== 0) {
    throw new Error(result.stderr.trim());
  }

  const text = result.stdout.trim();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Unable to parse PowerShell JSON: ${text.slice(0, 1000)}`
    );
  }
}

function asArray(value) {
  if (!value) return [];

  return Array.isArray(value)
    ? value
    : [value];
}

async function getWindowsProcesses() {
  if (process.platform !== "win32") {
    return [];
  }

  const result = await powershellJSON(`
$ErrorActionPreference = "SilentlyContinue"

@(
  Get-CimInstance Win32_Process |
  Select-Object Name, ProcessId
) | ConvertTo-Json -Compress -Depth 5
`);

  return asArray(result);
}

function gameMatchesProcess(game, processName) {
  return game.processes.some((regex) =>
    regex.test(processName)
  );
}

async function detectRunningGame() {
  const processes = await getWindowsProcesses();

  for (const game of GAME_CATALOG) {
    const matches = processes.filter((processInfo) => {
      const name = String(processInfo.Name || "");

      return (
        name &&
        gameMatchesProcess(game, name)
      );
    });

    if (!matches.length) {
      continue;
    }

    return {
      id: game.id,
      name: game.name,

      processes: matches.map((processInfo) => ({
        name: String(processInfo.Name),
        pid: Number(processInfo.ProcessId),
      })),
    };
  }

  return null;
}

async function collectConnections(pids) {
  if (
    process.platform !== "win32" ||
    !Array.isArray(pids) ||
    !pids.length
  ) {
    return {
      tcp: [],
      udp: [],
    };
  }

  const safePids = pids
    .map(Number)
    .filter(
      (pid) =>
        Number.isInteger(pid) &&
        pid > 0
    );

  if (!safePids.length) {
    return {
      tcp: [],
      udp: [],
    };
  }

  const pidList = safePids.join(",");

  const result = await powershellJSON(`
$ErrorActionPreference = "SilentlyContinue"

$processIds = @(${pidList})

$tcp = @()
$udp = @()

foreach ($processId in $processIds) {

  $tcpItems = Get-NetTCPConnection -OwningProcess $processId -State Established -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, OwningProcess

  if ($tcpItems) {
    $tcp += @($tcpItems)
  }

  $udpItems = Get-NetUDPEndpoint -OwningProcess $processId -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, OwningProcess

  if ($udpItems) {
    $udp += @($udpItems)
  }
}

[PSCustomObject]@{
  tcp = @($tcp)
  udp = @($udp)
} | ConvertTo-Json -Compress -Depth 6
`);

  return {
    tcp: asArray(result?.tcp),
    udp: asArray(result?.udp),
  };
}

function isPublicIPv4(address) {
  if (
    typeof address !== "string" ||
    net.isIP(address) !== 4
  ) {
    return false;
  }

  const parts = address
    .split(".")
    .map(Number);

  const [a, b] = parts;

  if (a === 0) return false;
  if (a === 10) return false;
  if (a === 127) return false;

  if (
    a === 169 &&
    b === 254
  ) {
    return false;
  }

  if (
    a === 172 &&
    b >= 16 &&
    b <= 31
  ) {
    return false;
  }

  if (
    a === 192 &&
    b === 168
  ) {
    return false;
  }

  if (a >= 224) {
    return false;
  }

  return true;
}

async function capturePktmon(durationMs = 2500) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      output: "",
      error: "pktmon is Windows-only",
    };
  }

  try {
    await runProcess(
      "pktmon.exe",
      ["stop"],
      3000
    ).catch(() => {});
  } catch {}

  let child;

  try {
    child = spawn(
      "pktmon.exe",
      [
        "start",
        "--capture",
        "--comp",
        "nics",
        "--pkt-size",
        "128",
        "--log-mode",
        "real-time",
      ],
      {
        shell: false,
        windowsHide: true,
      }
    );
  } catch (error) {
    return {
      ok: false,
      output: "",
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }

  let output = "";
  let errorOutput = "";

  if (child.stdout) {
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
  }

  if (child.stderr) {
    child.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });
  }

  await sleep(durationMs);

  try {
    await runProcess(
      "pktmon.exe",
      ["stop"],
      5000
    );
  } catch {}

  await sleep(400);

  try {
    child.kill();
  } catch {}

  const combined =
    `${output}\n${errorOutput}`.trim();

  if (
    /access.*denied/i.test(combined) ||
    /administrator/i.test(combined)
  ) {
    return {
      ok: false,
      output: combined,
      error:
        "Administrator access is required for packet monitoring.",
    };
  }

  return {
    ok: true,
    output: combined,
    error: null,
  };
}

function parseUdpCandidates(packetOutput, localPorts) {
  const portSet = new Set(
    localPorts.map(Number)
  );

  const candidates = new Map();

  const patterns = [
    /(\d{1,3}(?:\.\d{1,3}){3})[.:](\d+)\s*>\s*(\d{1,3}(?:\.\d{1,3}){3})[.:](\d+).*UDP/gi,

    /UDP.*?(\d{1,3}(?:\.\d{1,3}){3})[.:](\d+).*?(\d{1,3}(?:\.\d{1,3}){3})[.:](\d+)/gi,
  ];

  for (const pattern of patterns) {
    let match;

    while (
      (match = pattern.exec(packetOutput)) !== null
    ) {
      const sourceIP = match[1];
      const sourcePort = Number(match[2]);

      const destinationIP = match[3];
      const destinationPort = Number(match[4]);

      let remoteIP = null;
      let remotePort = null;
      let localPort = null;

      if (
        portSet.has(sourcePort) &&
        isPublicIPv4(destinationIP)
      ) {
        remoteIP = destinationIP;
        remotePort = destinationPort;
        localPort = sourcePort;
      } else if (
        portSet.has(destinationPort) &&
        isPublicIPv4(sourceIP)
      ) {
        remoteIP = sourceIP;
        remotePort = sourcePort;
        localPort = destinationPort;
      } else {
        continue;
      }

      const key =
        `${remoteIP}:${remotePort}`;

      const existing =
        candidates.get(key) || {
          ip: remoteIP,
          port: remotePort,
          localPort,
          protocol: "UDP",
          packets: 0,
          source: "pktmon",
        };

      existing.packets += 1;

      candidates.set(
        key,
        existing
      );
    }
  }

  return Array.from(
    candidates.values()
  );
}

function makeTcpCandidates(connections) {
  const map = new Map();

  for (const connection of connections) {
    const ip =
      String(
        connection.RemoteAddress || ""
      );

    const port =
      Number(
        connection.RemotePort
      );

    if (
      !isPublicIPv4(ip) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      continue;
    }

    const key =
      `${ip}:${port}`;

    const current =
      map.get(key) || {
        ip,
        port,
        protocol: "TCP",
        packets: 0,
        source:
          "Get-NetTCPConnection",
      };

    current.packets += 1;

    map.set(key, current);
  }

  return Array.from(map.values());
}

function candidateScore(candidate) {
  let score = 0;

  if (candidate.protocol === "UDP") {
    score += 200;
  } else {
    score += 40;
  }

  score += Math.min(
    candidate.packets || 0,
    100
  );

  if (
    candidate.port >= 27000 &&
    candidate.port <= 28000
  ) {
    score += 35;
  }

  if (
    candidate.protocol === "TCP" &&
    candidate.port === 443
  ) {
    score -= 20;
  }

  return score;
}

function rankCandidates(candidates) {
  return [...candidates]
    .map((candidate) => ({
      ...candidate,
      score: candidateScore(candidate),
    }))
    .sort(
      (a, b) =>
        b.score - a.score
    );
}

async function scanActiveGame() {
  if (process.platform !== "win32") {
    return {
      detected: false,
      reason: "windows-only",
      game: null,
      server: null,
      candidates: [],
      packetCapture: {
        attempted: false,
        ok: false,
        error: null,
      },
    };
  }

  const game =
    await detectRunningGame();

  if (!game) {
    return {
      detected: false,
      reason: "no-supported-game",
      game: null,
      server: null,
      candidates: [],
      packetCapture: {
        attempted: false,
        ok: false,
        error: null,
      },
    };
  }

  const pids =
    game.processes.map(
      (processInfo) =>
        processInfo.pid
    );

  const connections =
    await collectConnections(pids);

  const candidates =
    makeTcpCandidates(
      connections.tcp
    );

  const udpPorts = Array.from(
    new Set(
      connections.udp
        .map(
          (endpoint) =>
            Number(
              endpoint.LocalPort
            )
        )
        .filter(
          (port) =>
            Number.isInteger(port) &&
            port >= 1 &&
            port <= 65535
        )
    )
  );

  const packetCapture = {
    attempted: false,
    ok: false,
    error: null,
  };

  if (udpPorts.length > 0) {
    packetCapture.attempted = true;

    const capture =
      await capturePktmon(2500);

    packetCapture.ok =
      capture.ok;

    packetCapture.error =
      capture.error;

    if (capture.ok) {
      candidates.push(
        ...parseUdpCandidates(
          capture.output,
          udpPorts
        )
      );
    }
  }

  const ranked =
    rankCandidates(candidates);

  const selected =
    ranked[0] || null;

  let confidence = "none";

  if (selected) {
    if (
      selected.protocol === "UDP" &&
      selected.packets >= 6
    ) {
      confidence = "high";
    } else if (
      selected.protocol === "UDP" ||
      selected.packets >= 2
    ) {
      confidence = "medium";
    } else {
      confidence = "low";
    }
  }

  return {
    detected: true,

    reason: selected
      ? "server-detected"
      : "waiting-for-game-traffic",

    game,

    server: selected
      ? {
          ip: selected.ip,
          port: selected.port,
          protocol: selected.protocol,
          source: selected.source,
          confidence,
        }
      : null,

    candidates:
      ranked.slice(0, 8),

    network: {
      tcpConnections:
        connections.tcp.length,

      udpLocalPorts:
        udpPorts,
    },

    packetCapture,
  };
}

module.exports = {
  GAME_CATALOG,
  detectRunningGame,
  scanActiveGame,
};
