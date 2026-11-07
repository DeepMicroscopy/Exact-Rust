---
title: Installation
nav_order: 12
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
| Accounts | the PostgreSQL role the server uses; an account for the registration worker: in the beta, **Administration → Users → New worker account…** creates it (permissions, teams, password; see [Administration](administration)); an existing ML/worker account works too if it has `processing.add_plugin`, `processing.change_pluginjob` and `images.change_imageregistration` and is a member of the teams to serve |
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
dc up -d
```
The server container applies the migrations itself on every start (its entrypoint runs `exact-cli migrate --confirm-db "$SQL_DATABASE"` first; `EXACT_AUTO_MIGRATE=0` in `exact.env` turns that off). Restore the dump *before* the first start of the server: migrating an empty database first would make `pg_restore` collide with the tables that already exist.
(`dc` is the alias from the compose file's header; a dump of the production PostgreSQL 12 restores into 16.) A dump of the beta: `dc exec -T db pg_dump -Fc -U "$SQL_USER" "$SQL_DATABASE" > beta.dump`; throw it all away: `dc down -v`.

**Native** (existing PostgreSQL):
```
createdb -O exact exact_beta
pg_restore --no-owner --role=exact -d exact_beta production.dump        # scripts/restore-backup.sh does the same for a scratch DB
```
The beta must not be called `exact` (the tools refuse it). **Run `ANALYZE` after the restore** (`dc exec -T db psql -U "$SQL_USER" -d "$SQL_DATABASE" -c 'ANALYZE'`, a minute for a database of this size): a restored database has no statistics for PostgreSQL's planner until its background job has caught up, and lists over the big tables (images, annotations) can be several times slower until then (measured: 110-175 ms instead of 30 ms for a page of 100 images on a synthetic copy of the size of production). Then add the beta's own additive tables and columns (idempotent,
safe to repeat; Django's data stays as it is):
```
SQL_DATABASE=exact_beta ... exact-cli migrate --confirm-db exact_beta
```
`migrate` is not run by the server binary on start: run it after every update of the binary (the Docker image does it in its entrypoint).

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

## 4c. GPU for the registration worker
The image carries the CUDA build of PyTorch and `docker-compose.yml` reserves one NVIDIA GPU for the worker; DeeperHistReg uses it when
torch sees one (a registration of a pair of large slides takes about 30 s on an RTX 2060 instead of minutes). The host needs the NVIDIA
driver and the NVIDIA Container Toolkit (`nvidia-ctk`); with rootless Docker also
`nvidia-ctk runtime configure --runtime=docker --config=$HOME/.config/docker/daemon.json`, `nvidia-container-cli.no-cgroups = true`
in `/etc/nvidia-container-runtime/config.toml` and `systemctl --user restart docker`. Check it:
`dc run --rm worker nvidia-smi` and `dc run --rm worker python -c "import torch; print(torch.cuda.is_available())"`.
A 6 GB card registers affine at any size and deformable at a registration size of 1024-2048; if a job fails with "CUDA out of memory",
lower the size. **Without a GPU** (or without the toolkit: "could not select device driver nvidia") add the second file,
`dc -f deploy/docker-compose.cpu.yml up -d` (Docker Compose 2.24+), and build with
`--build-arg TORCH_INDEX=https://download.pytorch.org/whl/cpu` to save about 2 GB.

