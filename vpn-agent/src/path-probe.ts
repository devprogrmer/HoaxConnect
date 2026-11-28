import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import { performance } from "node:perf_hooks";

const nonceSize = 16;
const packetSize = nonceSize + 32;

function tag(key: Buffer, direction: "request" | "response", nonce: Buffer) {
  return createHmac("sha256", key).update(`hoaxconnect-path-v1:${direction}:`).update(nonce).digest();
}

function bind(socket: Socket, address: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, address, () => {
      socket.removeListener("error", reject);
      resolve();
    });
  });
}

function validateAddress(address: string, key: Buffer) {
  if (!isIPv4(address) || address === "0.0.0.0" || key.length !== 32) {
    throw new Error("Path probes require an explicit IPv4 address and a 32-byte key");
  }
}

export async function openPathProbeResponder(address: string, port: number, key: Buffer) {
  validateAddress(address, key);
  const socket = createSocket("udp4");
  socket.on("message", (packet, peer) => {
    if (packet.length !== packetSize) return;
    const nonce = packet.subarray(0, nonceSize);
    if (!timingSafeEqual(packet.subarray(nonceSize), tag(key, "request", nonce))) return;
    const response = Buffer.concat([nonce, tag(key, "response", nonce)]);
    socket.send(response, peer.port, peer.address, () => {});
  });
  await bind(socket, address, port);
  return socket;
}

export interface PathProbeOptions {
  sourceAddress: string;
  destinationAddress: string;
  destinationPort: number;
  key: Buffer;
  count?: number;
  timeoutMs?: number;
}

export async function measurePath({
  sourceAddress,
  destinationAddress,
  destinationPort,
  key,
  count = 5,
  timeoutMs = 500,
}: PathProbeOptions): Promise<(number | null)[]> {
  validateAddress(sourceAddress, key);
  validateAddress(destinationAddress, key);
  if (!Number.isInteger(count) || count < 1 || count > 20 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5_000 ||
      !Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65_535) {
    throw new Error("Invalid path probe bounds");
  }

  const socket = createSocket("udp4");
  try {
    await bind(socket, sourceAddress, 0);
    const samples: (number | null)[] = [];
    for (let index = 0; index < count; index += 1) {
      samples.push(await new Promise<number | null>((resolve, reject) => {
        const nonce = randomBytes(nonceSize);
        const request = Buffer.concat([nonce, tag(key, "request", nonce)]);
        const expected = Buffer.concat([nonce, tag(key, "response", nonce)]);
        const started = performance.now();
        const timer = setTimeout(() => complete(null), timeoutMs);

        function cleanup() {
          clearTimeout(timer);
          socket.off("message", receive);
          socket.off("error", fail);
        }

        function complete(sample: number | null) {
          cleanup();
          resolve(sample);
        }

        function fail(error: Error) {
          cleanup();
          reject(error);
        }

        function receive(packet: Buffer, peer: { address: string; port: number }) {
          if (peer.address === destinationAddress && peer.port === destinationPort &&
              packet.length === expected.length && timingSafeEqual(packet, expected)) {
            complete(performance.now() - started);
          }
        }

        socket.on("message", receive);
        socket.once("error", fail);
        socket.send(request, destinationPort, destinationAddress, (error) => {
          if (error) fail(error);
        });
      }));
    }
    return samples;
  } finally {
    socket.close();
  }
}
