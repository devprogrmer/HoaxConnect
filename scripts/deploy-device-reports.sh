#!/usr/bin/env bash
# Upgrade the existing hoaxnet.ir Compose installation, never the dirty original checkout.
set -Eeuo pipefail
test "${1:-}" = --deploy-production || { echo 'Usage: bash scripts/deploy-device-reports.sh --deploy-production'; exit 2; }
test "$(id -u)" = 0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
test -z "$(git status --porcelain)"
test -s backend/migrations/005_client_device_reports.sql
test "$ROOT" != /opt/HoaxConnect
for tool in docker python3 nginx curl npm flock; do command -v "$tool" >/dev/null; done
exec 9>/run/hoaxconnect-deploy.lock
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
SHA="$(git rev-parse --short=12 HEAD)"
RUN="$(date +%Y%m%d-%H%M%S)-$$"
BACKUP="/root/hoaxconnect-presence-$RUN"
IMAGE="hoaxconnect-api:presence-$SHA"
OLD_IMAGE="$(docker inspect hoaxconnect-api-1 --format '{{.Image}}')"
CONFIG="$(readlink -f /etc/nginx/sites-enabled/hoaxconnect-api-stage2a.conf)"
WEB="/var/www/hoaxconnect-admin-$SHA"
umask 077
mkdir "$BACKUP"
cp -p -- "$CONFIG" "$BACKUP/nginx.conf"
docker inspect hoaxconnect-api-1 hoaxconnect-postgres-1 > "$BACKUP/containers.json"
docker image tag "$OLD_IMAGE" "hoaxconnect-api:before-presence-$RUN"
printf '%s\n' "$OLD_IMAGE" > "$BACKUP/api-image-id"
curl -fsS --max-time 5 http://127.0.0.1:3100/api/v1/health/ready
nginx -t

# Preserve running credentials. Trust only the actual Nginx-to-Docker gateway.
export ROOT BACKUP
python3 <<'PY'
import json, os
from pathlib import Path
api, db = json.loads((Path(os.environ['BACKUP']) / 'containers.json').read_text())
if api['Config']['Labels'].get('com.docker.compose.project') != 'hoaxconnect':
    raise SystemExit('Unexpected Compose project')
if not any(m.get('Name') == 'hoaxconnect_pgdata' and m['Destination'] == '/var/lib/postgresql/data'
           for m in db['Mounts']):
    raise SystemExit('Unexpected production database volume')
values = dict(e.split('=', 1) for e in api['Config']['Env'])
db_values = dict(e.split('=', 1) for e in db['Config']['Env'])
for key in ('POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD'):
    values[key] = db_values[key]
required = ('JWT_ACCESS_SECRET', 'JWT_ISSUER', 'JWT_AUDIENCE', 'REFRESH_TOKEN_PEPPER',
            'REFRESH_RECOVERY_ENCRYPTION_KEY', 'ADMIN_SECRET_ENCRYPTION_KEY', 'ADMIN_ALLOWED_ORIGINS')
if not all(values.get(key) for key in required):
    raise SystemExit('A required production key is missing; no key was regenerated')
gateways = {n['Gateway'] for n in api['NetworkSettings']['Networks'].values() if n.get('Gateway')}
if len(gateways) != 1:
    raise SystemExit('Expected one Docker gateway; inspect the API network first')
values['TRUSTED_PROXY_IPS'] = ','.join(['127.0.0.1', '::1', *sorted(gateways)])
lines = []
for key, value in values.items():
    if '\n' in value or '\r' in value or "'" in value:
        raise SystemExit('Unsupported multiline or quoted environment value; no changes applied')
    lines.append(f"{key}='{value}'")
target = Path(os.environ['ROOT']) / 'deploy/backend.env'
if target.exists():
    raise SystemExit('Release environment already exists; use a fresh clone')
target.write_text('\n'.join(lines) + '\n')
target.chmod(0o600)
PY

printf 'services:\n  api:\n    image: %s\n' "$IMAGE" > "$BACKUP/new-image.yml"
printf 'services:\n  api:\n    image: %s\n' "$OLD_IMAGE" > "$BACKUP/old-image.yml"
compose=(docker compose --project-name hoaxconnect --env-file "$ROOT/deploy/backend.env" -f "$ROOT/docker-compose.backend.yml")
"${compose[@]}" -f "$BACKUP/new-image.yml" config -q
echo 'BUILDING_ADMIN_AND_BACKEND'
npm ci --ignore-scripts
npm run build:admin
DOCKER_BUILDKIT=0 docker build -t "$IMAGE" backend
docker run --rm --network none --read-only --entrypoint node "$IMAGE" /app/scripts/check-image.mjs
install -d -m 755 "$WEB"
cp -R admin-dist/. "$WEB/"
find "$WEB" -type d -exec chmod 755 {} +
find "$WEB" -type f -exec chmod 644 {} +

