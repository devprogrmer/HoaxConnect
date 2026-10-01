#!/usr/bin/env bash
# Publish an already-built Windows release to the existing updater feed.
set -Eeuo pipefail
test "$(id -u)" = 0
test "$#" = 1
ARCHIVE="$(readlink -f -- "$1")"
test -s "$ARCHIVE"
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$REPO"
test "$REPO" != /opt/HoaxConnect
for tool in node python3 nginx curl flock sha256sum sha512sum; do command -v "$tool" >/dev/null; done
test -d node_modules/js-yaml
test "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" = \
  913ba2e7574cc41f7b69e66505d38b3611202b97e0cf50adf4381c45103f7660
exec 9>/run/hoaxconnect-windows-update.lock
flock -n 9 || { echo 'An update publication is already running'; exit 1; }

VERSION="$(node -p "require('./package.json').version")"
test "$VERSION" = 0.3.10
NAME="HoaxConnect-$VERSION-Setup.exe"
FEED=/var/lib/hoaxconnect/updates
CONFIG="$(readlink -f /etc/nginx/sites-enabled/hoaxconnect-api-stage2a.conf)"
test -s "$FEED/latest.yml"
test -s "$CONFIG"
RUN="$(date +%Y%m%d-%H%M%S)-$$"
BACKUP="/root/hoaxconnect-windows-update-$RUN"
umask 077
mkdir "$BACKUP"
STAGED="$BACKUP/staged"
mkdir "$STAGED"
cp -p -- "$FEED/latest.yml" "$BACKUP/previous-latest.yml"
cp -p -- "$CONFIG" "$BACKUP/previous-nginx.conf"

# Do not touch a different 8090 feed or unpack anything except the three release files.
curl -fsS --noproxy '*' --max-time 10 \
  http://127.0.0.1:8090/latest.yml -o "$BACKUP/served-before.yml"
cmp -- "$FEED/latest.yml" "$BACKUP/served-before.yml"
export ARCHIVE STAGED NAME
python3 <<'PY'
import os, shutil, tarfile
from pathlib import Path

expected = {'latest.yml', os.environ['NAME'], os.environ['NAME'] + '.blockmap'}
with tarfile.open(os.environ['ARCHIVE'], 'r:gz') as archive:
    members = archive.getmembers()
    if {m.name for m in members} != expected or len(members) != len(expected):
        raise SystemExit('Archive must contain exactly the update manifest, installer and blockmap')
    for member in members:
        if not member.isfile() or member.size <= 0 or member.size > 250_000_000:
            raise SystemExit('Unsafe or oversized update archive member')
        with archive.extractfile(member) as source, open(Path(os.environ['STAGED']) / member.name, 'xb') as target:
            shutil.copyfileobj(source, target)
PY
node scripts/verify-windows-update.mjs "$STAGED" "$VERSION"
curl -fsS --max-time 5 http://127.0.0.1:3100/api/v1/health/ready > "$BACKUP/api-before.json"
nginx -t

rollback() {
  trap - ERR INT TERM
  set +e
  install -m 0644 "$BACKUP/previous-latest.yml" "$FEED/.latest.yml.rollback-$RUN"
  mv -f -- "$FEED/.latest.yml.rollback-$RUN" "$FEED/latest.yml"
  cp -p -- "$BACKUP/previous-nginx.conf" "$CONFIG"
  nginx -t && systemctl reload nginx
  echo "UPDATE_PUBLICATION_FAILED PREVIOUS_FEED_RESTORED BACKUP=$BACKUP"
  exit 1
}
trap rollback ERR INT TERM

# New clients use TLS. The existing 0.3.9 feed on 8090 remains for one upgrade.
export CONFIG FEED
python3 <<'PY'
import os, re, stat
from pathlib import Path

path = Path(os.environ['CONFIG'])
text = path.read_text()
if re.search(r'location\s+[^\n]*?/updates/', text):
    raise SystemExit('An update location already exists; inspect it before publishing')
anchors = list(re.finditer(r'(?m)^[ \t]*listen 443 ssl;[^\n]*$', text))
if len(anchors) != 1:
    raise SystemExit('Expected exactly one HTTPS server')
location = '''    location ^~ /updates/ {
        alias /var/lib/hoaxconnect/updates/;
        autoindex off;
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options "nosniff" always;
    }

'''
position = anchors[0].start()
temporary = path.with_name(f'.{path.name}.update-{os.getpid()}')
temporary.write_text(text[:position] + location + text[position:])
temporary.chmod(stat.S_IMODE(path.stat().st_mode))
os.replace(temporary, path)
PY
nginx -t
systemctl reload nginx
curl -fsSk --noproxy '*' --max-time 10 \
  --resolve hoaxnet.ir:443:127.0.0.1 \
  https://hoaxnet.ir/updates/latest.yml -o "$BACKUP/https-before.yml"
cmp -- "$FEED/latest.yml" "$BACKUP/https-before.yml"

for FILE in "$NAME" "$NAME.blockmap"; do
  if test -e "$FEED/$FILE"; then
    cmp -- "$STAGED/$FILE" "$FEED/$FILE"
  else
    install -m 0644 -- "$STAGED/$FILE" "$FEED/.$FILE.$RUN"
    mv -- "$FEED/.$FILE.$RUN" "$FEED/$FILE"
  fi
done

EXPECTED="$(sha512sum "$STAGED/$NAME" | cut -d' ' -f1)"
for URL in "http://127.0.0.1:8090/$NAME" "https://hoaxnet.ir/updates/$NAME"; do
  if [[ "$URL" == https:* ]]; then
    ACTUAL="$(curl -fsSk --noproxy '*' --max-time 180 \
      --resolve hoaxnet.ir:443:127.0.0.1 "$URL" | sha512sum | cut -d' ' -f1)"
  else
    ACTUAL="$(curl -fsS --noproxy '*' --max-time 180 "$URL" | sha512sum | cut -d' ' -f1)"
  fi
  test "$ACTUAL" = "$EXPECTED"
done

install -m 0644 -- "$STAGED/latest.yml" "$FEED/.latest.yml.$RUN"
mv -f -- "$FEED/.latest.yml.$RUN" "$FEED/latest.yml"
for URL in http://127.0.0.1:8090/latest.yml https://hoaxnet.ir/updates/latest.yml; do
  if [[ "$URL" == https:* ]]; then
    curl -fsSk --noproxy '*' --max-time 10 \
      --resolve hoaxnet.ir:443:127.0.0.1 "$URL" -o "$BACKUP/served-after.yml"
  else
    curl -fsS --noproxy '*' --max-time 10 "$URL" -o "$BACKUP/served-after.yml"
  fi
  cmp -- "$STAGED/latest.yml" "$BACKUP/served-after.yml"
done
curl -fsS --max-time 5 http://127.0.0.1:3100/api/v1/health/ready > "$BACKUP/api-after.json"
trap - ERR INT TERM
echo "WINDOWS_UPDATE_PUBLISHED version=$VERSION backup=$BACKUP"
echo 'The in-app updater feed now advertises this version; verify with an installed client.'
