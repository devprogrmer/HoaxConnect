import { readFile } from "node:fs/promises";
import { measurePath, openPathProbeResponder } from "./path-probe.js";

async function run() {
  const [mode, sourceAddress, portText, destinationAddress] = process.argv.slice(2);
  const port = Number(portText);
  const keyFile = process.env.HC_PATH_PROBE_KEY_FILE;
  if (!sourceAddress || !keyFile || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Set HC_PATH_PROBE_KEY_FILE and pass an explicit source IPv4 address and port");
  }
  const key = await readFile(keyFile);
  if (mode === "respond" && destinationAddress === undefined) {
    const socket = await openPathProbeResponder(sourceAddress, port, key);
    const close = () => socket.close();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    socket.once("close", () => {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
    });
    console.log(JSON.stringify({ event: "path_probe_listening", address: sourceAddress, port }));
    return;
  }
  if (mode === "measure" && destinationAddress) {
    const samples = await measurePath({
      sourceAddress, destinationAddress, destinationPort: port, key,
    });
    const received = samples.filter((sample) => sample !== null).length;
    console.log(JSON.stringify({
      sourceAddress, destinationAddress, samples, lossPercent: 100 * (samples.length - received) / samples.length,
    }));
    return;
  }
  throw new Error("Usage: respond <bind-ip> <port> | measure <source-ip> <port> <destination-ip>");
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Path probe failed");
  process.exitCode = 1;
});
