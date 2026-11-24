import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
const toggle = source.slice(source.indexOf("async function toggleConnection()"), source.indexOf("async function scanGameNow"));

test("dashboard connection uses the privileged VPN API instead of simulated success", () => {
  assert.match(toggle, /await vpn\.connect\(/);
  assert.match(toggle, /await vpn\.disconnect\(\)/);
  assert.doesNotMatch(toggle, /await sleep\(/);
  assert.doesNotMatch(toggle, /setConnection\("connected"\)/);
});

test("dashboard sends only location preference and never executable paths", () => {
  assert.match(toggle, /countryCode: selectedServer\.countryCode\.toUpperCase\(\)/);
  assert.doesNotMatch(toggle, /applicationPaths|selectedApps|apps:/);
});
