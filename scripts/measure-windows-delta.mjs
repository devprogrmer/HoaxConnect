import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const [previousPath, nextPath] = process.argv.slice(2);
assert.ok(previousPath && nextPath, "Usage: measure-windows-delta.mjs OLD.blockmap NEW.blockmap");

async function readBlockmap(path) {
  const map = JSON.parse(gunzipSync(await readFile(path)));
  assert.equal(map.version, "2");
  assert.ok(Array.isArray(map.files) && map.files.length > 0);
  return map.files;
}

const [previous, next] = await Promise.all([readBlockmap(previousPath), readBlockmap(nextPath)]);
const oldFiles = new Map(previous.map((file) => [file.name, file]));
let installerBytes = 0;
let changedBytes = 0;
for (const file of next) {
  const old = oldFiles.get(file.name);
  const oldBlocks = new Set(old?.checksums.map((checksum, index) => `${checksum}:${old.sizes[index]}`));
  assert.equal(file.sizes.length, file.checksums.length);
  for (const [index, size] of file.sizes.entries()) {
    assert.ok(Number.isSafeInteger(size) && size > 0);
    installerBytes += size;
    if (!oldBlocks.has(`${file.checksums[index]}:${size}`)) changedBytes += size;
  }
}
assert.ok(installerBytes > 0);
console.log(JSON.stringify({ installerBytes, estimatedChangedBytes: changedBytes }));
