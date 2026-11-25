const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const {
  scanEpicManifests,
  scanSteamLibraries,
} = require("../launcher-scanner.cjs");
const {
  executablePathsForInstalledItem,
  mergeDiscoveredApps,
} = require("../app-scanner.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-launchers-"));
after(() => fs.rmSync(root, { force: true, recursive: true }));

function write(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("discovers a game in a secondary Steam library and excludes helper executables", () => {
  const steamRoot = path.join(root, "Steam");
  const library = path.join(root, "Games Library");
  write(
    path.join(steamRoot, "steamapps", "libraryfolders.vdf"),
    `"libraryfolders"\n{\n  "1"\n  {\n    "path" "${library.replace(/\\/g, "\\\\")}"\n  }\n}`,
  );
  write(
    path.join(library, "steamapps", "appmanifest_730.acf"),
    `"AppState"\n{\n "appid" "730"\n "name" "Counter-Strike 2"\n "installdir" "Counter-Strike Global Offensive"\n}`,
  );
  const install = path.join(
    library,
    "steamapps",
    "common",
    "Counter-Strike Global Offensive",
  );
  write(path.join(install, "game", "bin", "win64", "cs2.exe"));
  write(path.join(install, "crashreporter.exe"));
  write(path.join(install, "uninstall.exe"));

  const games = scanSteamLibraries({ steamRoot });

  assert.equal(games.length, 1);
  assert.equal(games[0].name, "Counter-Strike 2");
  assert.equal(games[0].launcherId, "730");
  assert.equal(games[0].source, "steam");
  assert.equal(games[0].exeName, "cs2.exe");
  assert.equal(games[0].path, path.join(install, "game", "bin", "win64", "cs2.exe"));
});

test("preserves multiple plausible Steam executables for explicit user choice", () => {
  const steamRoot = path.join(root, "AmbiguousSteam");
  write(
    path.join(steamRoot, "steamapps", "appmanifest_42.acf"),
    `"AppState"\n{\n "appid" "42"\n "name" "Dual Mode"\n "installdir" "DualMode"\n}`,
  );
  const install = path.join(steamRoot, "steamapps", "common", "DualMode");
  write(path.join(install, "DualMode.exe"));
  write(path.join(install, "DualModeDX12.exe"));

  const games = scanSteamLibraries({ steamRoot });

  assert.deepEqual(
    games.map((game) => game.exeName).sort(),
    ["DualMode.exe", "DualModeDX12.exe"],
  );
});

test("uses Epic LaunchExecutable and ignores malformed manifests", () => {
  const manifestRoot = path.join(root, "EpicManifests");
  const install = path.join(root, "EpicGame");
  write(path.join(install, "Binaries", "Win64", "EpicGame.exe"));
  write(
    path.join(manifestRoot, "game.item"),
    JSON.stringify({
      AppName: "epic-game-id",
      DisplayName: "Epic Game",
      InstallLocation: install,
      LaunchExecutable: "Binaries/Win64/EpicGame.exe",
    }),
  );
  write(path.join(manifestRoot, "broken.item"), "{broken");

  const games = scanEpicManifests({ manifestRoot });

  assert.equal(games.length, 1);
  assert.deepEqual(
    {
      exeName: games[0].exeName,
      launcherId: games[0].launcherId,
      name: games[0].name,
      source: games[0].source,
    },
    {
      exeName: "EpicGame.exe",
      launcherId: "epic-game-id",
      name: "Epic Game",
      source: "epic",
    },
  );
});

test("launcher metadata wins while exact executable paths deduplicate", () => {
  const executablePath = path.join(root, "Shared", "Game.exe");
  const merged = mergeDiscoveredApps(
    [{
      id: "generic",
      name: "Game",
      exeName: "Game.exe",
      path: executablePath,
      source: "registry",
      running: true,
    }],
    [{
      id: "steam",
      name: "Official Game Name",
      exeName: "Game.exe",
      path: executablePath,
      source: "steam",
      launcherId: "99",
      running: false,
    }],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "Official Game Name");
  assert.equal(merged[0].source, "steam");
  assert.equal(merged[0].launcherId, "99");
  assert.equal(merged[0].running, true);
});

test("registry entries with only InstallLocation discover top-level executables", () => {
  const installLocation = path.join(root, "RegistryOnly");
  write(path.join(installLocation, "ActualGame.exe"));
  write(path.join(installLocation, "uninstall.exe"));
  write(path.join(installLocation, "nested", "IgnoredAtThisStage.exe"));

  assert.deepEqual(
    executablePathsForInstalledItem({
      executable: null,
      installLocation,
    }),
    [path.join(installLocation, "ActualGame.exe")],
  );
});