## 4e. Mitotic figure detection (MIDOG 2025 baseline)
The worker also serves the image analysis plugin **MIDOG 2025 Baseline FCOS MIDOG++** (`helpers/plugins/midog2025_fcos.py`, a port of the
QueueRunner plugin of the MIDOG 2025 reference algorithm). It finds mitotic figures in a slide and stores them as a plugin result (an entry of *Mitotic Figures*
with the detections as annotations with a score, and the threshold 0.548 as the default). **The new web interface does not show plugin results yet**: read them with the API
(`/api/v2/plugin-results`, `/api/v2/plugin-result-annotations`) or exact-sync, or look at them in the Django EXACT, which shows them with a threshold slider. Needs: (1) the checkpoint `FCOS_x50.ckpt` of the reference (373 MB, not in the repository) in the folder
`MODELS_PATH` (default `deploy/models`), mounted at `/models`; without it the worker says "plugin not served: the checkpoint ... is missing"
and carries on with the others; (2) the worker account needs `processing.change_pluginjob` (it has it if it serves registrations) and has
to be a member of the teams whose images it serves; (3) the image set needs an annotation type whose name contains "mitotic figure" in a
product that is applied to the set, as with QueueRunner (the job fails with "Missing annotation type" otherwise). Start a job with
`POST /api/v2/plugin-jobs {"plugin": <id>, "image": <id>}` (the beta's UI has no button for analysis jobs yet; EXACT's own UI and exact-sync can create them).
The GPU of the registration worker is used when torch sees one; on a CPU a patch takes about 4 s (measured on a laptop), so a slide needs a GPU
(not measured here: no GPU on the development machine; the first production job tells).
Parameters (the plugin defaults decide today; `det_thresh` 0.548 and `overlap` 0.3 are the reference's values; `half_precision` runs the GPU in
float16, lighter and faster, scores differ in the third decimal). Differences to the reference are listed at the top of the plugin file:
the model is loaded once, patches that the border clipping produced twice are run once, images without a pyramid and smaller than a patch work,
and a job's detections are stored in one request (`POST /api/v2/plugin-jobs/{id}/complete`) so that a job never keeps half a result.

## 4d. System health
The pulse icon for site admins needs nothing but the compose file, except for the RAID: a cron job on the host (`deploy/host-status.py`)
writes its state into `HOST_STATUS_DIR`. Setup and what is checked: [System health](system-health.html).

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
6b. (Optional) Automatic segmentation: `docker compose --profile segmentation up -d` starts `segment-worker` (account in `exact.env`: `SEGMENT_WORKER_USER`,
   `SEGMENT_WORKER_PASSWORD`; permissions and teams as in [Administration](administration), "Segmentation worker"). It needs no image mount. Check:
   `GET /api/v2/segmenters` lists "Threshold". No trained model is shipped; a deep-learning model is connected through `helpers/segmenters/nnunet_example.py`.
7. Export an image set and compare with what production's export gives for the same set (the export templates are re-implemented).

## 7. Operating notes
* Logs: stdout of the units (`journalctl -u exact-server`). Slow requests and the helper processes (slideio, registration) log there.
* Update: stop, replace binary (and `frontend/dist`), `exact-cli migrate`, start. (With the Docker setup: `dc build`, `dc up -d`; the migration runs when the server container starts.) The server refuses to start on a database that was not migrated for its version and says so in the log.
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
* the home page draws 48 image sets at first (scrolling to the end of the list adds more).

Render the covers ahead of the users, a few at a time (nights are best; Ctrl+C stops, what is done stays done):
```
scripts/warm-thumbnails.py --url https://<host> --user <name> --jobs 3              # the cover of every image set
scripts/warm-thumbnails.py --url https://<host> --user <name> --jobs 3 --all-images # every image (long)
```
CZI, VSI, DICOM and OME / generic TIFF slides need their pyramid level offsets measured once (5–8 s per file); the server stores them in
`images_pyramidregistration`, but the first person to open a slide would wait. Measure them all ahead of time (reads the files, writes only that table; what is
stored is skipped, so it can be repeated and interrupted; `--dry-run` lists, `--limit N` tries a few):
```
dc exec server exact-cli precompute-offsets --jobs 2
```
A file that is replaced later (size or date changed) is measured again by the server on its first opening.

**NRRD files that were uploaded as images.** The old EXACT accepted 3D Slicer segmentations (`.nrrd`, `.seg.nrrd`) as images that it could not show. The Rust server keeps them
as they are (a broken card, "The slide cannot be read"), and offers the person who clicks one to convert it to a *segmentation file* (see the user guide). To convert
them all at once:
```
dc exec server exact-cli convert-nrrd-images --dry-run                      # lists what would be converted and what is left alone, and why
dc exec server exact-cli convert-nrrd-images --confirm-db "$SQL_DATABASE"   # does it
```
The file stays where it is; the image row (it can show nothing) is replaced by an unlinked segmentation file of the same image set, which is then linked to its
volume in the browser (the link dialog suggests the volume by name). An NRRD image with annotations, registrations or crops, an unreadable file (not an integer
label map) or a missing file is left alone and reported. Run the dry run on a copy of the production database first; the command can be repeated.

If the storage is fast (local NVMe) raise `EXACT_THUMBNAIL_JOBS`; on slow network storage keep it low. Each helper process uses about 0.5 GB.

