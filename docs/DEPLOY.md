---
title: Installation
nav_order: 7
---

# Beta installation on a copy of the production data

Goal: the Rust server on a **copy** of the production database and image files, next to (never instead of) the running
Django. Nothing here touches production. Rollback is "stop the beta": Django keeps working on its own database, and the
additive tables/columns the beta adds exist only in the copy.

## 0. What you need
| | |
|---|---|
| Host | Linux (or macOS) with Docker (the database runs in a container, as in EXACT's own compose) or, for a native install, PostgreSQL 16; disk for a copy of the image store, an https host name |
| Database | the production `pg_dump -Fc` (custom format) |
| Files | the production image store (`IMAGE_PATH`: folders `exact_<team>_<set>/`) and `MEDIA_ROOT` (aux files, plugin icons, registration files, exports) |
| Accounts | the PostgreSQL role the server uses; an EXACT account with the permissions `images.change_imageregistration` and `processing.change_pluginjob` for the registration worker (an existing ML/worker account or a superuser) |
| Name | passkeys only work on the host name they were enrolled for: **`FIDO_SERVER_ID=exact.hs-flensburg.de`** works on that host and below it. On any other host everyone enrolls a new passkey (passwords keep working) |

## 1. Files: a copy, or the real store mounted read-only
The server **writes** to the image store (uploads, moving and deleting images, pyramid repair, crops) and only then. Two safe ways:
* **A copy** that costs no extra disk where the file system can: `cp -cR` (macOS/APFS), `cp -a --reflink=auto` (btrfs/XFS), or `rsync -a`. Compose with `IMAGE_MODE=rw`.
* **The real store, read-only** (when it is too big to copy): compose mounts it `:ro` into the server (the default, `IMAGE_MODE=ro`) and the worker.
  Viewing, annotating (annotations are database rows), registration and exports work; uploads, moving, deleting, crops and repair fail with an error and
  leave the files untouched. Deleting an image or set in the beta removes only its row in the beta's database copy.
`MEDIA_ROOT` (aux files, registration files, exports) is written to: use a copy of it, it is small. Keep `EXACT_CACHE_DIR` (thumbnails, can be deleted)
and `EXACT_NIFTI_CACHE` (inflated `.nii.gz` volumes, grows) on their own folders.

## 2. Database
**With Docker** (`deploy/docker-compose.yml`): `dc up -d db` creates the empty database in the volume `pgdata` (name, user, password from `exact.env`), then
```
dc exec -T db pg_restore --no-owner --role="$SQL_USER" -U "$SQL_USER" -d "$SQL_DATABASE" < production.dump
dc run --rm server sh -c 'exact-cli migrate --confirm-db "$SQL_DATABASE"'
```
(`dc` is the alias from the compose file's header; a dump of the production PostgreSQL 12 restores into 16.) A dump of the beta: `dc exec -T db pg_dump -Fc -U "$SQL_USER" "$SQL_DATABASE" > beta.dump`; throw it all away: `dc down -v`.

**Native** (existing PostgreSQL):
```
createdb -O exact exact_beta
pg_restore --no-owner --role=exact -d exact_beta production.dump        # scripts/restore-backup.sh does the same for a scratch DB
```
The beta must not be called `exact` (the tools refuse it). Then add the beta's own additive tables and columns (idempotent,
safe to repeat; Django's data stays as it is):
```
SQL_DATABASE=exact_beta ... exact-cli migrate --confirm-db exact_beta
```
`migrate` is not run by the server on start: run it after every update of the binary.

## 3. Configure
`cp deploy/exact.env.example exact.env` and fill it in (database, the three folders, `FIDO_SERVER_ID`, the worker account).
Every name is a Django one (`SQL_*`, `IMAGE_PATH`, `MEDIA_ROOT`, `FIDO_*`, `TIME_ZONE`), so an existing EXACT env file mostly works.
Keep the file private (mode 600).

## 4. Look at the data before anybody logs in
```
SQL_DATABASE=exact_beta SQL_USER=exact SQL_PASSWORD=... IMAGE_PATH=... scripts/audit-backup.sh
```
It reads only and prints counts and ids: Django version/migration state, sizes, image formats, **source files missing on disk**,
**passkeys the server cannot use** (anything but ES256/RS256 would have to be enrolled again), data-quality checks, the biggest
image sets, and (with `EXACT_URL`/`EXACT_USER`/`EXACT_PASSWORD`) how long loading the annotations of the biggest images takes.
Send the output back: it is the first real comparison with production. Also run
`SQL_DATABASE=exact_beta exact-cli schema-check baseline/schema-local-20261027.json`; differences are not necessarily errors (the
baseline comes from a development database), but each one should be understood.

## 4b. Registration plugins
Production has probably not applied EXACT PR #167 (migration `processing/0015_registration_plugins`; the audit says). That is fine:
`exact-cli migrate` adds the same columns with the same DDL, and Django's migration later finds them present.

## 5. Start
Native: build (`cargo build --release -p exact-server -p exact-cli`, needs libclang and ffmpeg dev libraries; `cd frontend && pnpm
install && pnpm build`), install the binary and `frontend/dist`, then `deploy/exact-server.service` and `deploy/exact-worker.service`
(systemd) or the container: `deploy/docker-compose.yml` starts PostgreSQL, the server and the worker (`docker build -f deploy/Dockerfile -t exact-rust .` builds the one image for the server, the worker and `exact-cli`; build it on the target architecture: `slideio` has wheels for Linux x86_64 only, an arm64 build works without CZI/VSI/DICOM and says so; tested: image builds, server starts and serves the UI and API, the worker's Python imports `qt_wsi_reg`).
Runtime libraries for the native install: libopenslide, libav* (video), and a Python with `slideio` (CZI, VSI, DICOM) and
`qt-wsi-registration` + `opencv`, `openslide-python` (registration) and an EXACT checkout (`REGISTRATION_EXACT_DIR`: its
`util.slide_server` reads the slides for registration and its classes are in the stored registration files).

Put an https reverse proxy in front (`deploy/Caddyfile.example`), and **restrict access** (VPN, IP allow-list or basic auth)
until login rate limiting exists. Mail is not configured: users get in through invitations; password reset by mail is not ported.

## 6. First checks (about 20 minutes)
1. `curl -s https://<host>/timesync/` answers 200; log in with a password.
2. Open a few images of every format the audit listed (WSI, z-stack, NIfTI, video, CZI/VSI, DICOM). Missing files from the audit show up here as "cannot be read".
3. A passkey login, if the host allows it (`FIDO_SERVER_ID`).
4. An annotation: create, edit, delete in a test image set of your own. Open an image with many annotations.
5. exact-sync: `EXACT_URL=https://<host> ... pytest tests/conformance/test_exact_sync.py` (read-only), or one of your notebooks.
6. The registration worker has announced itself: Administration → Plugins shows a registration plugin with a recent worker; start an automatic registration of two images.
7. Export an image set and compare with what production's export gives for the same set (the export templates are re-implemented).

## 7. Operating notes
* Logs: stdout of the units (`journalctl -u exact-server`). Slow requests and the helper processes (slideio, registration) log there.
* Update: stop, replace binary (and `frontend/dist`), `exact-cli migrate`, start.
* Throw away: stop both units, `dropdb exact_beta`, delete the file copy. Production is untouched.
* Known gaps: no window/level in the three-plane view, no editor for export formats, global annotations have no frame, no per-user rate limiting (hence the access restriction).

## 8. When many requests make it slow
The first look at a team with hundreds of image sets asks for a thumbnail of every cover, and a thumbnail of a whole-slide file means opening
the file on the storage. That is waiting for the disk, not computing, which is why the CPUs stay idle (`ps -eo stat,pid,args | awk '$1 ~ /^D/'`
lists the processes stuck in disk waits; `iostat -x 1` shows how busy the disks are, and `mount` whether the image store is a network file system).
What the server does about it:
* thumbnails are rendered a few at a time (`EXACT_THUMBNAIL_JOBS`, default 4; the CZI / VSI / DICOM ones through the Python helper have a queue of their own,
  `SLIDEIO_WORKERS`, default 4), a thumbnail asked for twice at once is rendered once, a file that cannot be read is not tried again for five minutes,
  and a thumbnail does not open a pool of handles or push the slides being viewed out of the cache;
* a rendered thumbnail is a small file in `EXACT_CACHE_DIR/thumbnails` and a browser keeps it: only the first look is slow;
* the home page draws 48 image sets at first ("Show more" adds more).

Render the covers ahead of the users, a few at a time (nights are best; Ctrl+C stops, what is done stays done):
```
scripts/warm-thumbnails.py --url https://<host> --user <name> --jobs 3              # the cover of every image set
scripts/warm-thumbnails.py --url https://<host> --user <name> --jobs 3 --all-images # every image (long)
```
If the storage is fast (local NVMe) raise `EXACT_THUMBNAIL_JOBS`; on slow network storage keep it low. Each helper process uses about 0.5 GB.
