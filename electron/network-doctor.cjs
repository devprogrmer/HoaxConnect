const { spawn } = require("child_process");
const { app } = require("electron");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const net = require("net");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runProcess(command, args, timeoutMs = 30000) {
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

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

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

async function powershell(script, timeoutMs = 30000) {
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

  if (result.code !== 0 && result.stderr.trim()) {
    throw new Error(result.stderr.trim());
  }

  return result.stdout.trim();
}

async function powershellJSON(script, timeoutMs = 30000) {
  const output = await powershell(script, timeoutMs);

  if (!output) {
    return null;
  }

  try {
    return JSON.parse(output);
  } catch {
    throw new Error(
      `Invalid Windows response: ${output.slice(0, 1000)}`
    );
  }
}

function asArray(value) {
  if (!value) return [];

  return Array.isArray(value)
    ? value
    : [value];
}

async function getActiveAdapter() {
  if (process.platform !== "win32") {
    return null;
  }

  return await powershellJSON(`
$ErrorActionPreference = "SilentlyContinue"

$cfg = Get-NetIPConfiguration |
  Where-Object {
    $_.NetAdapter.Status -eq "Up" -and
    $_.IPv4DefaultGateway
  } |
  Select-Object -First 1

if (-not $cfg) {
  $cfg = Get-NetIPConfiguration |
    Where-Object {
      $_.NetAdapter.Status -eq "Up" -and
      $_.IPv4Address
    } |
    Select-Object -First 1
}

if (-not $cfg) {
  [PSCustomObject]@{
    found = $false
  } | ConvertTo-Json -Compress
  exit
}

$adapter = Get-NetAdapter -InterfaceIndex $cfg.InterfaceIndex

$dns = Get-DnsClientServerAddress -InterfaceIndex $cfg.InterfaceIndex -AddressFamily IPv4

$regPath = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$($adapter.InterfaceGuid)"

$reg = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue

[PSCustomObject]@{
  found = $true
  alias = $adapter.Name
  description = $adapter.InterfaceDescription
  interfaceIndex = $cfg.InterfaceIndex
  interfaceGuid = "$($adapter.InterfaceGuid)"
  ipv4 = "$($cfg.IPv4Address.IPAddress)"
  gateway = "$($cfg.IPv4DefaultGateway.NextHop)"
  dnsServers = @($dns.ServerAddresses)
  staticNameServer = "$($reg.NameServer)"
  dhcpNameServer = "$($reg.DhcpNameServer)"
} | ConvertTo-Json -Compress -Depth 5
`);
}

async function adapterCounters(alias) {
  if (!alias) {
    return null;
  }

  return await powershellJSON(`
$ErrorActionPreference = "Stop"

$s = Get-NetAdapterStatistics -Name ${psQuote(alias)}

[PSCustomObject]@{
  receivedBytes = [double]$s.ReceivedBytes
  sentBytes = [double]$s.SentBytes
  receivedUnicastPackets = [double]$s.ReceivedUnicastPackets
  sentUnicastPackets = [double]$s.SentUnicastPackets
  receivedDiscardedPackets = [double]$s.ReceivedDiscardedPackets
  outboundDiscardedPackets = [double]$s.OutboundDiscardedPackets
} | ConvertTo-Json -Compress
`);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;

  const p = 10 ** digits;

  return Math.round(value * p) / p;
}

async function getSystemTraffic() {
  const adapter = await getActiveAdapter();

  if (!adapter?.found) {
    throw new Error("No active Windows network adapter was found.");
  }

  const start = await adapterCounters(adapter.alias);

  const startTime = Date.now();

  await sleep(1000);

  const end = await adapterCounters(adapter.alias);

  const elapsed =
    Math.max(0.1, (Date.now() - startTime) / 1000);

  const downBytes =
    Math.max(
      0,
      Number(end.receivedBytes || 0) -
      Number(start.receivedBytes || 0)
    );

  const upBytes =
    Math.max(
      0,
      Number(end.sentBytes || 0) -
      Number(start.sentBytes || 0)
    );

  return {
    adapter,

    downloadBytesPerSecond:
      round(downBytes / elapsed),

    uploadBytesPerSecond:
      round(upBytes / elapsed),

    downloadMbps:
      round(
        ((downBytes / elapsed) * 8) /
        1_000_000
      ),

    uploadMbps:
      round(
        ((upBytes / elapsed) * 8) /
        1_000_000
      ),

    totalReceivedBytes:
      Number(end.receivedBytes || 0),

    totalSentBytes:
      Number(end.sentBytes || 0),

    discardedPackets:
      Number(end.receivedDiscardedPackets || 0) +
      Number(end.outboundDiscardedPackets || 0),
  };
}

function processID(exePath, pid) {
  const source =
    exePath || `pid:${pid}`;

  return Buffer
    .from(String(source).toLowerCase())
    .toString("base64url");
}

async function getProcessActivity() {
  if (process.platform !== "win32") {
    return [];
  }

  const result = await powershellJSON(`
$ErrorActionPreference = "SilentlyContinue"

$tcp = @(
  Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue
)

$udp = @(
  Get-NetUDPEndpoint -ErrorAction SilentlyContinue
)

$pids = @(
  ($tcp | Select-Object -ExpandProperty OwningProcess) +
  ($udp | Select-Object -ExpandProperty OwningProcess)
) |
  Where-Object { $_ -gt 0 } |
  Sort-Object -Unique

$processes = @{}

Get-CimInstance Win32_Process |
  Where-Object {
    $pids -contains $_.ProcessId
  } |
  ForEach-Object {
    $processes[[int]$_.ProcessId] = $_
  }

$result = @()

foreach ($processId in $pids) {
  $proc = $processes[[int]$processId]

  if (-not $proc) {
    continue
  }

  $tcpCount = @(
    $tcp |
    Where-Object {
      $_.OwningProcess -eq $processId
    }
  ).Count

  $udpCount = @(
    $udp |
    Where-Object {
      $_.OwningProcess -eq $processId
    }
  ).Count

  $remote = @(
    $tcp |
    Where-Object {
      $_.OwningProcess -eq $processId
    } |
    Select-Object -First 5 |
    ForEach-Object {
      "$($_.RemoteAddress):$($_.RemotePort)"
    }
  )

  $result += [PSCustomObject]@{
    pid = [int]$processId
    name = "$($proc.Name)"
    path = "$($proc.ExecutablePath)"
    tcpConnections = [int]$tcpCount
    udpEndpoints = [int]$udpCount
    remoteEndpoints = @($remote)
  }
}

@(
  $result |
  Sort-Object @{
    Expression = {
      $_.tcpConnections + $_.udpEndpoints
    }
    Descending = $true
  } |
  Select-Object -First 60
) | ConvertTo-Json -Compress -Depth 6
`);

  return asArray(result)
    .map((item) => ({
      id: processID(
        String(item.path || ""),
        Number(item.pid)
      ),

      pid: Number(item.pid),

      name:
        String(item.name || "Unknown"),

      exeName:
        String(item.name || "Unknown"),

      path:
        String(item.path || ""),

      tcpConnections:
        Number(item.tcpConnections || 0),

      udpEndpoints:
        Number(item.udpEndpoints || 0),

      totalConnections:
        Number(item.tcpConnections || 0) +
        Number(item.udpEndpoints || 0),

      remoteEndpoints:
        asArray(item.remoteEndpoints)
          .map(String),
    }))
    .filter(
      (item) =>
        Number.isInteger(item.pid) &&
        item.pid > 0
    );
}

async function getActivitySnapshot() {
  const [
    traffic,
    processes,
  ] = await Promise.all([
    getSystemTraffic(),
    getProcessActivity(),
  ]);

  return {
    ...traffic,
    processes,
    measuredAt:
      new Date().toISOString(),
  };
}

const DNS_CANDIDATES = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    servers: [
      "1.1.1.1",
      "1.0.0.1",
    ],
  },
  {
    id: "google",
    name: "Google",
    servers: [
      "8.8.8.8",
      "8.8.4.4",
    ],
  },
  {
    id: "quad9",
    name: "Quad9",
    servers: [
      "9.9.9.9",
      "149.112.112.112",
    ],
  },
];

