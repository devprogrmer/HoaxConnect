# Bilingual Game Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a fully English/Persian Windows UI and a local-first game library that makes every detected game selectable while accepting safe catalog updates from the Backend.

**Architecture:** A typed renderer localization provider controls language, direction and persistence. Windows launcher scanners produce authoritative installed entries, while a validated and cached Backend manifest enriches a built-in catalog without controlling executable selection.

**Tech Stack:** React 19, TypeScript, Electron CommonJS main/preload, Node test runner, Fastify, PostgreSQL, Zod.

**Spec:** `docs/superpowers/specs/2026-11-25-bilingual-game-catalog-design.md`

## Global Constraints

- Windows only; preserve the privileged selected-only tunnel boundary.
- Never send the installed-application inventory to the Backend.
- Never copy ExitLag private APIs, dumps, binaries or bundled artwork.
- English is the fallback for missing Persian game names.
- Remote catalog failure must not block local discovery or routing.
- Every implementation task follows red-green TDD and ends in a focused commit.

## Review Focus

- Corrupt persisted locale falls back to English; Task 1 tests it.
- Missing translation keys fail parity tests; Task 1 tests it.
- Steam libraries outside the default folder and escaped VDF strings; Task 3 tests them.
- Invalid, duplicate or oversized remote catalog entries are rejected; Task 4 tests them.
- Unknown locally installed games remain selectable without catalog metadata; Task 5 tests it.

---

### Task 1: Typed localization foundation

**Files:**
- Create: `src/locales/en.ts`
- Create: `src/locales/fa.ts`
- Create: `src/i18n.tsx`
- Create: `scripts/tests/i18n.test.mjs`
- Modify: `src/main.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces: `LocaleProvider`, `useI18n(): { locale, direction, t, setLocale }`, and `TranslationKey` inferred from English keys.

- [ ] **Step 1: Write failing locale tests**

Assert English/Persian key parity, interpolation, `fa => rtl`, `en => ltr`, and invalid persisted locale fallback.

- [ ] **Step 2: Verify the tests fail**

Run: `node --test scripts/tests/i18n.test.mjs`
Expected: FAIL because locale modules do not exist.

- [ ] **Step 3: Implement dictionaries and provider**

Persist only `en|fa` at `hoaxconnect.locale`, otherwise detect `fa*` from the
host locale, set document `lang`/`dir`, and fall back to English for optional
game-name translations.

- [ ] **Step 4: Run locale and UI builds**

Run: `node --test scripts/tests/i18n.test.mjs && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: add English and Persian localization foundation`

### Task 2: Translate every renderer-owned screen

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/SplitTunnel.tsx`
- Modify: `src/NetworkDoctor.tsx`
- Modify: `src/DeviceReportingSettings.tsx`
- Modify: `src/App.css`
- Modify: `src/SplitTunnel.css`
- Modify: `scripts/tests/i18n.test.mjs`

**Interfaces:**
- Consumes: `useI18n` and translation keys from Task 1.
- Produces: language switcher on auth and Settings; renderer text with no unmanaged English UI copy.

- [ ] **Step 1: Extend the failing test to scan renderer components**

Assert the four screens import `useI18n`, language controls exist on
auth/Settings, `document.dir` styles use logical properties for navigation and
forms, and a narrow allowlist rejects newly hardcoded renderer-visible copy.

- [ ] **Step 2: Verify the renderer-copy test fails**

Run: `node --test scripts/tests/i18n.test.mjs`
Expected: FAIL listing untranslated screens.

- [ ] **Step 3: Replace renderer-owned copy with translation keys**

Translate navigation, auth, dashboard, routes, Games & Apps, diagnostics, settings, subscription, statuses, errors and empty states. Preserve official game/product names.

- [ ] **Step 4: Add RTL layout rules and verify both directions**

Run: `npm run lint && npm run build && node --test scripts/tests/i18n.test.mjs`
Expected: PASS with no horizontal overflow selectors using physical left/right where direction matters.

- [ ] **Step 5: Commit**

Commit: `feat: localize the Windows client in Persian and English`

### Task 3: Steam and Epic installed-game discovery

**Files:**
- Create: `electron/launcher-scanner.cjs`
- Create: `electron/tests/launcher-scanner.test.cjs`
- Modify: `electron/app-scanner.cjs`
- Modify: `src/electron.d.ts`

**Interfaces:**
- Produces: `scanSteamLibraries(options)`, `scanEpicManifests(options)`, and merged `HoaxInstalledApp` records with `source`, `launcherId`, exact EXE path and optional icon.

- [ ] **Step 1: Write fixture-driven failing tests**

Cover a secondary Steam library, multiple `appmanifest_*.acf` files, escaped
names, Epic `.item` manifests, duplicates, malformed manifests, excluded helper
executables, ambiguous executable choices and registry `InstallLocation` roots.

- [ ] **Step 2: Verify tests fail**

