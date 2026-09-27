import "./setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

type MatcherValue = unknown;

function createMatchers(actual: MatcherValue, negate: boolean) {
  const run = (assertion: () => void) => {
    if (!negate) {
      assertion();
      return;
    }

    assert.throws(assertion);
  };

  return {
    toBe(expected: MatcherValue) {
      run(() => assert.strictEqual(actual, expected));
    },

    toEqual(expected: MatcherValue) {
      run(() => assert.deepStrictEqual(actual, expected));
    },

    toMatch(expected: RegExp | string) {
      const expression =
        expected instanceof RegExp ? expected : new RegExp(expected);

      run(() => assert.match(String(actual), expression));
    },

    toContain(expected: MatcherValue) {
      run(() => {
        if (typeof actual === "string") {
          assert.ok(actual.includes(String(expected)));
          return;
        }

        if (Array.isArray(actual)) {
          assert.ok(actual.includes(expected));
          return;
        }

        assert.fail("toContain requires a string or array");
      });
    },

    toBeTruthy() {
      run(() => assert.ok(actual));
    },

    toBeFalsy() {
      run(() => assert.ok(!actual));
    },

    toBeDefined() {
      run(() => assert.notStrictEqual(actual, undefined));
    },

    toBeUndefined() {
      run(() => assert.strictEqual(actual, undefined));
    },

    toBeNull() {
      run(() => assert.strictEqual(actual, null));
    },

    toHaveLength(expected: number) {
      run(() => {
        assert.ok(actual !== null && actual !== undefined);
        assert.strictEqual(
          (actual as { length?: unknown }).length,
          expected
        );
      });
    },

    toBeGreaterThan(expected: number) {
      run(() => assert.ok(Number(actual) > expected));
    },

    toBeGreaterThanOrEqual(expected: number) {
      run(() => assert.ok(Number(actual) >= expected));
    },

    toBeLessThan(expected: number) {
      run(() => assert.ok(Number(actual) < expected));
    },

    toBeLessThanOrEqual(expected: number) {
      run(() => assert.ok(Number(actual) <= expected));
    },
  };
}

function expect(actual: MatcherValue) {
  return {
    ...createMatchers(actual, false),
    not: createMatchers(actual, true),
  };
}

import {
  createRefreshCredential,
  hashPassword,
  parseRefreshToken,
  refreshHashMatches,
  signAccessToken,
  verifyAccessToken,
  verifyPassword
} from "../src/security.js";

describe("password security", () => {
  test("stores and verifies an Argon2id password hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(
      await verifyPassword(hash, "correct-horse-battery-staple")
    ).toBe(true);
    expect(
      await verifyPassword(hash, "wrong-password")
    ).toBe(false);
  });
});

describe("refresh credentials", () => {
  test("stores only a stable hash and rejects another token", () => {
    const first = createRefreshCredential();
    const second = createRefreshCredential();

    expect(first.hash).not.toContain(first.token);
    expect(refreshHashMatches(first.token, first.hash)).toBe(true);
    expect(refreshHashMatches(second.token, first.hash)).toBe(false);
    expect(parseRefreshToken(first.token).sessionId)
      .toBe(first.sessionId);
  });
});

describe("access tokens", () => {
  test("round-trips required session and device claims", async () => {
    const claims = {
      sub: "11111111-1111-4111-8111-111111111111",
      sid: "22222222-2222-4222-8222-222222222222",
      did: "33333333-3333-4333-8333-333333333333",
      role: "user",
      auth_version: 1
    };

    const token = await signAccessToken(claims);
    const decoded = await verifyAccessToken(token);

    expect(decoded).toEqual(claims);
  });
});
