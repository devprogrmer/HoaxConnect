import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

const script = new URL("../measure-windows-delta.mjs", import.meta.url);

function blockmap(path, checksums, sizes) {
  writeFileSync(
    path,
    gzipSync(
      JSON.stringify({
        version: "2",
        files: [{ name: "package.7z", checksums, sizes }],
      }),
    ),
  );
}

test("accepts an update delta within the release limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "hoaxconnect-delta-"));
  const previous = join(directory, "previous.blockmap");
  const next = join(directory, "next.blockmap");
  blockmap(previous, ["same", "old"], [100, 200]);
  blockmap(next, ["same", "new"], [100, 200]);

  const output = execFileSync(
    process.execPath,
    [script.pathname, previous, next, "200"],
    { encoding: "utf8" },
  );

  assert.deepEqual(JSON.parse(output), {
    installerBytes: 300,
    estimatedChangedBytes: 200,
  });
});

test("blocks an update delta above the release limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "hoaxconnect-delta-"));
  const previous = join(directory, "previous.blockmap");
  const next = join(directory, "next.blockmap");
  blockmap(previous, ["old"], [201]);
  blockmap(next, ["new"], [201]);

  const result = spawnSync(
    process.execPath,
    [script.pathname, previous, next, "200"],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Windows update delta is 201 bytes/);
});