Finding what is slow on the real data: set `EXACT_SLOW_SQL_MS=100` in `exact.env` and restart the server; every database statement slower than that is then logged as a
warning (`slow statement: …`, with the statement and how long it took) in `dc logs server`. Unset it again afterwards.

## 9. The greeting for new users
Everybody who has not been on this server before sees a short "what's new" dialog once after their first login (what is different from the EXACT they know; the server remembers per
user that it was shown, in `exact_rust_user_flags.welcomed_at`). "What's new" in the top bar opens it again. For a beta on a copy of production, say so at the top of it:
`EXACT_WELCOME_NOTICE="This is a beta on a copy of the production data: what you change here does not reach the production EXACT."` in `exact.env`. Everybody in a freshly restored database counts as new;
`exact-cli migrate` adds the column (migration 0010), and the server refuses to start without it. To show the greeting to somebody again: `UPDATE exact_rust_user_flags SET welcomed_at = NULL WHERE user_id = ...`.

## 10. Production next to the running Django (the same database and image store)
The steps below are what was done on the production host (rootless Docker; EXACT's own compose project with `web`, `db` (PostgreSQL 12), `nginx`). What the tests
cannot show is in [Coexistence](coexistence); run `scripts/coexistence.sh` and `scripts/coexistence-preflight.sh` first.

1. **Backup** with the client of the database's own container (a dump of a newer client may not restore into 12): `docker compose exec -T db pg_dump -Fc -U "$SQL_USER" "$SQL_DATABASE" > exact-pre-rust.dump`.
2. **A compose project of its own** (`deploy/docker-compose.prod.yml`, `name: exact-rust-prod`): one service for the server (and one for the registration worker), no database
   service, `IMAGE_MODE` read-write for the server and read-only for the worker, `CONTAINER_USER` the user Django writes as (with rootless Docker container root is the host user, `0:0`), and
   `EXACT_AUTO_MIGRATE=0` so that the first start does not migrate by surprise. The database settings come from Django's `env.prod` (`SQL_DATABASE`, `SQL_USER`, `SQL_PASSWORD`; `TIME_ZONE` must equal Django's).
3. **Reaching the database:**
   * with rootless Docker a container cannot reach the host (`host.docker.internal` times out): join the compose network of Django's database (`networks: [djnet]`, `external: true`, `name: <django project>_default`);
   * use the database container's **name** as `SQL_HOST` (`exact-db-1`), not `db`: a container on two networks resolves `db` to whichever database answers first (a beta's `db` on the other network made the login fail with "password authentication failed" although the password was right; check with `getent hosts <name>` inside the container).
4. **Look before migrating**, on a scratch PostgreSQL in a throw-away container (the database role usually has no `CREATEDB`, and the production server is left alone): restore the dump, run `scripts/audit-backup.sh`, `exact-cli migrate`
   (twice: the second run is a no-op), `exact-cli schema-check`, `exact-cli audit-passkeys` against it, then remove it.
5. **Migrate the live database once, by hand**, with the fresh dump taken just before: `docker compose -f deploy/docker-compose.prod.yml run --rm --no-deps exact-rust-prod exact-cli migrate --confirm-db "$SQL_DATABASE"`; then start the server. Django keeps running throughout.
6. **nginx** (its configuration is baked into the image when it is built from a `nginx/` folder: rebuild and recreate only that service): point the host name at the Rust container by its service name (`set $x http://exact-rust-prod:8002;` with `resolver 127.0.0.11`), the container has to be on a network nginx is on.
7. **System health** needs `EXACT_HOST_STATUS_FILE` and the folder `deploy/host-status.py` writes mounted read-only, and the GPU reservation of the server for the GPU row; the registration worker needs its account (`WORKER_USER`, `WORKER_PASSWORD`) and the same GPU reservation.

**PostgreSQL 12.** Production runs 12; the server must not use anything newer. `gen_random_uuid()` is built in only from 13 (annotations could not be created until the UUID was generated by the server). Test against the production version when you can.

**Updating:** `scripts/update-prod.sh` (pulls, builds, migrates, recreates the containers, waits for the server and goes back to the previous image if it does not answer; `--no-pull` skips the pull, `--rollback` goes back to the image the last update replaced).

**Rollback:** `docker compose -f deploy/docker-compose.prod.yml down` and point nginx back. Django is untouched; the tables and columns the migration added do no harm.