const DNS_TEST_DOMAINS = [
  "cloudflare.com",
  "google.com",
  "microsoft.com",
  "steamcommunity.com",
  "discord.com",
];

function timeoutPromise(promise, ms) {
  return Promise.race([
    promise,

    new Promise((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error("timeout")
          ),
        ms
      );
    }),
  ]);
}

async function benchmarkResolver(candidate) {
  const resolver =
    new dns.promises.Resolver();

  resolver.setServers(
    candidate.servers
  );

  const samples = [];

  let failures = 0;

  for (let round = 0; round < 2; round++) {
    for (const domain of DNS_TEST_DOMAINS) {
      const started =
        process.hrtime.bigint();

      try {
        await timeoutPromise(
          resolver.resolve4(domain),
          2500
        );

        const elapsed =
          Number(
            process.hrtime.bigint() -
            started
          ) / 1_000_000;

        samples.push(elapsed);
      } catch {
        failures += 1;
      }
    }
  }

  const averageMs =
    samples.length
      ? samples.reduce(
          (a, b) => a + b,
          0
        ) / samples.length
      : null;

  return {
    ...candidate,

    averageMs:
      averageMs === null
        ? null
        : round(averageMs, 1),

    successfulQueries:
      samples.length,

    failures,

    score:
      averageMs === null
        ? 999999
        : averageMs +
          failures * 300,
  };
}

