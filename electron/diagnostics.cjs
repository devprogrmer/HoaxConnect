const {
  app,
} = require("electron");

const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const {
  spawn,
} = require("child_process");

const DEFAULT_CONSENT = {
  enabled: false,

  shareGameDetection: false,
  shareAppUsage: false,
  shareNetworkQuality: false,
  shareDomains: false,

  acceptedAt: null,
  updatedAt: null,
};

function consentPath() {
  return path.join(
    app.getPath("userData"),
    "diagnostics-consent.json"
  );
}

function normalizeConsent(input) {
  return {
    enabled:
      Boolean(input?.enabled),

    shareGameDetection:
      Boolean(
        input?.shareGameDetection
      ),

    shareAppUsage:
      Boolean(
        input?.shareAppUsage
      ),

    shareNetworkQuality:
      Boolean(
        input?.shareNetworkQuality
      ),

    shareDomains:
      Boolean(
        input?.shareDomains
      ),

    acceptedAt:
      typeof input?.acceptedAt ===
      "string"
        ? input.acceptedAt
        : null,

    updatedAt:
      typeof input?.updatedAt ===
      "string"
        ? input.updatedAt
        : null,
  };
}

function getConsent() {
  try {
    const file =
      consentPath();

    if (!fs.existsSync(file)) {
      return {
        ...DEFAULT_CONSENT,
      };
    }

    return normalizeConsent(
      JSON.parse(
        fs.readFileSync(
          file,
          "utf8"
        )
      )
    );
  } catch {
    return {
      ...DEFAULT_CONSENT,
    };
  }
}

function saveConsent(input) {
  const old =
    getConsent();

  const next =
    normalizeConsent(input);

  const now =
    new Date().toISOString();

  next.updatedAt = now;

  if (
    next.enabled &&
    !old.acceptedAt
  ) {
    next.acceptedAt = now;
  } else if (
    old.acceptedAt
  ) {
    next.acceptedAt =
      old.acceptedAt;
  }

  fs.mkdirSync(
    path.dirname(
      consentPath()
    ),
    {
      recursive: true,
    }
  );

  fs.writeFileSync(
    consentPath(),
    JSON.stringify(
      next,
      null,
      2
    ),
    "utf8"
  );

  return next;
}

function runPowerShell(
  script,
  timeoutMs = 20000
) {
  return new Promise(
    (resolve, reject) => {
      if (
        process.platform !== "win32"
      ) {
        resolve("");
        return;
      }

      const child = spawn(
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
        {
          windowsHide: true,
          shell: false,
        }
      );

      let stdout = "";
      let stderr = "";
      let finished = false;

      const timer =
        setTimeout(() => {
          if (finished) return;

          finished = true;

          try {
            child.kill();
          } catch {}

          reject(
            new Error(
              "Diagnostics command timed out."
            )
          );
        }, timeoutMs);

      child.stdout?.on(
        "data",
        (chunk) => {
          stdout +=
            chunk.toString();
        }
      );

      child.stderr?.on(
        "data",
        (chunk) => {
          stderr +=
            chunk.toString();
        }
      );

      child.once(
        "error",
        (error) => {
          if (finished) return;

          finished = true;

          clearTimeout(timer);
          reject(error);
        }
      );

      child.once(
        "close",
        (code) => {
          if (finished) return;

          finished = true;

          clearTimeout(timer);

          if (
            code !== 0 &&
            stderr.trim()
          ) {
            reject(
              new Error(
                stderr.trim()
              )
            );
            return;
          }

          resolve(
            stdout.trim()
          );
        }
      );
    }
  );
}

function list(value) {
  if (!value) return [];

  return Array.isArray(value)
    ? value
    : [value];
}

async function reverseHostname(
  address
) {
  if (!address) {
    return null;
  }

  if (
    address === "0.0.0.0" ||
    address === "::" ||
    address === "127.0.0.1" ||
    address === "::1"
  ) {
    return null;
  }

  try {
    const timeout =
      new Promise(
        (_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  "DNS timeout"
                )
              ),
            1000
          );
        }
      );

    const names =
      await Promise.race([
        dns.reverse(address),
        timeout,
      ]);

    if (
      Array.isArray(names) &&
      names.length
    ) {
      return names[0];
    }
  } catch {}

  return null;
}

