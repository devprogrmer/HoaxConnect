import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
const library = await readFile(new URL("../../src/SplitTunnel.tsx", import.meta.url), "utf8");
const toggle = source.slice(source.indexOf("async function toggleConnection()"), source.indexOf("async function scanGameNow"));

test("auto selection ranks the freshly fetched nodes instead of cached state", () => {
  const refresh = source.slice(source.indexOf("async function refreshServers"), source.indexOf("async function autoSelect"));
  const autoSelect = source.slice(source.indexOf("async function autoSelect"), source.indexOf("async function toggleConnection"));
  assert.match(refresh, /return live;/);
  assert.match(autoSelect, /const live = await refreshServers\(\)/);
  assert.match(autoSelect, /const best = live\?\.reduce/);
  assert.doesNotMatch(autoSelect, /\bservers\b/);
});

test("dashboard connection uses the privileged VPN API instead of simulated success", () => {
  assert.match(toggle, /await vpn\.connect\(/);
  assert.match(toggle, /await vpn\.disconnect\(\)/);
  assert.doesNotMatch(toggle, /await sleep\(/);
  assert.doesNotMatch(toggle, /setConnection\("connected"\)/);
});

test("dashboard sends only location preference and never executable paths", () => {
  assert.match(toggle, /countryCode: selectedServer\.countryCode\.toUpperCase\(\)/);
  assert.match(source, /region: node\.region/);
  assert.match(toggle, /region: selectedServer\.region/);
  assert.doesNotMatch(toggle, /applicationPaths|selectedApps|apps:/);
});

test("dashboard opens app selection and the library requires a saved selection to connect", () => {
  assert.match(source, /aria-label=\{connection === "connected" \? "Disconnect" : "Choose apps to connect"\}[\s\S]*?setPage\("split-tunnel"\)/);
  assert.match(library, /aria-pressed=\{selected\}/);
  assert.match(library, /await save\(\)\) await onConnect\(\)/);
  assert.match(library, /\.save\(\{ \.\.\.state, mode: "selected-only" \}\)/);
  assert.match(library, /connection !== "connected" && state\.selectedApps\.length === 0/);
});

test("Steam-discovered games use their launcher artwork without controlling routing", () => {
  assert.match(library, /app\.source === "steam"/);
  assert.match(library, /gameArtwork\(Number\(app\.launcherId\)\)/);
  assert.match(library, /toggleApp\(app\)/);
});
