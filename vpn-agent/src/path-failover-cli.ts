import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { PathFailover } from "./path-failover.js";
import { measurePath } from "./path-probe.js";

const exec = promisify(execFile);

async function run() {
  const [endpoint, table, source, primaryGateway, primaryDevice, primaryProbe,
    relayGateway, relayDevice, relayProbe, portText] = process.argv.slice(2);
  const keyFile = process.env.HC_PATH_PROBE_KEY_FILE;
  const port = Number(portText);
  if (!endpoint || !source || !primaryGateway || !primaryProbe || !relayGateway || !relayProbe ||
      ![endpoint, source, primaryGateway, primaryProbe, relayGateway, relayProbe].every(isIPv4) ||
      new Set([endpoint, primaryProbe, relayProbe]).size !== 3 ||
      !table || !/^\d{1,9}$/.test(table) || Number(table) < 256 ||
      !primaryDevice || !relayDevice ||
      ![primaryDevice, relayDevice].every((device) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/.test(device)) ||
      !keyFile || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Usage: <endpoint-ip> <dedicated-table> <source-ip> <primary-gateway> <primary-dev> <primary-probe-ip> <relay-gateway> <relay-dev> <relay-probe-ip> <probe-port>; set HC_PATH_PROBE_KEY_FILE");
  }

  const key = await readFile(keyFile);
  if (key.length !== 32) throw new Error("Path probes require a 32-byte key");
  const routes = {
    primary: { gateway: primaryGateway, device: primaryDevice, probe: primaryProbe },
    relay: { gateway: relayGateway, device: relayDevice, probe: relayProbe },
  };
  const replace = async (path: keyof typeof routes) => {
    const { gateway, device } = routes[path];
    await exec("ip", ["-4", "route", "replace", `${endpoint}/32`, "via", gateway,
      "dev", device, "src", source, "table", table], { timeout: 2_000 });
    console.log(JSON.stringify({ event: "path_selected", path, endpoint }));
  };
  const sample = async (destinationAddress: string) => {
    const samples = await measurePath({ sourceAddress: source, destinationAddress, destinationPort: port, key });
    return { lossPercent: 100 * samples.filter((value) => value === null).length / samples.length };
  };

  const measureBoth = async () => {
    const [primary, relay] = await Promise.allSettled([sample(primaryProbe), sample(relayProbe)]);
    if (primary.status === "rejected") throw primary.reason;
    if (relay.status === "rejected") throw relay.reason;
    return [primary.value, relay.value] as const;
  };

  // Complete both probe attempts before touching the managed endpoint route.
  await measureBoth();
  await replace("primary");
  const controller = new PathFailover(replace);
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });

  while (!stopping) {
    try {
      const [primary, relay] = await measureBoth();
      await controller.observe(primary, relay);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Path failover round failed");
    }
    if (!stopping) await delay(500);
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Path controller failed");
  process.exitCode = 1;
});
