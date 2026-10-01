# Client Device Reporting

## Data Contract

`POST /api/v1/client/device-report` requires the desktop access token. The
Backend derives the account, device, session, source IP and received time.
An old desktop without this endpoint remains usable but has no presence data.

Every signed-in client sends a basic presence report every 30 seconds. The
desktop Settings page discloses this and offers separate switches, initially
off, for hardware, network diagnostics and names of visible-window applications.
Switches persist on that installation. Additional data is not collected until
the corresponding switch is enabled. Turning a switch off replaces the stored
server value with null on the next successful report; offline withdrawal takes
effect remotely only after reconnection or retention expiry.

Hardware is manufacturer/model, CPU, RAM and a namespaced SHA-256 hash of the
firmware UUID. No raw UUID, disk serial, account password or device private key
is transmitted. A hardware hash can be unavailable, cloned or spoofed; it is
not the account ID or a security boundary. Device proof remains authoritative.

Applications are at most 64 sanitized process names with visible windows.
There are no window titles, paths, command lines, URLs, browser history or
screenshots. Network metrics are the system's interface-availability signal,
previous Backend request duration, and recent failed-report count. They do
not measure download speed, Internet-wide packet loss or VPN connectivity.

## Presence And Retention

- Fresh running report: app online, not proof of a VPN tunnel.
- Graceful shutdown: app closed when the final report reaches the Backend.
- More than 90 seconds without a report: no recent contact. A crash, sleep,
  disconnection and an unreachable Backend cannot be distinguished.
- Revoked/expired session or banned device/account: session inactive.
- No compatible client report: no app reports.

The Admin screen refreshes every 20 seconds while visible and locally ages
the online badge even between requests. Only the newest report per device is
stored. Reports older than 24 hours are excluded from reads; an hourly purge
and startup purge delete them, for up to 25 hours of physical retention.
Application names are not exposed as current once the report is stale.
Optional details require the existing `telemetry.read` permission. Account
detail reads, including reports, retain the existing sensitive-read audit.

## Verification

Run `npm run test:electron`, both UI builds and the Backend build. For all
database tests, point `HC_STAGE2C_TEST_DATABASE_URL`,
`HC_STAGE2D_TEST_DATABASE_URL` and `HC_STAGE2F_TEST_DATABASE_URL` at the SAME
isolated loopback database whose name contains `test`, then run from `backend`:

```sh
node --import tsx --test --test-concurrency=1 tests/*.test.ts
```

For the Windows UI/collector test, install root and Backend dependencies and
the Electron binary, supply Playwright via normal module resolution or
`HC_PLAYWRIGHT_MODULE`, and install Edge. With the isolated schema migrated,
set `HC_STAGE2F_TEST_DATABASE_URL` and `HC_COLLECT_LOCAL_DEVICE_REPORTS=1`.
Run `npm run test:device-ui` from the repository root. It starts disposable
Backend/UI servers, creates temporary accounts/profile, enables optional
collection only against that local Backend, checks the Admin in a browser,
and cleans up the test accounts/profile. Ports 5173 and 5177 must be free.
Screenshots under `.tmp/evidence` may contain your device/app details and must
not be committed or published without review.

## Production Deployment

The supplied script targets the existing `hoaxconnect` Compose installation,
`hoaxconnect-api-1`, `hoaxconnect-postgres-1`, `hoaxconnect_pgdata` and the known
hoaxnet.ir Nginx configuration. It refuses dirty clones or unexpected layouts.
Run only after approval, from a fresh clean release clone, not `/opt/HoaxConnect`:

```sh
bash scripts/deploy-device-reports.sh --deploy-production
```

It captures current container configuration under a root-only backup, preserves
all running auth/encryption credentials, obtains the actual Docker gateway for
`TRUSTED_PROXY_IPS`, builds the image and Admin assets before API replacement,
and creates a custom-format PostgreSQL dump with a readable table-of-contents
check. This validates backup readability, not a complete restore drill.

Migration 005 only adds a report table/index. The script never recreates the
database container or removes its volume. After replacement it checks readiness,
the migration ledger, authentication on the new route, and served static bytes.
Any failure after replacement attempts to restore the old image and Nginx
configuration. The additive table may remain; a database dump is never restored
automatically over newer production writes. Keep the printed backup and image
override paths for future Compose commands.

The loopback HTTPS static check intentionally checks routing without CA
verification. Independently verify normal external TLS from Windows:

```powershell
curl.exe --fail --show-error --max-time 15 https://hoaxnet.ir/api/v1/health/ready
curl.exe --fail --show-error --max-time 15 https://hoaxnet.ir/admin/ -o NUL
```

Install the new Windows build. Enable the desired sharing switches in Settings
and check the same real account under Users in Admin. Validate observed public
IP, model/hardware hash, names, withdrawal, graceful shutdown and stale-heartbeat
behavior. Do not label the complete production path verified until this succeeds.
Existing session IPs recorded before proxy configuration remain historical
proxy addresses; this change cannot reconstruct their original client IPs.
