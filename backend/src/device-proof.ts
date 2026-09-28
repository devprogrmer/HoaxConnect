import {
  createPublicKey,
  verify,
} from "node:crypto";

export interface DeviceProofPayloadInput {
  version: number;
  challengeId: string;
  purpose: string;
  nonce: string;
  userId: string;
  deviceUid: string;
  keyFingerprint: string;
  issuedAt: string;
  expiresAt: string;
}

export interface VerifyDeviceProofInput {
  publicKeySpki: string;
  payload: Buffer;
  signature: string;
}

export function canonicalDeviceProofPayload(
  input: DeviceProofPayloadInput
): Buffer {
  const fields = [
    ["version", String(input.version)],
    ["challenge_id", input.challengeId],
    ["purpose", input.purpose],
    ["nonce", input.nonce],
    ["user_id", input.userId],
    ["device_uid", input.deviceUid],
    ["key_fingerprint", input.keyFingerprint],
    ["issued_at", input.issuedAt],
    ["expires_at", input.expiresAt],
  ];

  const encoded = fields
    .map(([name, value]) => {
      const content = value ?? "";
      return `${name}:${Buffer.byteLength(content, "utf8")}:${content}`;
    })
    .join("\n");

  return Buffer.from(
    `hoaxconnect-device-proof-v1\n${encoded}`,
    "utf8"
  );
}

export function verifyDeviceProof(
  input: VerifyDeviceProofInput
): boolean {
  try {
    const publicKey = createPublicKey(
      input.publicKeySpki
    );

    if (publicKey.asymmetricKeyType !== "ed25519") {
      return false;
    }

    const signature = Buffer.from(
      input.signature,
      "base64url"
    );

    if (signature.length !== 64) {
      return false;
    }

    return verify(
      null,
      input.payload,
      publicKey,
      signature
    );
  } catch {
    return false;
  }
}