async function getDNSState() {
  const adapter =
    await getActiveAdapter();

  if (!adapter?.found) {
    throw new Error(
      "No active Windows network adapter was found."
    );
  }

  const restoreFile =
    path.join(
      app.getPath("userData"),
      "dns-restore.json"
    );

  return {
    adapter,

    canRestore:
      fs.existsSync(
        restoreFile
      ),
  };
}

async function benchmarkDNS() {
  const adapter =
    await getActiveAdapter();

  if (!adapter?.found) {
    throw new Error(
      "No active adapter found."
    );
  }

  const currentServers =
    asArray(
      adapter.dnsServers
    )
      .filter(
        (server) =>
          net.isIP(server) > 0
      );

  const candidates = [
    ...(currentServers.length
      ? [
          {
            id: "current",
            name: "Current DNS",
            servers:
              currentServers,
          },
        ]
      : []),

    ...DNS_CANDIDATES,
  ];

  const results = [];

  for (const candidate of candidates) {
    results.push(
      await benchmarkResolver(
        candidate
      )
    );
  }

  const ranked =
    [...results].sort(
      (a, b) =>
        a.score - b.score
    );

  const recommended =
    ranked.find(
      (item) =>
        item.averageMs !== null
    ) || null;

  return {
    currentServers,

    results,

    recommended,

    testedAt:
      new Date().toISOString(),
  };
}

function dnsRestorePath() {
  return path.join(
    app.getPath("userData"),
    "dns-restore.json"
  );
}

