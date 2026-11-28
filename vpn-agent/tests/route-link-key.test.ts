import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureRouteLinkKey } from "../src/route-link-key.js";

test("route link private material stays on the agent and remains stable across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-route-keys-"));
  try {
    const groupId = randomUUID();
    const first = await ensureRouteLinkKey(root, groupId);
    const second = await ensureRouteLinkKey(root, groupId);
    assert.equal(first, second);
    assert.match(first, /^[A-Za-z0-9+/]{43}=$/);
    const path = join(root, "route-keys", `${groupId}.key`);
    const secret = (await readFile(path, "utf8")).trim();
    assert.notEqual(first, secret);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(root, "route-keys"))).mode & 0o777, 0o700);
    const other = await ensureRouteLinkKey(root, randomUUID());
    assert.notEqual(other, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("route key loader rejects substituted symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-route-symlink-"));
  try {
    const id = randomUUID();
    await ensureRouteLinkKey(root, randomUUID());
    const target = join(root, "secret");
    await writeFile(target, "A".repeat(43) + "=");
    await symlink(target, join(root, "route-keys", `${id}.key`));
    await assert.rejects(ensureRouteLinkKey(root, id), /Unsafe route key file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
