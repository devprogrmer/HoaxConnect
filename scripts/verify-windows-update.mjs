import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import yaml from "js-yaml";

const [directory, version] = process.argv.slice(2);
assert.ok(directory && /^\d+\.\d+\.\d+$/.test(version || ""), "Usage: node scripts/verify-windows-update.mjs DIRECTORY VERSION");

const root = resolve(directory);
const filename = `HoaxConnect-${version}-Setup.exe`;
const manifest = yaml.load(readFileSync(join(root, "latest.yml"), "utf8"));
assert.equal(manifest?.version, version);
assert.equal(manifest?.path, filename);
assert.equal(manifest?.files?.length, 1);
assert.equal(manifest.files[0].url, filename);
assert.equal(manifest.files[0].sha512, manifest.sha512);
assert.match(manifest.sha512, /^[A-Za-z0-9+/]{86}==$/);

const installer = join(root, filename);
const size = statSync(installer).size;
assert.ok(size > 1_000_000, "Installer is unexpectedly small");
assert.equal(manifest.files[0].size, size);

const digest = createHash("sha512");
for await (const chunk of createReadStream(installer)) digest.update(chunk);
assert.equal(digest.digest("base64"), manifest.sha512);

const blockmap = JSON.parse(gunzipSync(readFileSync(`${installer}.blockmap`)).toString("utf8"));
assert.equal(blockmap.version, "2");
assert.ok(Array.isArray(blockmap.files) && blockmap.files.length > 0);

console.log(`UPDATE_ARTIFACTS_VERIFIED version=${version} bytes=${size}`);
