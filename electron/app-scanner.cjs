const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function runPowerShell(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
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
        shell: false,
        windowsHide: true,
      }
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;

      done = true;

      try {
        child.kill();
      } catch {}

      reject(
        new Error("Application scan timed out")
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      if (done) return;

      done = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code) => {
      if (done) return;

      done = true;
      clearTimeout(timer);

      if (code !== 0 && stderr.trim()) {
        reject(new Error(stderr.trim()));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

function array(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeExePath(input) {
  if (!input || typeof input !== "string") {
    return null;
  }

  let value = input.trim();

  if (!value) {
    return null;
  }

  if (value.startsWith('"')) {
    const match = value.match(/^"([^"]+\.exe)"/i);

    if (match) {
      value = match[1];
    }
  } else {
    const match = value.match(/^(.+?\.exe)(?:,[-]?\d+)?$/i);

    if (match) {
      value = match[1];
    }
  }

  value = value.replace(/^"+|"+$/g, "");

  if (!/\.exe$/i.test(value)) {
    return null;
  }

  return path.win32.normalize(value);
}

function makeID(exePath) {
  return Buffer
    .from(exePath.toLowerCase())
    .toString("base64url");
}

async function scanWindowsApps() {
  if (process.platform !== "win32") {
    return [];
  }

  const script = `
$ErrorActionPreference = "SilentlyContinue"

$items = @()

$registryPaths = @(
  "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"
)

foreach ($registryPath in $registryPaths) {
  Get-ItemProperty $registryPath -ErrorAction SilentlyContinue |
    Where-Object {
      $_.DisplayName -and
      ($_.DisplayIcon -or $_.InstallLocation)
    } |
    ForEach-Object {
      $items += [PSCustomObject]@{
        name = $_.DisplayName
        executable = $_.DisplayIcon
        installLocation = $_.InstallLocation
        source = "registry"
      }
    }
}

$startMenus = @(
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs"
)

$shell = New-Object -ComObject WScript.Shell

foreach ($root in $startMenus) {
  if (-not (Test-Path $root)) {
    continue
  }

  Get-ChildItem $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object {
      try {
        $shortcut = $shell.CreateShortcut($_.FullName)

        if ($shortcut.TargetPath -and $shortcut.TargetPath -match "\\.exe$") {
          $items += [PSCustomObject]@{
            name = $_.BaseName
            executable = $shortcut.TargetPath
            installLocation = (Split-Path $shortcut.TargetPath -Parent)
            source = "start-menu"
          }
        }
      } catch {}
    }
}

$running = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.ExecutablePath
    } |
    Select-Object Name, ExecutablePath, ProcessId
)

[PSCustomObject]@{
  installed = @($items)
  running = @($running)
} | ConvertTo-Json -Compress -Depth 6
`;

  const output = await runPowerShell(script);

  if (!output) {
    return [];
  }

  const raw = JSON.parse(output);

  const runningItems = array(raw.running);

  const runningPaths = new Set(
    runningItems
      .map((item) =>
        normalizeExePath(item.ExecutablePath)
      )
      .filter(Boolean)
      .map((item) => item.toLowerCase())
  );

  const runningNames = new Set(
    runningItems
      .map((item) =>
        String(item.Name || "").toLowerCase()
      )
      .filter(Boolean)
  );

  const result = new Map();

  for (const item of array(raw.installed)) {
    let exePath =
      normalizeExePath(item.executable);

    if (!exePath && item.installLocation) {
      continue;
    }

    if (!exePath) {
      continue;
    }

    const lower = exePath.toLowerCase();

    const exeName =
      path.win32.basename(exePath);

    const name =
      String(item.name || "")
        .trim() ||
      exeName.replace(/\.exe$/i, "");

    if (
      /unins\d*\.exe$/i.test(exeName) ||
      /uninstall/i.test(name)
    ) {
      continue;
    }

    const existing =
      result.get(lower);

    const record = {
      id: makeID(exePath),

      name,

      exeName,

      path: exePath,

      source:
        item.source || "windows",

      running:
        runningPaths.has(lower) ||
        runningNames.has(
          exeName.toLowerCase()
        ),
    };

    if (!existing) {
      result.set(lower, record);
      continue;
    }

    if (
      existing.source === "registry" &&
      record.source === "start-menu"
    ) {
      result.set(lower, record);
    }
  }

  for (const processInfo of runningItems) {
    const exePath =
      normalizeExePath(
        processInfo.ExecutablePath
      );

    if (!exePath) continue;

    const lower =
      exePath.toLowerCase();

    if (result.has(lower)) {
      result.get(lower).running = true;
      continue;
    }

    const exeName =
      path.win32.basename(exePath);

    result.set(lower, {
      id: makeID(exePath),

      name:
        exeName.replace(/\.exe$/i, ""),

      exeName,

      path: exePath,

      source: "running-process",

      running: true,
    });
  }

  return Array.from(result.values())
    .sort((a, b) => {
      if (a.running !== b.running) {
        return a.running ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    })
    .slice(0, 500);
}

function appFromManualPath(exePath) {
  const normalized =
    normalizeExePath(exePath);

  if (!normalized) {
    throw new Error(
      "Selected file is not a valid Windows executable."
    );
  }

  if (!fs.existsSync(normalized)) {
    throw new Error(
      "Selected executable does not exist."
    );
  }

  const exeName =
    path.win32.basename(normalized);

  return {
    id: makeID(normalized),

    name:
      exeName.replace(/\.exe$/i, ""),

    exeName,

    path: normalized,

    source: "manual",

    running: false,
  };
}

module.exports = {
  scanWindowsApps,
  appFromManualPath,
};
