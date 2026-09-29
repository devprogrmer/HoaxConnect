import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { config } from "./config.js";

export interface RefreshRecoveryBinding {
  recoveryId: string;
  sessionFamilyId: string;
  previousSessionId: string;
  replacementSessionId: string;
  deviceId: string;
}

type EncryptedEnvelope = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

function recoveryAad(
  binding: RefreshRecoveryBinding
): Buffer {
  return Buffer.from(
    [
      "hoaxconnect-refresh-recovery-v1",
      binding.recoveryId,
      binding.sessionFamilyId,
      binding.previousSessionId,
      binding.replacementSessionId,
      binding.deviceId,
    ].join("\n"),
    "utf8"
  );
}

export function hashRecoverySecret(
  recoverySecret: string
): string {
  return createHash("sha256")
    .update(recoverySecret, "utf8")
    .digest("hex");
}

export function recoverySecretMatches(
  expectedHash: string,
  recoverySecret: string
): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(
    hashRecoverySecret(recoverySecret),
    "hex"
  );

  return (
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}

export function encryptRecoveryResponse(
  binding: RefreshRecoveryBinding,
  response: unknown
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    config.refreshRecoveryEncryptionKey,
    iv
  );

  cipher.setAAD(recoveryAad(binding));

  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify(response),
      "utf8"
    ),
    cipher.final(),
  ]);

  const envelope: EncryptedEnvelope = {
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };

  return Buffer.from(
    JSON.stringify(envelope),
    "utf8"
  );
}

export function decryptRecoveryResponse<T>(
  binding: RefreshRecoveryBinding,
  encrypted: Buffer
): T {
  const envelope = JSON.parse(
    encrypted.toString("utf8")
  ) as EncryptedEnvelope;

  if (
    envelope.version !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Invalid recovery envelope");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    config.refreshRecoveryEncryptionKey,
    Buffer.from(envelope.iv, "base64url")
  );

  decipher.setAAD(recoveryAad(binding));
  decipher.setAuthTag(
    Buffer.from(envelope.tag, "base64url")
  );

  const plaintext = Buffer.concat([
    decipher.update(
      Buffer.from(
        envelope.ciphertext,
        "base64url"
      )
    ),
    decipher.final(),
  ]);

  return JSON.parse(
    plaintext.toString("utf8")
  ) as T;
}
