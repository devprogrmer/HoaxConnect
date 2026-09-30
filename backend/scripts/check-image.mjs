import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux", "Run this check inside the API image.");
assert.notEqual(process.getuid(), 0, "The API image must run as a non-root user.");

const root = fileURLToPath(new URL("../", import.meta.url));
let files = 0;

async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkDirectory(location);
    } else {
      await readFile(location);
      files += 1;
    }
  }
}

await readFile(path.join(root, "package.json"));
for (const directory of ["dist", "migrations", "scripts"]) {
  await checkDirectory(path.join(root, directory));
}
for (const dependency of ["fastify", "pg", "argon2", "jose", "zod"]) {
  await import(dependency);
}
console.log(`IMAGE_RUNTIME_READ_CHECK_PASSED uid=${process.getuid()} files=${files}`);
