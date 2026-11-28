import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_PERMISSIONS,
  adminCookie,
  constantTimeSecretMatches,
  createAdminSessionSecrets,
  decryptProviderCredentials,
  encryptProviderCredentials,
  hasAdminPermission,
  maskProviderValue,
} from "../src/admin-security.js";

test("Admin roles follow the Stage 2D least-privilege matrix", () => {
  const grants = {
    superadmin: [...ADMIN_PERMISSIONS],
    admin: [
      "dashboard.read", "users.read", "users.detail", "users.recover",
      "users.suspend", "users.ban", "devices.read", "devices.revoke",
      "devices.ban", "sessions.read", "sessions.revoke", "plans.read",
      "plans.write", "subscriptions.read", "subscriptions.write",
      "subscriptions.traffic", "nodes.read", "nodes.write", "payments.read",
      "sms.status.read", "audit.read", "providers.status.read",
      "telemetry.read",
    ],
    support: [
      "dashboard.read", "users.read", "users.detail", "users.recover",
      "devices.read", "devices.revoke", "sessions.read", "sessions.revoke",
      "subscriptions.read", "payments.read",
    ],
    read_only: [
      "dashboard.read", "users.read", "users.detail", "devices.read",
      "sessions.read", "plans.read", "subscriptions.read", "nodes.read",
      "payments.read", "providers.status.read", "sms.status.read",
    ],
  } as const;

  for (const [role, expected] of Object.entries(grants) as Array<[
    keyof typeof grants,
    readonly string[],
  ]>) {
    for (const permission of ADMIN_PERMISSIONS) {
      assert.equal(
        hasAdminPermission(role, permission),
        expected.includes(permission),
        `${role} grant for ${permission}`,
      );
    }
  }
});

test("Admin session and CSRF secrets are random and stored only as hashes", () => {
  const first = createAdminSessionSecrets();
  const second = createAdminSessionSecrets();

  assert.notEqual(first.sessionToken, second.sessionToken);
  assert.notEqual(first.csrfToken, second.csrfToken);
  assert.notEqual(first.sessionToken, first.sessionTokenHash);
  assert.notEqual(first.csrfToken, first.csrfTokenHash);
  assert.equal(
    constantTimeSecretMatches(first.csrfToken, first.csrfTokenHash),
    true
  );
  assert.equal(
    constantTimeSecretMatches("wrong-token", first.csrfTokenHash),
    false
  );
});

test("Admin cookies are HttpOnly, SameSite strict, scoped, and secure in production", () => {
  const cookie = adminCookie("session-value", 3600, true);

  assert.match(cookie, /^hc_admin_session=session-value;/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Path=\/api\/v1\/admin/);
  assert.match(cookie, /; Max-Age=3600; Secure$/);
});

test("provider credentials are authenticated ciphertext and tampering fails", () => {
  const key = Buffer.alloc(32, 23);
  const credentials = {
    apiKey: "secret-value",
    sender: "HoaxConnect",
  };
  const encrypted = encryptProviderCredentials(credentials, key);

  assert.equal(
    encrypted.ciphertext.includes(Buffer.from("secret-value")),
    false
  );
  assert.deepEqual(
    decryptProviderCredentials(encrypted, key),
    credentials
  );

  const tampered = {
    ...encrypted,
    ciphertext: Buffer.from(encrypted.ciphertext),
  };
  tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff;

  assert.throws(
    () => decryptProviderCredentials(tampered, key),
    /Unsupported state or unable to authenticate data/
  );
});

test("masked provider metadata never reveals short credentials", () => {
  assert.equal(maskProviderValue("x"), "****");
  assert.equal(maskProviderValue("1234"), "****");
  assert.equal(maskProviderValue("long-secret"), "****cret");
});
