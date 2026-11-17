---
title: Start from scratch
parent: Installation
nav_order: 1
---

# Start from scratch

A new EXACT-Rust on your own machine, without any earlier EXACT. At the end you log in at `http://localhost:8002` as the
administrator, with a first team, ready to [create an image set and upload slides](howto-team).

## What you need
* **Docker**: Docker Desktop on Windows and macOS, Docker Engine with the compose plugin on Linux (`docker compose version` answers).
* **git**, and about 10 GB of free disk for the image and the build.
* No GPU, no PostgreSQL, no Python: everything runs in the containers.

## Four steps
**1. Get the code:** on GitHub, **Code** → **Download ZIP** and unpack it, or
```
git clone https://github.com/DeepMicroscopy/Exact-Rust.git
cd Exact-Rust
```
Open a terminal in that folder (the one with `README.md` and `deploy`; Windows 11: right-click the folder → *Open in Terminal*).

**2. Write the settings.** Copy the example and open the copy in a text editor:

| | |
|---|---|
| Windows | `copy deploy\quickstart.env.example deploy\.env` and then `notepad deploy\.env` |
| macOS | `cp deploy/quickstart.env.example deploy/.env` and then `open -e deploy/.env` |
| Linux | `cp deploy/quickstart.env.example deploy/.env` and then `nano deploy/.env` |

Set the two passwords (the database's and your admin account's), the rest can stay:
```
SQL_PASSWORD=<any long random string>
EXACT_ADMIN_USER=admin
EXACT_ADMIN_PASSWORD=<your password>
EXACT_ADMIN_TEAM=My team
```

**3. Build and start**
```
docker compose -f deploy/quickstart.yml up -d --build
```
The first build takes 20 to 40 minutes (it compiles the server and installs the slide readers); later starts take seconds.
On its first start the server creates the database tables and your admin account (and the team). Watch it with
`docker compose -f deploy/quickstart.yml logs -f server` until it says `exact-server starting`.

**4. Log in** at **http://localhost:8002** with `EXACT_ADMIN_USER` and `EXACT_ADMIN_PASSWORD`. Change the password in the web
interface (your user name, top right → **Preferences**); you can then delete `EXACT_ADMIN_PASSWORD` from `deploy/.env`.

Next: [create a team and manage your images](howto-team): annotation types, an image set, uploads, annotating, export.
Invite colleagues under **Administration → Users** (there is no self-registration).

## Everyday commands
All from the repository folder; `-f deploy/quickstart.yml` selects this setup.

| | |
|---|---|
| stop / start | `docker compose -f deploy/quickstart.yml stop` / `... start` |
| update | `git pull`, then `docker compose -f deploy/quickstart.yml up -d --build` (the database is updated on start) |
| server log | `docker compose -f deploy/quickstart.yml logs -f server` |
| database backup | `docker compose -f deploy/quickstart.yml exec -T db pg_dump -Fc -U exact exact > exact-backup.dump` |
| remove everything | `docker compose -f deploy/quickstart.yml down -v` (deletes the database **and the slides** in the Docker volumes) |

**Where the files are:** slides, exports and thumbnails are in Docker volumes (`exact-rust_images`, `exact-rust_media`,
`exact-rust_cache`); they survive updates and restarts. To keep the slides in a folder you can see and back up, set
`IMAGE_PATH` in `deploy/.env` (see below) before uploading.

## Options (in `deploy/.env`)
* **Another port:** `EXACT_PORT=8080`.
* **Slides in a folder of your own:** `IMAGE_PATH=C:/exact-data/images` (Windows/macOS: any existing folder, forward slashes) or
  `IMAGE_PATH=/srv/exact/images` (Linux: the folder must belong to uid 1000, or set `CONTAINER_USER` to your `id -u`:`id -g`).
  `MEDIA_ROOT` and `EXACT_CACHE_DIR` work the same way.
* **Access from other machines:** `EXACT_BIND=0.0.0.0`, and put https in front (`deploy/Caddyfile.example`); then also
  `EXACT_COOKIE_SECURE=1` and `FIDO_SERVER_ID=<the host name>` (passkeys are bound to it).
* **Registration and analysis worker:** create its account under **Administration → Users → New worker account…**, paste the two
  lines it shows (`WORKER_USER=…`, `WORKER_PASSWORD=…`) into `deploy/.env` and start it:
  `docker compose -f deploy/quickstart.yml --profile worker up -d`. See [Plugins and workers](plugins).
* **DeeperHistReg** (a registration plugin based on PyTorch): `WITH_DEEPERHISTREG=1`, then `up -d --build`. A GPU and the other
  worker plugins are described in the [reference](DEPLOY#4c-gpu-for-the-registration-worker).

## When something goes wrong
| Message | Cause and fix |
|---|---|
| `required variable SQL_PASSWORD is missing` | `deploy/.env` does not exist yet: step 2. |
| `port is already allocated` | Something else uses port 8002: `EXACT_PORT=8080` in `deploy/.env`. |
| `EXACT_ADMIN_PASSWORD is still the example value` | Set a password of your own in `deploy/.env`. |
| `cannot write to /data/images (the host folder set as IMAGE_PATH ...)` | The folder in `IMAGE_PATH` is missing or belongs to someone else; the message says what to do. |
| Login works on `localhost` but not under another host name | Without https set `EXACT_COOKIE_SECURE=0`; better put https in front. |

The server container restarts until the cause is fixed; `docker compose -f deploy/quickstart.yml logs server` shows the message.