Run: `node --test electron/tests/launcher-scanner.test.cjs`
Expected: FAIL because launcher scanner does not exist.

- [ ] **Step 3: Implement pure parsers and filesystem scanners**

Keep parsing independent of `process.platform`; pass roots/filesystem adapters
in tests and use Windows defaults only in production. Scan Steam installs to
depth three, prefer Epic `LaunchExecutable`, and preserve multiple plausible
executables for user choice.

- [ ] **Step 4: Merge launcher and generic Windows results**

Deduplicate by normalized executable path, prefer launcher display names,
retain unknown generic/running EXEs, inspect `InstallLocation` one level deep,
and cap the final list at 2,000 entries.

- [ ] **Step 5: Run Electron tests**

Run: `npm run test:electron`
Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `feat: discover installed Steam and Epic games`

### Task 4: Versioned Backend game catalog

**Files:**
- Create: `backend/migrations/007_game_catalog.sql`
- Create: `backend/src/catalog-routes.ts`
- Create: `backend/tests/game-catalog.integration.test.ts`
- Modify: `backend/src/app.ts`
- Create: `electron/catalog-api.cjs`
- Create: `electron/tests/catalog-api.test.cjs`
- Modify: `electron/auth/auth-owner.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Modify: `src/electron.d.ts`

**Interfaces:**
- Produces: authenticated `POST /api/v1/catalog/games` returning `{ version, entries }`; Electron `catalog.games()` returning validated entries and a last-valid cache.

- [ ] **Step 1: Write failing Backend integration tests**

Assert enabled-only ordering, monotonic version/ETag, English required, Persian
optional, executable normalization, no endpoint secrets, and a 5,000-entry/5-MB
response ceiling. Assert audited admin import validates and soft-disables entries.

- [ ] **Step 2: Verify Backend tests fail**

Run: Backend PostgreSQL integration command used by `.github/workflows/windows.yml`.
Expected: FAIL because migration and route do not exist.

- [ ] **Step 3: Add schema, seed and authenticated route**

Store stable slug, localized names, platform, launcher ID, executable names,
artwork URL/source/license fields, enabled state and timestamps. Add an audited
permission-guarded admin import endpoint; remote text is plain text and artwork
is restricted to approved HTTPS sources.

- [ ] **Step 4: Write failing Electron validation/cache tests**

Assert valid merge input, duplicate slug rejection, artwork host allowlisting,
oversized response and version-downgrade rejection, 24-hour refresh behavior,
and fallback to the last valid cache.

- [ ] **Step 5: Implement catalog API and main/preload bridge**

Cache validated JSON atomically at `catalog/game-catalog-v1.json` under Electron
user data; never cache access tokens or installed-app inventory. Permit a stale
valid cache offline and enforce a 5-MB read/write ceiling.

- [ ] **Step 6: Run Backend and Electron tests**

Run: `npm run test:electron` plus the isolated PostgreSQL suite.
Expected: PASS.

- [ ] **Step 7: Commit**

Commit: `feat: add versioned game catalog delivery`

### Task 5: Merge catalog with installed library and release

**Files:**
- Refactor: `src/game-catalog.ts` to `src/catalog/builtin.ts`
- Create: `src/catalog/merge.ts`
- Create: `scripts/tests/game-library.test.mjs`
- Modify: `src/SplitTunnel.tsx`
- Modify: `src/SplitTunnel.css`
- Modify: `scripts/tests/real-vpn-ui.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/product/stage-2c-handoff.md`

**Interfaces:**
- Consumes: installed launcher records and validated remote entries.
- Produces: installed-first localized game/app sections and exact executable selections for existing split-tunnel persistence.

- [ ] **Step 1: Write failing merge and UI contract tests**

Assert remote-over-seed merge by slug, installed-over-catalog executable truth,
unknown installed game selection, ambiguous executable choice, Persian search,
artwork fallback, selected/running/installed/not-installed priority, missing
selected-path blocking and no inventory upload.

- [ ] **Step 2: Verify tests fail**

Run: `node --test scripts/tests/game-library.test.mjs scripts/tests/real-vpn-ui.test.mjs`
Expected: FAIL before merge implementation.

- [ ] **Step 3: Implement merge and Games & Apps UI**

Render installed games first with exact paths, then installed apps, then non-installed catalog entries. Use local icon first, permitted HTTPS artwork second and branded fallback last.

- [ ] **Step 4: Bump the release candidate and update handoff**

Set the next patch version consistently in `package.json` and `package-lock.json`; document catalog sources, privacy boundary and remaining real-device checks.

- [ ] **Step 5: Run all repository checks in GitHub Actions**

Expected: Backend, Electron, UI, launcher fixtures, localization parity, Windows service, installer smoke and post-bridge delta gate all PASS.

- [ ] **Step 6: Commit and push**

Commit: `release: bilingual Windows game library candidate`