echo 'BACKING_UP_PRODUCTION_DATABASE'
docker exec hoaxconnect-postgres-1 sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$BACKUP/production.dump"
test -s "$BACKUP/production.dump"
docker exec -i hoaxconnect-postgres-1 pg_restore --list < "$BACKUP/production.dump" > "$BACKUP/dump-contents.txt"
test -s "$BACKUP/dump-contents.txt"
healthy() {
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 3 http://127.0.0.1:3100/api/v1/health/ready > "$BACKUP/health.json"; then return 0; fi
    sleep 2
  done
  return 1
}
rollback() {
  trap - ERR
  set +e
  cp -- "$BACKUP/nginx.conf" "$CONFIG"
  nginx -t && systemctl reload nginx
  "${compose[@]}" -f "$BACKUP/old-image.yml" up -d --no-deps --no-build api
  if healthy; then echo 'PREVIOUS_API_HEALTHY'; else echo 'ROLLBACK_HEALTH_FAILED'; fi
  echo "DEPLOYMENT_FAILED BACKUP=$BACKUP"
  echo 'Database was not restored automatically; additive migration 005 may remain applied.'
  exit 1
}
trap rollback ERR
"${compose[@]}" -f "$BACKUP/new-image.yml" up -d --no-deps --no-build api
healthy
docker exec hoaxconnect-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT version FROM schema_migrations WHERE version = '\''005_client_device_reports.sql'\''"' |
  grep -Fx '005_client_device_reports.sql'
STATUS="$(curl -sS --max-time 5 -o "$BACKUP/report-route.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3100/api/v1/client/device-report)"
test "$STATUS" = 401
grep -Fq 'AUTHENTICATION_REQUIRED' "$BACKUP/report-route.json"

# Only the known Admin static location is changed; the HTTPS API proxy is preserved.
export CONFIG WEB
python3 <<'PY'
import os, re
from pathlib import Path
p = Path(os.environ['CONFIG'])
text = p.read_text()
aliases = list(re.finditer(r'(?m)^(\s*)alias /var/www/hoaxconnect-admin-[A-Za-z0-9_-]+/;', text))
routes = list(re.finditer(r'location[^\n]*\s/admin(?:[/\s{]|$)', text))
if len(aliases) == 1 and len(routes) == 2:
    match = aliases[0]
    text = text[:match.start()] + match[1] + 'alias ' + os.environ['WEB'] + '/;' + text[match.end():]
elif not routes and not aliases:
    anchors = list(re.finditer(r'(?m)^[ \t]*listen 443 ssl;[^\n]*$', text))
    if len(anchors) != 1:
        raise SystemExit('Expected one HTTPS server; no Nginx patch applied')
    addition = '''    location = /admin { return 308 /admin/; }
    location ^~ /admin/ {
        alias WEBROOT/;
        index index.html;
        autoindex off;
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
    }

'''.replace('WEBROOT', os.environ['WEB'])
    pos = anchors[0].start()
    text = text[:pos] + addition + text[pos:]
else:
    raise SystemExit('Unexpected Admin location; refusing a broad configuration rewrite')
p.write_text(text)
PY
nginx -t
systemctl reload nginx
# Loopback routing check only. Normal external certificate verification is still required.
for FILE in "$WEB/index.html" "$WEB"/assets/*; do
  RELATIVE="${FILE#"$WEB/"}"
  MATCHED=false
  for attempt in $(seq 1 20); do
    if curl -fsSk --noproxy '*' --max-time 5 --resolve hoaxnet.ir:443:127.0.0.1 \
        "https://hoaxnet.ir/admin/$RELATIVE" -o "$BACKUP/static-response" && cmp -s "$FILE" "$BACKUP/static-response"; then
      MATCHED=true
      break
    fi
    sleep 1
  done
  test "$MATCHED" = true
done
healthy
trap - ERR
echo "DEVICE_REPORTING_DEPLOYED SHA=$SHA BACKUP=$BACKUP"
echo "COMPOSE_OVERRIDE=$BACKUP/new-image.yml"
echo 'No existing secrets were rotated. PostgreSQL container and production volume were preserved.'
echo 'Install the updated Windows client and enable optional sharing in Settings > Device reporting.'
