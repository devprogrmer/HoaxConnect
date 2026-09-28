# HoaxConnect

HoaxConnect contains the backend control plane, React/Electron client source,
native traffic helper, and transactional deployment tooling for Ubuntu.

## Stage 2B-B scope

The portable deployment currently provides:

- Immutable source releases under `/opt/hoaxconnect/releases`.
- Docker Compose deployment of the API and PostgreSQL.
- API binding on `127.0.0.1:3100` with no published PostgreSQL port.
- Nginx routing, Certbot TLS, generated secrets, and health-gated activation.
- Safe update, verified backup, transactional restore, status, and uninstall.
- Preservation of configuration, releases, backups, and database volume.
- A guarded disposable-host end-to-end test harness.

This stage does not publish the website, Admin Panel, Windows installer,
Android app, or desktop update artifacts. Those remain Stage 2C work.

## Requirements

Use Ubuntu 22.04 or newer with root access, a public IPv4 address, a domain
pointing to the server, and inbound TCP ports 80 and 443. Git, Docker Compose
v2, Nginx, Certbot, curl, OpenSSL, Node.js, and npm are required.

The repository is private. Clone it using a read-only GitHub deploy key or a
suitably scoped token. Never commit private keys, tokens, environment files,
or generated secrets.

```bash
git clone git@github.com:devprogrmer/HoaxConnect.git
cd HoaxConnect
```

Use reviewed commit SHAs for production operations.

## Validate and install

Dry-run validation makes no changes:

```bash
sudo scripts/install.sh \
  --domain api.example.com \
  --email admin@example.com \
  --source-ref COMMIT_SHA \
  --admin-origin https://admin.example.com \
  --dry-run
```

Install with production TLS:

```bash
sudo scripts/install.sh \
  --domain api.example.com \
  --email admin@example.com \
  --source-ref COMMIT_SHA \
  --admin-origin https://admin.example.com
```

`--staging-http` is only for explicitly authorized staging workflows.

For servers behind asymmetric or outbound NAT, pass the public IPv4 address used by the domain with `--public-ip`. Without this option, the installer discovers the outbound public IPv4 address.

## Status

```bash
sudo scripts/status.sh
sudo scripts/status.sh --json
```

Status reports release, health, containers, certificate expiry, API binding,
PostgreSQL exposure, and volume identity without printing secrets.

## Update

```bash
sudo scripts/update.sh --source-ref COMMIT_SHA
```

Updates create a verified backup before candidate startup and activate only
after health checks pass. Failed builds or readiness checks restore the prior
API release and Nginx configuration. Database migrations are not automatically
reversed; the update log records the recovery backup.

## Backup and restore

```bash
sudo scripts/backup.sh --output /var/backups/hoaxconnect
```

The command prints `BACKUP_ARCHIVE=/path/to/archive.tar.gz`. Archives use mode
`0600` and contain the PostgreSQL dump, deployment metadata, checksums, and
schema identity.

Restore requires explicit authorization:

```bash
sudo scripts/restore.sh \
  --backup /var/backups/hoaxconnect/BACKUP_FILE.tar.gz \
  --confirm-restore
```

Restore verifies the archive, creates a pre-restore backup, stops API traffic,
restores PostgreSQL, restarts the API, and checks readiness. Failed restores
attempt recovery from the pre-restore backup.

## Safe uninstall

```bash
sudo scripts/uninstall.sh --yes
```

Uninstall creates a backup first, stops only HoaxConnect containers, and
removes only its owned Nginx configuration. It preserves:

- `/etc/hoaxconnect`
- `/var/lib/hoaxconnect`
- `/var/backups/hoaxconnect`
- `/opt/hoaxconnect`
- Docker volume `hoaxconnect_pgdata`

Stage 2B-B intentionally has no data-purge option.

## Local verification

```bash
scripts/tests/run.sh
npm ci
npm run lint
npm run build
npm --prefix backend ci
npm --prefix backend test
npm --prefix backend run build
```

## Disposable-host E2E

Never target the build server or production. Use a disposable Ubuntu server
and a temporary public domain resolving to it:

```bash
HC_INTEGRATION_CONFIRM=YES \
HC_INTEGRATION_EXECUTE=1 \
HC_INTEGRATION_HOST=203.0.113.10 \
HC_INTEGRATION_DOMAIN=e2e-api.example.com \
HC_INTEGRATION_EMAIL=admin@example.com \
HC_INTEGRATION_IDENTITY_FILE=/root/.ssh/e2e_key \
  scripts/tests/integration-control-plane.sh
```

Success must end with `STAGE2B_PORTABLE_DEPLOYMENT_E2E_OK`. Local tests are not
a substitute for this disposable-host result.

## Persistent paths

- Configuration and secrets: `/etc/hoaxconnect`
- Releases: `/opt/hoaxconnect`
- Runtime and update records: `/var/lib/hoaxconnect`
- Verified backups: `/var/backups/hoaxconnect`
- Maintenance logs: `/var/log/hoaxconnect`
- PostgreSQL volume: `hoaxconnect_pgdata`

Keep encrypted off-server copies of important backups and test restoration
regularly.
