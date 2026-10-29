# Beta installation on a copy of the production data

Goal: the Rust server on a **copy** of the production database and image files, next to (never instead of) the running
Django. Nothing here touches production. Rollback is "stop the beta": Django keeps working on its own database, and the
additive tables/columns the beta adds exist only in the copy.

## 0. What you need
| | |
|---|---|
| Host | Linux (or macOS) with PostgreSQL 16, disk for a copy of the image store, an https host name |
| Database | the production `pg_dump -Fc` (custom format) |
| Files | the production image store (`IMAGE_PATH`: folders `exact_<team>_<set>/`) and `MEDIA_ROOT` (aux files, plugin icons, registration files, exports) |
| Accounts | the PostgreSQL role the server uses; an EXACT account with the permissions `images.change_imageregistration` and `processing.change_pluginjob` for the registration worker (an existing ML/worker account or a superuser) |
| Name | passkeys only work on the host name they were enrolled for: **`FIDO_SERVER_ID=exact.hs-flensburg.de`** works on that host and below it. On any other host everyone enrolls a new passkey (passwords keep working) |

## 1. Files: always a copy
The server **writes** to the image store (uploads, moving and deleting images, pyramid repair, crops). Never point the beta at the
production folders. Use a copy that costs no extra disk where the file system can: `cp -cR` (macOS/APFS), `cp -a --reflink=auto`
(btrfs/XFS), or `rsync -a`. Keep the beta's `EXACT_CACHE_DIR` (thumbnails, can be deleted) and `EXACT_NIFTI_CACHE` (inflated
`.nii.gz` volumes, grows) on their own folders.

## 2. Database
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
(systemd) or the container: `docker build -f deploy/Dockerfile -t exact-rust .` and `deploy/docker-compose.yml` (one image for the server, the worker and `exact-cli`; build it on the target architecture: `slideio` has wheels for Linux x86_64 only, an arm64 build works without CZI/VSI/DICOM and says so; tested: image builds, server starts and serves the UI and API, the worker's Python imports `qt_wsi_reg`).
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
