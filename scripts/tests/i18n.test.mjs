import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  directionForLocale,
  interpolate,
  resolveInitialLocale,
} from "../../src/i18n-core.mjs";

const enSource = await readFile(
  new URL("../../src/locales/en.ts", import.meta.url),
  "utf8",
);
const faSource = await readFile(
  new URL("../../src/locales/fa.ts", import.meta.url),
  "utf8",
);

function translationKeys(source) {
  return [...source.matchAll(/^\s{2}"([^"]+)":/gm)]
    .map((match) => match[1])
    .sort();
}

test("English and Persian dictionaries have identical keys", () => {
  assert.deepEqual(translationKeys(faSource), translationKeys(enSource));
  assert.ok(translationKeys(enSource).length >= 12);
});

test("locale direction follows English and Persian", () => {
  assert.equal(directionForLocale("en"), "ltr");
  assert.equal(directionForLocale("fa"), "rtl");
});

test("persisted locale wins and invalid values fall back to host locale", () => {
  assert.equal(resolveInitialLocale("fa", "en-US"), "fa");
  assert.equal(resolveInitialLocale("broken", "fa-IR"), "fa");
  assert.equal(resolveInitialLocale(null, "de-DE"), "en");
});

test("translation parameters interpolate without evaluating markup", () => {
  assert.equal(
    interpolate("Hello, {name}. Version {version}", {
      name: "<Amir>",
      version: 4,
    }),
    "Hello, <Amir>. Version 4",
  );
});
