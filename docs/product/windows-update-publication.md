# Windows 0.3.10 Update Publication

The generic `electron-updater` feed on port 8090 still advertises 0.3.9.
Building 0.3.10 locally does not publish it. Existing 0.3.9 installations
must receive 0.3.10 through that feed once; 0.3.10 itself has the HTTPS feed
`https://hoaxnet.ir/updates/` embedded in `app-update.yml`.

The release archive at `.tmp/HoaxConnect-0.3.10-update.tar.gz` contains only
the installer, its blockmap and electron-builder's `latest.yml`. It must not
be committed to Git. Its SHA-256 is
`913BA2E7574CC41F7B69E66505D38B3611202B97E0CF50ADF4381C45103F7660`.
The publication script requires this exact archive hash before extraction.
The installer SHA-256 is
`86F9DD927593B5B0BEB02012C508647852CA44C21FA4B69BC7BF71BE87747436`.

An operator transfers the archive to `/root/HoaxConnect-0.3.10-update.tar.gz`
on the update host, then runs the tracked
`scripts/publish-windows-update.sh` from a clean Stage 2F checkout updated to
the publishing commit. The script verifies the archive and generated metadata,
checks that `/var/lib/hoaxconnect/updates` actually backs the live 8090 feed,
backs up Nginx and `latest.yml`, and adds a separate HTTPS `/updates/` route.
It copies the installer and blockmap first, verifies full downloads via both
routes, then atomically replaces `latest.yml` last. A failed publication
restores the previous feed and Nginx configuration. The production API and
PostgreSQL are not modified.

After publication, check both public manifests and their installer hashes
from outside the server, then test **Check for updates**, download, install and
relaunch on an actual installed 0.3.9 client. Do not call the update verified
from a manifest `200` or a socket check alone.

The legacy 0.3.9 updater obtains metadata via HTTP and has no pinned
manifest signature; an on-path attacker could replace its update instructions.
Neither installer is Authenticode-signed. HTTPS in 0.3.10 protects later
metadata transport but does not retroactively secure the old client or replace
artifact signing. Shipping the 0.3.10 update is a compatibility bridge, not
completion of the production updater supply-chain requirements.
