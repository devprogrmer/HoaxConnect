# Portable Deployment Implementation Plan

> **Historical / Superseded roadmap naming:** This document records the
> portable-deployment work as it was scoped at the time. References here to
> "Stage 2C" are historical and do not define the current product roadmap.
> The authoritative Stage 2C is Desktop Backend Authentication + Real Device
> Identity in `docs/product/implementation-roadmap.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an idempotent source-mode installer and maintenance toolset for the real HoaxConnect control plane on supported Ubuntu servers.

**Architecture:** Bash entrypoints use focused libraries for validation, rendering, Compose, Nginx/TLS, and backups. Releases live under `/opt/hoaxconnect/releases/<git-sha>`; secrets remain under `/etc/hoaxconnect`; project `hoaxconnect` retains volume `hoaxconnect_pgdata`.

**Tech Stack:** Bash, Git, Docker Engine, Docker Compose v2, PostgreSQL 16, Nginx, Certbot, OpenSSL, curl, tar, sha256sum, shellcheck.

**Spec:** `docs/superpowers/specs/2026-09-28-portable-deployment-design.md`

## Global Constraints

- Support Ubuntu Server 22.04 and 24.04 LTS on x86_64.
- Stage 2B-B implements source mode only; GHCR image mode belongs to Stage 2C.
- Deploy only real API, PostgreSQL, migrations, health, Nginx/TLS, and update storage.
- Report future website, Admin, payment, email, VPN, WireGuard, Windows Service, WFP, and DNS components as unavailable; create no mocks.
- PostgreSQL has no host port; API publishes only `127.0.0.1:3100:3100`.
- Production auth requires HTTPS; CORS is never `*`.
- Secret files use `0600`; secrets never enter Git or logs.
- Create no default admin or hardcoded credential.
- Never remove `hoaxconnect_pgdata` during install, update, rollback, normal uninstall, or Compose shutdown.
- Rollback restores app and Nginx state but never claims to reverse a successful migration.
- The user applies every reviewed patch; the agent does not edit the repository.

## Review Focus

- Preserve unrelated Nginx sites and own only HoaxConnect files.
- Use a lock and atomic writes so interruption retains a valid active release.
- Reinstall must reuse existing secrets and database volume.
- Invalid DNS or certificate issuance must not replace working Nginx state.
- Post-migration app failure must retain the database and report schema rollback was not attempted.

## Planned Structure

- `scripts/lib/common.sh`: logging, lock, dry-run, atomic writes, paths.
- `scripts/lib/config.sh`: validation, secrets, environment and metadata.
- `scripts/lib/compose.sh`: Compose wrapper, readiness, network checks.
- `scripts/lib/nginx.sh`: templates, Certbot, activation and restoration.
- `scripts/lib/backup.sh`: dump, manifest, checksums and restore helpers.
- `scripts/{install,update,backup,restore,status,uninstall}.sh`: operator commands.
- `deploy/compose/compose.source.yml`: source-build deployment.
- `deploy/templates/*`: placeholder-only environment and Nginx templates.
- `scripts/tests/*`: pure shell unit, dry-run and integration tests.

---

### Task 1: Shell Foundation

**Files:**
- Create: `scripts/lib/common.sh`
- Create: `scripts/tests/assert.sh`
- Create: `scripts/tests/test-common.sh`
- Create: `scripts/tests/run.sh`

**Interfaces:**
- Produces: `hc_log LEVEL MESSAGE`, `hc_die MESSAGE`, `hc_require_root`, `hc_require_command NAME`, `hc_acquire_lock`, `hc_run COMMAND...`, `hc_atomic_write TARGET MODE`, `hc_path ABSOLUTE_PATH`.
- Produces: `HC_EXEC_MODE=apply|dry-run`; test-only root prefix requires `HC_TEST_MODE=1`.

- [ ] Write failing tests named `test_dry_run_does_not_execute`, `test_atomic_write_sets_mode`, `test_root_prefix_requires_test_mode`, `test_lock_rejects_second_writer`, and `test_logs_do_not_echo_secret_values`.
- [ ] Run `bash scripts/tests/test-common.sh`; expect failure because the library is absent.
- [ ] Implement with `umask 077`, nonblocking `flock` on `/run/lock/hoaxconnect-deploy.lock`, same-directory atomic replacement, and shell-escaped dry-run output.
- [ ] Run `bash -n scripts/lib/common.sh scripts/tests/*.sh && bash scripts/tests/test-common.sh`; expect all PASS.
- [ ] Run `shellcheck scripts/lib/common.sh scripts/tests/*.sh`; expect exit 0.
- [ ] Commit: `git commit -m "test: add deployment shell foundation"`.

### Task 2: Configuration and Compose

**Files:**
- Create: `scripts/lib/config.sh`
- Create: `scripts/lib/compose.sh`
- Create: `deploy/compose/compose.source.yml`
- Create: `deploy/templates/backend.env.template`
- Create: `scripts/tests/test-config.sh`
- Create: `scripts/tests/test-compose.sh`

**Interfaces:**
- Consumes: Task 1.
- Produces: `hc_validate_domain VALUE`, `hc_validate_email VALUE`, `hc_generate_secret BYTES`, `hc_load_install_config`, `hc_write_backend_env`, `hc_compose ARGS...`, `hc_wait_service SERVICE SECONDS`, `hc_verify_network_boundaries`.
- Metadata: `HC_DOMAIN`, `HC_ADMIN_ORIGIN`, `HC_RELEASE_ID`, `HC_RELEASE_DIR`, `HC_ENV_FILE`, `HC_TLS_MODE`.

- [ ] Write failing tests for invalid IP domains, wildcard CORS, preserved reinstall secrets, 64-character minimum secrets, env mode `0600`, no PostgreSQL ports, loopback API only, named volume, and 2GB-host resource limits.
- [ ] Run `bash scripts/tests/test-config.sh && bash scripts/tests/test-compose.sh`; expect RED.
- [ ] Render secrets only to `/etc/hoaxconnect/backend.env`; keep the tracked template placeholder-only.
- [ ] Implement fixed project `hoaxconnect`, source context `${HC_RELEASE_DIR}/backend`, image `hoaxconnect-api:${HC_RELEASE_ID}`, internal network, `hoaxconnect_pgdata`, PostgreSQL 512 MB/1.50 CPU and API 256 MB/1.00 CPU.
- [ ] Run both tests and inspect `docker compose config`; expect only `127.0.0.1:3100:3100`.
- [ ] Commit: `git commit -m "feat: add portable compose configuration"`.

### Task 3: Nginx, TLS, and Update Storage

**Files:**
- Create: `scripts/lib/nginx.sh`
- Create: `deploy/templates/nginx-control-plane-http.conf.template`
- Create: `deploy/templates/nginx-control-plane-https.conf.template`
- Create: `scripts/tests/test-nginx.sh`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: `hc_render_nginx`, `hc_validate_nginx`, `hc_obtain_certificate`, `hc_activate_nginx`, `hc_restore_nginx`.
- Owns only `/etc/nginx/sites-available/hoaxconnect-control-plane.conf` and its enabled symlink.

- [ ] Write failing tests for ACME routing, HTTP redirect, HTTPS loopback proxy, disabled directory listing, blocked HTTP auth, unrelated-site preservation, invalid-Nginx rollback, and Certbot-failure rollback.
- [ ] Run `bash scripts/tests/test-nginx.sh`; expect RED.
- [ ] Use Certbot webroot `/var/lib/hoaxconnect/acme`; validate DNS, render a candidate, run `nginx -t`, then atomically activate and reload.
- [ ] Serve real files from `/var/lib/hoaxconnect/updates`; empty storage returns 404. Do not rewrite the desktop updater URL in this stage.
- [ ] Run `bash scripts/tests/test-nginx.sh`; expect all PASS.
- [ ] Commit: `git commit -m "feat: add transactional nginx tls setup"`.

### Task 4: Idempotent Source Installer

**Files:**
- Create: `scripts/install.sh`
- Create: `scripts/tests/test-install-dry-run.sh`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `scripts/install.sh --domain DOMAIN --email EMAIL --source-ref REF [--admin-origin ORIGIN] [--staging-http] [--dry-run]`.
- Produces releases, `/opt/hoaxconnect/current`, `/etc/hoaxconnect/install.env`, and maintenance logs.

- [ ] Write failing tests for non-root use, unsupported OS, no-change dry-run, required production inputs, explicit HTTP staging, secret-free `git archive`, preserved reinstall state, and unavailable-component reporting.
- [ ] Run `bash scripts/tests/test-install-dry-run.sh`; expect RED.
- [ ] Validate OS, x86_64, disk, memory, DNS, ports and tools. Warn, but do not create swap, when a host has at most 2GB RAM and no swap.
- [ ] Stage only `git archive REF` into `/opt/hoaxconnect/releases/<git-sha>`; never copy Git metadata, private env, keys, or build output.
- [ ] Implement transaction: preserve/generate secrets, render, build candidate, start database, migrate/start API, wait ready, configure TLS/Nginx, verify local/public health, then activate release and metadata.
- [ ] Run `bash scripts/tests/run.sh`, `bash -n scripts/install.sh scripts/lib/*.sh scripts/tests/*.sh`, and shellcheck; expect PASS.
- [ ] Commit: `git commit -m "feat: add idempotent source installer"`.

### Task 5: Backup and Restore

**Files:**
- Create: `scripts/lib/backup.sh`
- Create: `scripts/backup.sh`
- Create: `scripts/restore.sh`
- Create: `scripts/tests/test-backup-restore.sh`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: `scripts/backup.sh [--output DIR]` and `scripts/restore.sh --backup ARCHIVE --confirm-restore`.
- Archive: `database.dump`, `config/`, `nginx/`, `manifest.env`, `SHA256SUMS`.

- [ ] Write failing tests for archive mode `0600`, release/schema metadata, redacted output, mandatory confirmation, checksum rejection, pre-restore backup, failed-restore recovery, and volume preservation.
- [ ] Run `bash scripts/tests/test-backup-restore.sh`; expect RED.
- [ ] Implement `pg_dump --format=custom`, owned configuration copies, non-secret manifest, checksums, and restricted archive.
- [ ] Implement manifest validation, pre-restore backup, stopped API traffic, and `pg_restore --clean --if-exists --exit-on-error --single-transaction`; restart and require readiness.
- [ ] Run tests with fake Compose plus an isolated PostgreSQL container; expect PASS.
- [ ] Commit: `git commit -m "feat: add verified backup and restore"`.

### Task 6: Health-Gated Update and Rollback

**Files:**
- Create: `scripts/update.sh`
- Create: `scripts/tests/test-update.sh`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: `scripts/update.sh --source-ref REF`.
- Records previous/candidate releases, backup, Nginx checksum, migration versions and result.

- [ ] Write failing tests for backup-before-start, activation-after-health, build-failure preservation, ready-failure rollback, Nginx rollback, absence of `--volumes`, migration warning, and stable volume identity.
- [ ] Run `bash scripts/tests/test-update.sh`; expect RED.
- [ ] Under the deployment lock, back up, stage `git archive REF`, build a unique candidate, record state, start candidate, and run local/public health gates.
- [ ] On failure restore previous release, image, Compose environment and owned Nginx state; retain the volume and report migrations plus backup path.
- [ ] Run tests including injected readiness failure; expect PASS.
- [ ] Commit: `git commit -m "feat: add health-gated source updates"`.

### Task 7: Status, Safe Uninstall, and E2E

**Files:**
- Create: `scripts/status.sh`
- Create: `scripts/uninstall.sh`
- Create: `scripts/tests/test-status-uninstall.sh`
- Create: `scripts/tests/integration-control-plane.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: `scripts/status.sh [--json]` and `scripts/uninstall.sh --yes`.
- No data-purge option exists in Stage 2B-B.

- [ ] Write failing tests for redacted status, release/health/boundary output, uninstall confirmation, owned-Nginx removal, preserved config/backups/updates/volume, and absence of `--volumes`.
- [ ] Run `bash scripts/tests/test-status-uninstall.sh`; expect RED.
- [ ] Implement status for release, containers, health, certificate expiry, API binding, absent PostgreSQL binding, volume identity and unavailable components.
- [ ] Implement backup-first uninstall that removes owned containers and Nginx files but preserves `/etc/hoaxconnect`, `/var/lib/hoaxconnect`, `/var/backups/hoaxconnect`, and `hoaxconnect_pgdata`.
- [ ] Add disposable-host integration requiring `HC_INTEGRATION_HOST` and `HC_INTEGRATION_CONFIRM=YES`; reject localhost and the current build-server address.
- [ ] Verify clean install, reinstall, HTTPS, HTTP auth rejection/redirect, forced failed update rollback, successful update, backup/restore, uninstall, and unchanged volume identity.
- [ ] Run full local checks: shell tests, `bash -n`, shellcheck, frontend lint/build, backend tests/build, and `git diff --check`.
- [ ] Run disposable-host E2E; expect `STAGE2B_PORTABLE_DEPLOYMENT_E2E_OK`.
- [ ] Update README with real scope, commands, data preservation, unavailable components, and Stage 2C boundary.
- [ ] Commit: `git commit -m "docs: complete portable deployment workflow"`.

## Final Review Gate

- Search all scripts for `down -v`, `--volumes`, wildcard CORS, printed secrets, hardcoded credentials, and unsafe recursive paths.
- Confirm rendered Compose exposes no PostgreSQL port and only loopback API.
- Confirm active Nginx uses HTTPS and preserves unrelated sites.
- Record unit, build, isolated-database, and disposable-host E2E evidence separately.
- Retain previous source/image, Nginx backup, PostgreSQL backup, and exact rollback command.
- Do not replace the current working server until disposable-host E2E passes.
