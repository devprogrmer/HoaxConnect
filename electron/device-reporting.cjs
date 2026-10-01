const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");

const DEFAULT_PERMISSIONS = Object.freeze({ hardware: false, network: false, applications: false });

function normalizePermissions(value) {
  return Object.fromEntries(Object.keys(DEFAULT_PERMISSIONS).map((key) => [key, value?.[key] === true]));
}

function hardwareFingerprint(value) {
  const uuid = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid) ||
      /^[0-]+$/.test(uuid) || /^[f-]+$/.test(uuid)) return null;
  return createHash("sha256").update(`HoaxConnect:hardware:v1:${uuid}`).digest("hex");
}

function windowsJson(command) {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 6000, maxBuffer: 128 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) return reject(error);
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, "").trim() || "null")); }
        catch (parseError) { reject(parseError); }
      });
  });
}

const cleanText = (value) => typeof value === "string" && value.trim()
  // Strip control characters from firmware-provided labels before reporting them.
  // eslint-disable-next-line no-control-regex
  ? value.trim().replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160) : null;

async function collectHardware() {
  let computer = {};
  if (process.platform === "win32") {
    computer = await windowsJson("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $c=Get-CimInstance Win32_ComputerSystem; $p=Get-CimInstance Win32_ComputerSystemProduct; @{manufacturer=$c.Manufacturer;model=$c.Model;uuid=$p.UUID} | ConvertTo-Json -Compress");
  }
  return {
    hwid_sha256: hardwareFingerprint(computer?.uuid),
    manufacturer: cleanText(computer?.manufacturer), model: cleanText(computer?.model),
    cpu: cleanText(os.cpus()[0]?.model), memory_bytes: os.totalmem(),
  };
}

async function collectApplications() {
  if (process.platform !== "win32") return null;
  const names = await windowsJson("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -ExpandProperty ProcessName -Unique) | ConvertTo-Json -Compress");
  return [...new Set((Array.isArray(names) ? names : names ? [names] : [])
    .filter((name) => typeof name === "string" && /^[\p{L}\p{N} _().+-]{1,80}$/u.test(name)))].sort().slice(0, 64);
}

function createDeviceReporter({ owner, userDataPath, isOnline = () => true,
  hardwareCollector = collectHardware, applicationsCollector = collectApplications,
  now = Date.now, intervalMs = 30_000 }) {
  const file = path.join(userDataPath, "device-reporting.json");
  let permissions;
  try { permissions = normalizePermissions(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch { permissions = { ...DEFAULT_PERMISSIONS }; }
  let timer = null;
  let inflight = null;
  let generation = 0;
  let stopped = false;
  let lastRtt = null;
  let failures = 0;
  let lastSentAt = null;
  let hardware = null;
  let hardwareReadAt = 0;

  function getSettings() { return { permissions: { ...permissions }, lastSentAt }; }

  async function send(appState) {
    const deviceId = owner.getDeviceIdForMainProcess();
    if (!deviceId) return;
    const version = generation;
    const consent = { ...permissions };
    const report = { version: 1, app_state: appState, permissions: consent,
      hardware: null, network: null, applications: null };
    if (appState === "running") {
      if (consent.hardware) {
        if (!hardware || now() - hardwareReadAt > 3_600_000) {
          try {
            const collected = await hardwareCollector();
            if (version !== generation) return;
            hardware = collected; hardwareReadAt = now();
          }
          catch { hardware = null; }
        }
        report.hardware = hardware;
      }
      if (consent.applications) {
        try { report.applications = await applicationsCollector(); } catch { /* Keep unavailable distinct from an empty list. */ }
      }
      if (consent.network) report.network = {
        interface_online: Boolean(isOnline()), backend_rtt_ms: lastRtt, failed_heartbeats: failures,
      };
    }
    if (version !== generation || (stopped && appState !== "closed")) return;
    const start = now();
    const result = await owner.reportDeviceState(report, deviceId);
    if (result.ok) { lastSentAt = new Date(now()).toISOString(); lastRtt = Math.min(120_000, Math.max(0, now() - start)); failures = 0; }
    else { failures = Math.min(1_000_000, failures + 1); }
  }

  function tick() {
    if (stopped) return Promise.resolve();
    if (!inflight) inflight = send("running").catch(() => { failures = Math.min(1_000_000, failures + 1); })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return {
    getSettings,
    async setPermissions(input) {
      if (!input || typeof input !== "object" || Object.keys(input).length !== 3 ||
          Object.keys(DEFAULT_PERMISSIONS).some((key) => typeof input[key] !== "boolean")) {
        throw new Error("Invalid device reporting settings");
      }
      const next = normalizePermissions(input);
      fs.mkdirSync(userDataPath, { recursive: true });
      const temporary = `${file}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      permissions = next;
      generation += 1;
      if (!permissions.hardware) hardware = null;
      await inflight;
      await tick();
      return getSettings();
    },
    tick,
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
      void tick();
    },
    async stop() {
      stopped = true;
      generation += 1;
      clearInterval(timer); timer = null;
      await inflight;
      await send("closed").catch(() => {});
    },
  };
}

module.exports = { createDeviceReporter, collectHardware, collectApplications, hardwareFingerprint, normalizePermissions };
