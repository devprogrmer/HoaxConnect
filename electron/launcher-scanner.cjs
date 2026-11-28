const fs = require("node:fs");
const path = require("node:path");

const HELPER_EXECUTABLE = /(?:^|[-_.])(anti[-_]?cheat|crash(?:handler|reporter)?|dxsetup|eac|easyanticheat|launcher|redist|reporter|setup|unins\d*|uninstall|vc_redist)(?:[-_.]|$)/i;

function makeId(executablePath) {
  return Buffer.from(executablePath.toLowerCase()).toString("base64url");
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parseVdfString(source, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`"${escapedKey}"\\s+"((?:\\\\.|[^"])*)"`, "i"));
  return match ? match[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"') : null;
}

function executableCandidates(root, maxDepth = 3) {
  const matches = [];
  function walk(directory, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (
        entry.isFile() &&
        /\.exe$/i.test(entry.name) &&
        !HELPER_EXECUTABLE.test(entry.name)
      ) {
        matches.push(fullPath);
      }
    }
  }
  walk(root, 0);
  return matches;
}

function record({ executablePath, launcherId, name, source }) {
  return {
    id: makeId(executablePath),
    name,
    exeName: path.basename(executablePath),
    path: executablePath,
    source,
    launcherId,
    running: false,
  };
}

function steamLibraryRoots(steamRoot) {
  const roots = new Set([steamRoot]);
  const source = readText(path.join(steamRoot, "steamapps", "libraryfolders.vdf"));
  if (!source) return [...roots];
  for (const match of source.matchAll(/"path"\s+"((?:\\\\.|[^"])*)"/gi)) {
    roots.add(match[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"'));
  }
  return [...roots];
}

function scanSteamLibraries({ steamRoot }) {
  if (!steamRoot) return [];
  const games = [];
  for (const library of steamLibraryRoots(steamRoot)) {
    const steamApps = path.join(library, "steamapps");
    let manifests = [];
    try {
      manifests = fs.readdirSync(steamApps).filter((name) => /^appmanifest_\d+\.acf$/i.test(name));
    } catch {
      continue;
    }
    for (const manifestName of manifests) {
      const source = readText(path.join(steamApps, manifestName));
      if (!source) continue;
      const launcherId = parseVdfString(source, "appid");
      const name = parseVdfString(source, "name");
      const installDir = parseVdfString(source, "installdir");
      if (!launcherId || !name || !installDir) continue;
      const installRoot = path.join(steamApps, "common", installDir);
      for (const executablePath of executableCandidates(installRoot)) {
        games.push(record({ executablePath, launcherId, name, source: "steam" }));
      }
    }
  }
  return games;
}

function scanEpicManifests({ manifestRoot }) {
  if (!manifestRoot) return [];
  let manifests = [];
  try {
    manifests = fs.readdirSync(manifestRoot).filter((name) => name.endsWith(".item"));
  } catch {
    return [];
  }
  const games = [];
  for (const manifestName of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(manifestRoot, manifestName), "utf8"));
    } catch {
      continue;
    }
    if (
      typeof manifest.AppName !== "string" ||
      typeof manifest.DisplayName !== "string" ||
      typeof manifest.InstallLocation !== "string" ||
      typeof manifest.LaunchExecutable !== "string"
    ) {
      continue;
    }
    const executablePath = path.resolve(
      manifest.InstallLocation,
      manifest.LaunchExecutable.replaceAll("/", path.sep),
    );
    if (!fs.existsSync(executablePath) || !/\.exe$/i.test(executablePath)) continue;
    games.push(record({
      executablePath,
      launcherId: manifest.AppName,
      name: manifest.DisplayName,
      source: "epic",
    }));
  }
  return games;
}

module.exports = {
  executableCandidates,
  scanEpicManifests,
  scanSteamLibraries,
};