async function getNetworkProcesses() {
  if (
    process.platform !== "win32"
  ) {
    return [];
  }

  const script = `
$ErrorActionPreference = "SilentlyContinue"

$processes = @{}

Get-CimInstance Win32_Process |
  Where-Object {
    $_.ProcessId -and
    $_.Name
  } |
  ForEach-Object {
    $processes[[string]$_.ProcessId] = [PSCustomObject]@{
      pid = [int]$_.ProcessId
      name = $_.Name
      path = $_.ExecutablePath
    }
  }

$rows = @()

Get-NetTCPConnection -ErrorAction SilentlyContinue |
  Where-Object {
    $_.State -eq "Established" -and
    $_.RemoteAddress
  } |
  ForEach-Object {
    $pidKey = [string]$_.OwningProcess
    $proc = $processes[$pidKey]

    $rows += [PSCustomObject]@{
      pid = [int]$_.OwningProcess
      processName = if ($proc) { $proc.name } else { "" }
      processPath = if ($proc) { $proc.path } else { "" }

      protocol = "TCP"

      localAddress = $_.LocalAddress
      localPort = [int]$_.LocalPort

      remoteAddress = $_.RemoteAddress
      remotePort = [int]$_.RemotePort

      state = [string]$_.State
    }
  }

$rows |
  ConvertTo-Json -Compress -Depth 5
`;

  const output =
    await runPowerShell(script);

  if (!output) {
    return [];
  }

  let parsed;

  try {
    parsed =
      JSON.parse(output);
  } catch {
    return [];
  }

  return list(parsed);
}

async function buildSnapshot() {
  const consent =
    getConsent();

  if (!consent.enabled) {
    return {
      enabled: false,

      collectedAt:
        new Date()
          .toISOString(),

      processes: [],

      endpoints: [],

      hostnames: [],
    };
  }

  const rows =
    await getNetworkProcesses();

  const processMap =
    new Map();

  const endpoints = [];

  for (const row of rows) {
    const pid =
      Number(row.pid || 0);

    if (!pid) continue;

    const key =
      String(pid);

    if (
      !processMap.has(key)
    ) {
      processMap.set(
        key,
        {
          pid,

          name:
            String(
              row.processName ||
              `PID ${pid}`
            ),

          path:
            consent
              .shareAppUsage
              ? String(
                  row.processPath ||
                  ""
                )
              : "",

          connections: 0,
        }
      );
    }

    const processInfo =
      processMap.get(key);

    processInfo.connections += 1;

    if (
      consent.shareDomains ||
      consent.shareAppUsage
    ) {
      endpoints.push({
        pid,

        processName:
          String(
            row.processName ||
            ""
          ),

        protocol:
          row.protocol,

        remoteAddress:
          row.remoteAddress,

        remotePort:
          Number(
            row.remotePort ||
            0
          ),
      });
    }
  }

  const hostnameResults = [];

  if (
    consent.shareDomains
  ) {
    const unique =
      Array.from(
        new Set(
          endpoints
            .map(
              (item) =>
                item.remoteAddress
            )
            .filter(Boolean)
        )
      ).slice(0, 30);

    for (
      const address of unique
    ) {
      const hostname =
        await reverseHostname(
          address
        );

      if (hostname) {
        hostnameResults.push({
          address,
          hostname,
        });
      }
    }
  }

  return {
    enabled: true,

    collectedAt:
      new Date()
        .toISOString(),

    consent,

    processes:
      consent.shareAppUsage
        ? Array.from(
            processMap.values()
          ).sort(
            (a, b) =>
              b.connections -
              a.connections
          )
        : [],

    endpoints:
      consent.shareAppUsage
        ? endpoints
        : [],

    hostnames:
      consent.shareDomains
        ? hostnameResults
        : [],
  };
}

module.exports = {
  getConsent,
  saveConsent,
  buildSnapshot,
};
