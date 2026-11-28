import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9+/]{43}=$/;
const x25519Prefix = Buffer.from("302e020100300506032b656e04220420", "hex");

export async function ensureRouteLinkKey(stateDir: string, groupId: string): Promise<string> {
  if (!uuid.test(groupId)) throw new Error("Invalid route group ID");
  const dir = join(stateDir, "route-keys");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${groupId}.key`);
  let privateKey: string;
  try {
    const { privateKey: pair } = generateKeyPairSync("x25519");
    privateKey = (pair.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32).toString("base64");
    await writeFile(path, `${privateKey}\n`, { flag: "wx", mode: 0o600 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe route key file");
    privateKey = (await readFile(path, "utf8")).trim();
  }
  if (!keyPattern.test(privateKey) || Buffer.from(privateKey, "base64").length !== 32) {
    throw new Error("Invalid route link private key");
  }
  await chmod(path, 0o600);
  const pkcs8 = Buffer.concat([x25519Prefix, Buffer.from(privateKey, "base64")]);
  const publicKey = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }))
    .export({ type: "spki", format: "der" }) as Buffer;
  return publicKey.subarray(-32).toString("base64");
}
