import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { MultiPathSelector, scorePath, type PathSamples } from "./multi-path-selector.js";
import { measurePath } from "./path-probe.js";

const exec = promisify(execFile);
type Route = { id: string; gateway: string; device: string; probe: string };
type Config = { endpoint: string; table: number; source: string; port: number; paths: Route[] };

export function parsePathConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid route configuration");
  const config = value as Record<string, unknown>;
  const paths = config.paths;
  if (!isIPv4(config.endpoint as string) || !isIPv4(config.source as string) ||
      !Number.isInteger(config.table) || Number(config.table) < 256 || Number(config.table) > 999_999_999 ||
      !Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65_535 ||
      !Array.isArray(paths) || paths.length < 2 || paths.length > 256) {
    throw new Error("Expected endpoint, source, dedicated table, probe port and at least two paths");
  }
  const ids = new Set<string>();
  const probes = new Set<string>();
  for (const path of paths) {
    if (!path || typeof path !== "object" ||
        typeof path.id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(path.id) ||
        typeof path.device !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(path.device) ||
        !isIPv4(path.gateway) || !isIPv4(path.probe) ||
        ids.has(path.id) || probes.has(path.probe) || path.probe === config.endpoint ||
        path.gateway === config.endpoint) throw new Error("Invalid or duplicate path");
    ids.add(path.id); probes.add(path.probe);
  }
  return config as Config;
}

async function run() {
  if (process.argv.length !== 3 || !process.env.HC_PATH_PROBE_KEY_FILE) {
    throw new Error("Usage: HC_PATH_PROBE_KEY_FILE=<private-key-file> multi-path-cli <config-json>");
  }
  const config = parsePathConfig(JSON.parse(await readFile(process.argv[2]!, "utf8")));
  const key = await readFile(process.env.HC_PATH_PROBE_KEY_FILE);
  if (key.length !== 32) throw new Error("Path probes require a 32-byte key");
  const sample = async (path: Route): Promise<PathSamples> => ({
    id: path.id,
    samples: await measurePath({ sourceAddress: config.source,
      destinationAddress: path.probe, destinationPort: config.port,
      key, count: 3, timeoutMs: 150 }),
  });
  const measureAll = async () => Promise.all(config.paths.map(async (path): Promise<PathSamples> => {
    try { return await sample(path); }
    catch { return { id: path.id, samples: [null, null, null] }; }
  }));
  const initial = (await measureAll()).map(scorePath).filter((score) => score.healthy)
    .sort((a, b) => a.score - b.score)[0];
  if (!initial) throw new Error("No healthy route; no endpoint route changed");
  const apply = async (id: string) => {
    const route = config.paths.find((path) => path.id === id)!;
    await exec("ip", ["-4", "route", "replace", `${config.endpoint}/32`, "via", route.gateway,
      "dev", route.device, "src", config.source, "table", String(config.table)], { timeout: 2_000 });
    console.log(JSON.stringify({ event: "route_applied", path: id, endpoint: config.endpoint }));
  };
  await apply(initial.id);
  const selector = new MultiPathSelector({ paths: config.paths.map((path) => path.id),
    initialPath: initial.id, apply });
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  while (!stopping) {
    try {
      const result = await selector.observe(await measureAll());
      console.log(JSON.stringify({ event: "route_observed", path: result.path,
        reason: result.reason, scores: result.scores }));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Route selection failed");
    }
    if (!stopping) await delay(100);
  }
}

if (process.argv[1]?.endsWith("multi-path-cli.js")) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Route controller failed");
    process.exitCode = 1;
  });
}
