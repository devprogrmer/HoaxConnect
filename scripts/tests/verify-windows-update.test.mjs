import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import yaml from "js-yaml";

const verifier = resolve("scripts/verify-windows-update.mjs");
const version = "0.3.10";
const filename = `HoaxConnect-${version}-Setup.exe`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hc-update-check-"));
  const installer = Buffer.alloc(1_000_001, 42);
  const sha512 = createHash("sha512").update(installer).digest("base64");
  writeFileSync(join(directory, filename), installer);
  writeFileSync(join(directory, `${filename}.blockmap`), gzipSync(JSON.stringify({ version: "2", files: [{ name: "file" }] })));
  writeFileSync(join(directory, "latest.yml"), yaml.dump({
    version, files: [{ url: filename, sha512, size: installer.length }],
    path: filename, sha512,
  }));
  return directory;
}

function verify(directory) {
  return spawnSync(process.execPath, [verifier, directory, version], { encoding: "utf8" });
}

test("accepts complete matching update artifacts", () => {
  const directory = fixture();
  try { assert.equal(verify(directory).status, 0); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rejects mismatched installer bytes", () => {
  const directory = fixture();
  try {
    const file = join(directory, filename);
    const bytes = readFileSync(file);
    bytes[0] ^= 1;
    writeFileSync(file, bytes);
    assert.notEqual(verify(directory).status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rejects a manifest pointing outside the release directory", () => {
  const directory = fixture();
  try {
    const file = join(directory, "latest.yml");
    const manifest = yaml.load(readFileSync(file, "utf8"));
    manifest.files[0].url = "../other.exe";
    writeFileSync(file, yaml.dump(manifest));
    assert.notEqual(verify(directory).status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rejects an invalid differential blockmap", () => {
  const directory = fixture();
  try {
    writeFileSync(join(directory, `${filename}.blockmap`), "not a blockmap");
    assert.notEqual(verify(directory).status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