async function applyDNS(servers) {
  if (
    !Array.isArray(servers) ||
    servers.length < 1 ||
    servers.length > 4
  ) {
    throw new Error(
      "Invalid DNS server list."
    );
  }

  const cleanServers =
    servers.map(String);

  for (const server of cleanServers) {
    if (net.isIP(server) !== 4) {
      throw new Error(
        `Invalid IPv4 DNS server: ${server}`
      );
    }
  }

  const adapter =
    await getActiveAdapter();

  if (!adapter?.found) {
    throw new Error(
      "No active adapter found."
    );
  }

  const restoreFile =
    dnsRestorePath();

  if (
    !fs.existsSync(
      restoreFile
    )
  ) {
    const staticNameServer =
      String(
        adapter.staticNameServer ||
        ""
      ).trim();

    const restore = {
      interfaceIndex:
        adapter.interfaceIndex,

      alias:
        adapter.alias,

      originalServers:
        asArray(
          adapter.dnsServers
        ),

      dhcpManaged:
        !staticNameServer,

      savedAt:
        new Date().toISOString(),
    };

    fs.writeFileSync(
      restoreFile,
      JSON.stringify(
        restore,
        null,
        2
      ),
      "utf8"
    );
  }

  const addresses =
    cleanServers
      .map(psQuote)
      .join(",");

  await powershell(`
$ErrorActionPreference = "Stop"

Set-DnsClientServerAddress -InterfaceIndex ${Number(adapter.interfaceIndex)} -ServerAddresses @(${addresses})

Clear-DnsClientCache
`);

  return await getDNSState();
}

async function restoreDNS() {
  const restoreFile =
    dnsRestorePath();

  if (
    !fs.existsSync(
      restoreFile
    )
  ) {
    throw new Error(
      "No previous DNS configuration has been saved."
    );
  }

  const restore =
    JSON.parse(
      fs.readFileSync(
        restoreFile,
        "utf8"
      )
    );

  const index =
    Number(
      restore.interfaceIndex
    );

  if (
    !Number.isInteger(index) ||
    index < 1
  ) {
    throw new Error(
      "Saved adapter information is invalid."
    );
  }

  if (restore.dhcpManaged) {
    await powershell(`
$ErrorActionPreference = "Stop"

Set-DnsClientServerAddress -InterfaceIndex ${index} -ResetServerAddresses

Clear-DnsClientCache
`);
  } else {
    const servers =
      asArray(
        restore.originalServers
      )
        .filter(
          (server) =>
            net.isIP(server) === 4
        );

    if (servers.length) {
      const addresses =
        servers
          .map(psQuote)
          .join(",");

      await powershell(`
$ErrorActionPreference = "Stop"

Set-DnsClientServerAddress -InterfaceIndex ${index} -ServerAddresses @(${addresses})

Clear-DnsClientCache
`);
    } else {
      await powershell(`
$ErrorActionPreference = "Stop"

Set-DnsClientServerAddress -InterfaceIndex ${index} -ResetServerAddresses

Clear-DnsClientCache
`);
    }
  }

  try {
    fs.unlinkSync(
      restoreFile
    );
  } catch {}

  return await getDNSState();
}

const CRITICAL_PROCESSES =
  new Set([
    "system",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "winlogon.exe",
    "svchost.exe",
    "dwm.exe",
    "explorer.exe",
    "fontdrvhost.exe",
    "memory compression",
    "secure system",
    "hoaxconnect.exe",
    "hoaxtraffic.exe",
    "powershell.exe",
    "pwsh.exe",
  ]);

async function endProcess(pid) {
  pid = Number(pid);

  if (
    !Number.isInteger(pid) ||
    pid <= 4
  ) {
    throw new Error(
      "Invalid process."
    );
  }

  const info =
    await powershellJSON(`
$ErrorActionPreference = "Stop"

$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"

if (-not $p) {
  throw "Process not found."
}

[PSCustomObject]@{
  pid = $p.ProcessId
  name = $p.Name
  path = $p.ExecutablePath
} | ConvertTo-Json -Compress
`);

  const processName =
    String(
      info?.name || ""
    ).toLowerCase();

  if (
    CRITICAL_PROCESSES.has(
      processName
    )
  ) {
    throw new Error(
      "HoaxConnect will not terminate this Windows system process."
    );
  }

  await powershell(`
$ErrorActionPreference = "Stop"

Stop-Process -Id ${pid} -Force
`);

  return {
    ok: true,
    pid,
    name:
      String(
        info?.name || ""
      ),
  };
}

module.exports = {
  getActivitySnapshot,
  getDNSState,
  benchmarkDNS,
  applyDNS,
  restoreDNS,
  endProcess,
};
