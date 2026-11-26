import { loadConfig } from "./config.js";
import { ControlClient } from "./control-client.js";
import { loadOrEnrollIdentity } from "./identity.js";
import { Reconciler } from "./reconciler.js";
import { LinuxWireGuardAdapter } from "./wireguard.js";

const agentVersion = "0.1.0";
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function run() {
  const config = loadConfig();
  if (config.dryRun) {
    process.stdout.write(`VPN_AGENT_CONFIG_VALID node=${config.nodeId} interface=${config.interface.name}\n`);
    return;
  }
  const identity = await loadOrEnrollIdentity(config);
  const client = new ControlClient({
    backendUrl: config.backendUrl, nodeId: config.nodeId,
    credentialId: identity.credentialId, privateKey: identity.privateKey,
    maxAttempts: 1,
  });
  const adapter = new LinuxWireGuardAdapter(config.interface.name);
  const reconciler = new Reconciler(adapter, config.interface, config.managedPeersPath);
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  let failures = 0;
  while (!stopping) {
    try {
      await reconciler.expireLeases();
      const desired = await client.desiredState();
      await reconciler.reconcile(desired.peers);
      const snapshot = await adapter.snapshot();
      await client.heartbeat({
        agentVersion, publicEndpoint: config.publicEndpoint, publicKey: snapshot.publicKey,
        capacityPeers: config.capacityPeers, currentPeers: snapshot.currentPeers, loadPercent: 0,
      });
      process.stdout.write(`${JSON.stringify({ event: "reconciled", peers: snapshot.currentPeers,
        config_version: desired.configVersion })}\n`);
      failures = 0;
      await delay(config.intervalMs);
    } catch (error) {
      failures += 1;
      await reconciler.expireLeases().catch((expiryError) => {
        process.stderr.write(`${JSON.stringify({ event: "lease_expiry_failed",
          error: expiryError instanceof Error ? expiryError.message : "unknown error" })}\n`);
      });
      process.stderr.write(`${JSON.stringify({ event: "reconcile_failed",
        error: error instanceof Error ? error.message : "unknown error" })}\n`);
      await delay(Math.min(config.intervalMs * (2 ** Math.min(failures - 1, 4)), 5_000));
    }
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "VPN agent failed"}\n`);
  process.exitCode = 1;
});

