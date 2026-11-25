# Bilingual Game Library Design

## Intent

HoaxConnect for Windows must present the complete product UI in English and
Persian and make every game installed on the user's machine selectable for
app-only routing. The library should feel as complete as established gaming
boosters without copying a competitor's proprietary catalog or artwork.

## Goals

- Translate every desktop navigation item, action, status, empty state and
  error owned by the renderer into English and Persian.
- Apply `ltr` for English and `rtl` for Persian, persist the choice locally,
  and switch without restarting.
- Detect installed games from Windows, Steam libraries and Epic manifests;
  retain generic Windows application discovery and manual EXE selection.
- Match discovered executables to a versioned catalog with English/Persian
  display names, launcher metadata and artwork from permitted sources.
- Keep installed games first and selectable; catalog-only games remain visible
  but disabled until detected.
- Allow the catalog to grow through a validated Backend manifest without
  requiring a desktop release.

## Non-goals

- Copying ExitLag binaries, private APIs, catalog dumps or bundled artwork.
- Claiming that a finite seed list contains every game ever released.
- Routing a catalog item that has no verified executable on the machine.
- Translating third-party game names when no established Persian name exists.

## Constraints

- Windows is the only client platform in this release.
- Existing selected-only routing and privileged service boundaries remain
  unchanged.
- Remote artwork is never required for routing and must fail to a local
  fallback without breaking the library.
- Catalog responses are schema-validated, versioned and size-limited before
  caching.
- Persian game names are optional; the official title is the fallback.
- Completeness is measured by installed-game discovery, not by claiming that a
  finite remote list contains every game in existence.

## Exact product decisions

- The initial locale follows the Windows/browser locale (`fa*` selects Persian;
  everything else selects English). A user choice overrides it and is persisted.
- Catalog cache lives under Electron user data at
  `catalog/game-catalog-v1.json`, is written atomically, expires after 24 hours,
  and may be used stale while offline. It is rejected above 5 MB.
- Card state priority is selected, running, installed, then not installed.
- A selected executable that later disappears remains visible as missing; connect
  is blocked until the user removes it or rescans.
- Scanner output is capped at 2,000 deduplicated executable records. Registry
  entries with only `InstallLocation` are inspected one directory level deep.

## Chosen approach

Use a local-first hybrid catalog. Installed-game discovery is authoritative for
what users can select. A built-in curated seed improves presentation offline,
while an authenticated Backend endpoint supplies newer metadata. This is safer
and more complete for the user's machine than cloning a competitor's static
list, and it remains maintainable as new games appear.

Alternatives rejected:

- A copied ExitLag list is stale, legally risky and cannot verify local EXE
  paths.
- A remote-only catalog makes selection and artwork depend on network access.
- A static-only catalog requires a new desktop release for every new game.

## Localization architecture

`src/i18n.tsx` owns `LocaleProvider`, `useI18n`, interpolation and persistence
under `hoaxconnect.locale`. Translation dictionaries live in
`src/locales/en.ts` and `src/locales/fa.ts` and share a compile-time key type.
The provider sets `document.documentElement.lang` and `dir`. A language control
is available on authentication screens and Settings. CSS uses logical
properties so the same components work in both directions.

## Catalog architecture

`src/catalog/types.ts` defines the manifest and entry schemas used by the UI.
The built-in seed is split from presentation. Backend stores a versioned public
catalog and returns enabled entries from `POST /api/v1/catalog/games`; the main
process validates and caches it. The renderer merges remote entries over the
seed by stable slug.

The manifest is plain JSON with a positive monotonic `version`, an ISO
`generated_at`, and at most 5,000 entries. Each entry has a unique lowercase
slug, `game|app` kind, required English name, optional Persian name, platforms,
launcher identifiers, up to 16 normalized `.exe` basenames, enabled state and
optional artwork metadata. Strings and URLs are length-limited. A lower version
never replaces a newer cache.

Remote metadata may replace seed names, artwork and executable aliases, but it
never replaces an exact installed path or a user's selection. Artwork is HTTPS
only and restricted to approved Steam CDN hosts or a Backend artwork proxy.
Catalog text is rendered as text, never HTML. The Backend validates imports,
soft-disables removed entries and records administrative changes in the audit
log.

Windows discovery expands `electron/app-scanner.cjs` with focused scanners:

- existing registry, Start Menu and running-process discovery;
- Steam library folders and `appmanifest_*.acf` metadata;
- Epic `.item` manifests;
- installed executables remain selectable even when unmatched.

Steam manifests provide installation directories rather than a reliable game
executable. HoaxConnect scans those directories to depth three, excludes common
uninstallers, crash reporters, redistributables, anti-cheat helpers and launcher
stubs, and asks the user to choose when multiple plausible executables remain.
Epic `LaunchExecutable` is preferred when present. Exact selected paths remain
the only routing authority.

Each result carries source, launcher ID and best available icon. No scan sends
the user's installed-app inventory to the Backend.

## Library behavior

The Games & Apps page opens with installed games, then installed applications,
then the broader catalog. Cards show artwork, localized/official name and one
of: installed, running, selected or not installed. Search matches English,
Persian, executable and launcher identifiers. Selecting a detected card stores
the exact executable path used by the existing tunnel service.

## Failure behavior

- Invalid or oversized remote manifests are ignored and the last valid cache
  or built-in seed is used.
- Missing artwork shows a branded local fallback.
- An unavailable launcher manifest does not suppress generic Windows results.
- Missing translations fall back to English and fail a translation parity
  test in CI.
- A narrowly allowlisted CI scan rejects new renderer-visible hardcoded text
  outside locale dictionaries; official product/game names and units are exempt.

## Acceptance

- English and Persian cover all renderer-owned desktop screens with correct
  direction and persistence.
- CI proves translation key parity and locale switching.
- Fixture tests prove Steam and Epic discovery outside default install paths.
- A game unknown to the built-in catalog but installed locally is selectable.
- Ambiguous launcher installs let the user choose the executable rather than
  silently routing an arbitrary helper process.
- Remote catalog failures leave installed-game selection operational.
- Existing selected-only VPN tests and Windows installer checks remain green.
