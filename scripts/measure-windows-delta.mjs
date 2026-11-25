import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const [previousPath, nextPath, maximumChangedBytesInput] = process.argv.slice(2);
assert.ok(
  previousPath && nextPath,
  "Usage: measure-windows-delta.mjs OLD.blockmap NEW.blockmap [MAX_CHANGED_BYTES]",
);

const maximumChangedBytes = maximumChangedBytesInput
  ? Number(maximumChangedBytesInput)
  : null;
if (maximumChangedBytes !== null) {
  assert.ok(
    Number.isSafeInteger(maximumChangedBytes) && maximumChangedBytes > 0,
    "MAX_CHANGED_BYTES must be a positive safe integer",
  );
}

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
if (maximumChangedBytes !== null) {
  assert.ok(
    changedBytes <= maximumChangedBytes,
    `Windows update delta is ${changedBytes} bytes; maximum allowed is ${maximumChangedBytes} bytes`,
  );
}
