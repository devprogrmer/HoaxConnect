# HoaxConnect Portable Deployment Design

> **Historical / Superseded roadmap naming:** This document records the
> portable-deployment work as it was scoped at the time. References here to
> "Stage 2C" are historical and do not define the current product roadmap.
> The authoritative Stage 2C is Desktop Backend Authentication + Real Device
> Identity in `docs/product/implementation-roadmap.md`.

Status: Proposed for review
Stage: 2B-B
Supported hosts: Ubuntu Server 22.04 and 24.04 LTS, x86_64

## Goal

Install, verify, update, back up, restore, and remove HoaxConnect predictably on a clean server. Normal install, update, rollback, uninstall, and Compose shutdown preserve PostgreSQL data.

## Real Scope

Stage 2B-B deploys only features that are real now:

- Fastify TypeScript API
- PostgreSQL 16
- versioned migrations
- live and database-ready health endpoints
- Nginx and TLS foundation
- Windows installer update storage

The website, Admin Panel, payment and email providers, VPN node agent, WireGuard provisioning, Windows Service, WFP split tunneling, and DNS Doctor automation are not deployable yet. The installer reports them unavailable and creates no mock service or fake success.

## Distribution

Source mode clones an authenticated private repository revision and builds locally. Stage 2B-B uses this mode for the build server and controlled staging.

Image mode pulls immutable GHCR images by digest. Stage 2C adds GitHub Actions, release manifests, and a public bootstrap installer.

Both modes share configuration, migrations, service names, volume names, health checks, and backup format.

## Roles

The control-plane role contains API, PostgreSQL, Nginx, TLS, update storage, and future web applications. Stage 2B-B installs only this role.

The vpn-node role will contain the node agent and WireGuard networking after Stage 5. The all-in-one role is allowed only after vpn-node is real.

## Stable Paths

- /opt/hoaxconnect: versioned application files
- /etc/hoaxconnect: runtime configuration and secrets
- /var/lib/hoaxconnect: persistent application data
- /var/backups/hoaxconnect: database and configuration backups
- /var/log/hoaxconnect: installer and maintenance logs
- hoaxconnect_pgdata: persistent PostgreSQL Docker volume

Runtime secrets never reside in Git.

## Inputs and Secrets

Production input includes API domain, Let's Encrypt email, release or source revision, deployment mode, and optional future Admin origin.

The installer securely generates the database password, JWT access secret, and refresh-token pepper. It rejects empty, example, and weak values. Secret files use mode 0600. Logs, health reports, and command output never print secret values.

No default admin account or hardcoded password is created. Future superadmin bootstrap must be explicit, local, and audited.

## Network and TLS

PostgreSQL publishes no host port.

The API listens on 0.0.0.0:3100 inside its container. Docker publishes only 127.0.0.1:3100:3100.

Nginx exposes 80 and 443. Port 80 handles ACME and redirects normal requests to HTTPS. HTTPS proxies the API to loopback.

Production authentication requires HTTPS. DNS, certificate, and Nginx checks must pass before activation. Failure leaves the previous Nginx configuration active. HTTP health diagnostics do not make auth production-ready.

## Database

Migrations are versioned and checksum-verified. They run before the API accepts traffic. Failure prevents the new API from becoming healthy.

Install, update, rollback, normal uninstall, and docker compose down preserve hoaxconnect_pgdata. Database deletion is a separate destructive operation requiring explicit confirmation.

## Install Transaction

The installer:

1. validates OS, architecture, disk, memory, DNS, and ports;
2. validates or installs Docker, Compose, Nginx, Certbot, OpenSSL, curl, and Git;
3. creates stable directories with restrictive permissions;
4. backs up an existing installation;
5. generates or preserves secrets;
6. renders and validates Compose and Nginx configuration;
7. builds or pulls the selected immutable version;
8. starts PostgreSQL and waits for readiness;
9. runs migrations and starts the API;
10. obtains or verifies TLS;
11. activates Nginx only after validation;
12. runs local and public health checks;
13. records the active revision or image digest and result.

Repeating install with identical inputs is idempotent.

## Update, Rollback, and Backup

Before update, record the active revision or image digest, configuration, Nginx state, and a PostgreSQL custom-format backup.

Prepare the requested version, recreate affected containers, wait for readiness, and verify public HTTPS health before marking it active.

On failure, restore the previous application and Nginx configuration. Automatic rollback never removes the database volume and never claims to reverse a successful migration.

A backup contains the PostgreSQL dump, runtime configuration, installed-version metadata, Nginx configuration, manifest, and checksums. Restore requires explicit confirmation and validates the manifest first.

## Planned Files

- scripts/install.sh
- scripts/update.sh
- scripts/backup.sh
- scripts/restore.sh
- scripts/status.sh
- scripts/uninstall.sh
- scripts/lib/common.sh
- deploy/compose/compose.source.yml
- deploy/templates/backend.env.template
- deploy/templates/nginx-control-plane.conf.template

Uninstall preserves data by default. Data purge is a separate explicit operation.

## Acceptance

Stage 2B-B is complete only when:

- shell static checks pass;
- frontend build, backend tests, and backend TypeScript build pass;
- dry-run changes no host files or services;
- clean Ubuntu installation succeeds;
- reinstall is idempotent;
- PostgreSQL stays internal and API stays loopback-only;
- live and ready checks pass locally and through HTTPS;
- HTTP auth is rejected or redirected;
- forced failed update restores the previous healthy API;
- install, update, rollback, and normal uninstall preserve hoaxconnect_pgdata;
- Git tracks no runtime secret.

After approval, Stage 2B-B receives a detailed implementation plan and copy/paste patch. Stage 2C then adds CI, immutable GHCR images, release manifests, and the public bootstrap installer.
