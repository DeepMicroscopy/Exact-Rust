---
title: Running next to Django
nav_order: 13
---

# Running the Rust server next to the Django EXACT on the same data

The beta ([Installation](DEPLOY)) runs on a *copy*. This page is about the step after it: the Rust server and the unchanged Django EXACT
running **at the same time on the same PostgreSQL database and the same image store**, so that users can move over (and back) one by one.
Nothing is copied; both servers read and write the same rows and files. That is what has to be proven harmless.

## What is shared, what is not
| | |
|---|---|
| **Shared** | the database (users, teams, image sets, images, annotations, registrations, plugins, personal access tokens), the image store (`IMAGE_PATH`: uploads, pyramids, thumbnails), `MEDIA_ROOT` |
| **Separate** | browser sessions (a user logs in once on each server), passkey origin (`FIDO_SERVER_ID` of each host name), caches (`EXACT_CACHE_DIR`), the Rust server's own tables (`exact_rust_*`, additive) |

## The tests: `scripts/coexistence.sh`
```
scripts/coexistence.sh                 # everything (about 3 minutes, mostly the two database restores)
scripts/coexistence.sh test_files.py   # one file / pytest arguments
SERVE=1 scripts/coexistence.sh         # only start both servers (Django :8001, Rust :18002) on the scratch database, for trying things
```
It restores the dump twice into scratch databases (`exact_coexist`, and `exact_coexist_pristine` which stays as Django left it), migrates the first
with `exact-cli`, starts the **unmodified Django** (reference checkout) and the Rust server on it with **one** image store and one `MEDIA_ROOT`, and runs
`tests/coexistence/`. It never touches `exact` or `exact_rust_test`, and removes what it made (`KEEP=1` keeps it).

| Test file | What it proves |
|---|---|
| `test_schema_additive.py` | the Rust migration only **adds**: no column, type, constraint or index of Django changed or dropped; new columns of Django tables are nullable or have a default (Django's INSERTs keep working); no new constraint, unique index or trigger on a Django table; our tables never block Django's `delete()` (foreign keys cascade); Django's migration state and the dump's rows are untouched |
| `test_accounts.py` | accounts of Django log in on Rust and the reverse; a password changed on one server is the one the other checks (and Rust writes `pbkdf2_sha256`); wrong password and inactive accounts are refused by both; Django-made personal access tokens work on Rust, revocation and expiry are honoured by both, read-only tokens cannot write |
| `test_files.py` | image sets made by either server have their folder in the shared store (same permissions); an upload by one is served by the other (slide information, thumbnail, DZI, tiles identical); the same upload leaves the same row and file whichever server took it; deleting an image the other server uploaded removes row, annotations and every file |
| `test_annotations.py` | create on one server, change / verify / flag / delete on the other: both always show the same JSON; REST and legacy APIs meet in the same rows; **the answers of the REST writes have Django's shape** (exact-sync parses them); both stamp `time` in the same zone |
| `test_concurrency.py` | 40 simultaneous creates from both servers get distinct ids and the right rows; simultaneous updates of one annotation from both; a delete racing an update leaves no orphans; six simultaneous uploads of one file make no more duplicates than Django alone (Django alone lets all six in) |
| `test_zz_hygiene.py` | afterwards: no session idle in a transaction, no waiting lock, connection count of the two servers far below the limit |
| `test_zz_django_migrate.py` | `manage.py check` is clean; Django's own `migrate` goes through **on top of** the Rust migration and is then a no-op; the Rust migration goes through again on top of Django's; both servers still serve |

What the first run found and fixed: the Rust server answered `POST` / `PUT` / `PATCH` on `/api/v1/annotations/annotations/` with an expanded
annotation (objects for type, image, editor) where Django answers flat (ids), which is what `GET` shows and what exact-sync reads. The existing parity
suite never compared a *successful* write there (its test users get 403 on both). It now answers like Django.

## EXACT PR 169 (teams in the v1 API)
Django (since [PR 169](https://github.com/DeepMicroscopy/Exact/pull/169)) accepts `POST /api/v1/users/teams/` with only a `name` (the creator becomes admin) and ignores `members`, `image_sets`, `product_set` and `memberships` on `POST` / `PUT` / `PATCH`; before, `create_team` of exact-sync failed with a 400 and a `PUT` with empty lists detached the team's image sets. The Rust server does the same (`compat/team_writes.rs`: the name is validated like Django does, 3 to 100 characters and unique; only teams of the caller; `add_team` / `change_team` permissions), checked against Django in `tests/coexistence/test_teams.py`. Deleting a team on `/api/v1` stays 501 on Rust (`DELETE /api/v2/teams/<id>`).

The same Django update brought migration `processing/0015_registration_plugins`, which adds the columns and tables of the Rust migration 0007 with the same `IF NOT EXISTS` DDL: either side may run first (the suite seeds the shared database after the Rust migration and then runs Django's `migrate` on top).

## Known differences (not failures)
* **Personal access tokens cannot be created or revoked on the Rust server** (it validates them): until it can, they are made in Django's UI (`test_a_personal_access_token_can_be_made_on_rust` is an expected failure that turns into an error the day it works, so the note is removed).
* Django still accepts the token of a **deactivated** user; Rust refuses it (on purpose).
* `PUT` on the REST annotation endpoint: Django insists on `annotationversion_set` and `uploaded_media_files` in the body, Rust does not (a client that works on Django works on Rust).
* **No v1 REST create of image sets** on Rust (501; its own is `POST /api/v2/image-sets`); the old delete URL `GET /images/api/image/delete/<id>/` does not exist on Rust (`DELETE /api/v2/images/<id>`). exact-sync does not use either.
* A URL the Rust server does not implement answers with the web app's start page (status 200), not a 404, when the web app is served.
* Six simultaneous uploads of the same file: Django alone creates six images (it checks, then inserts, with no unique constraint); with both servers fewer. Not a coexistence problem.

## Before starting it on production: `scripts/coexistence-preflight.sh`
Read-only; run it as the database role and the operating-system user the Rust server will use, with the same `IMAGE_PATH`, `MEDIA_ROOT`, `TIME_ZONE` as Django:
```
SQL_HOST=... SQL_DATABASE=exact SQL_USER=... SQL_PASSWORD=... IMAGE_PATH=... MEDIA_ROOT=... TIME_ZONE=Europe/Berlin scripts/coexistence-preflight.sh
```
It checks: the role may create tables and owns the Django tables the migration alters; every password hash scheme is one the Rust server verifies; connections left for the Rust pool (10); no session idle in a transaction; `TIME_ZONE` is set; both folders exist and are writable (with owner, group, mode and umask printed); the newest image rows have their files under `IMAGE_PATH`. Then also run `scripts/audit-backup.sh` (data audit) and `exact-cli schema-check`.

What the tests on this machine **cannot** show, and the checklist for the day:
1. **Different operating-system users / containers**: a file one server creates must be deletable by the other. Same group, setgid folders, `umask 002` for both. The test only proves both servers create files with the same mode.
2. **`TIME_ZONE`** of the Rust server equal to Django's (the test fails if they differ; production's setting is what counts).
3. **Network file systems** (NFS locks, slow first thumbnails): [Installation §8](DEPLOY#8-when-many-requests-make-it-slow) (`warm-thumbnails.py`, `precompute-offsets`).
4. **Django's version in production** may differ from the reference checkout: run `scripts/check-schema-sync.sh` with `EXACT_DIR` at production's version, and this suite with the reference checkout switched to it.
5. Take a `pg_dump` first. Run `exact-cli migrate --confirm-db <name>` (additive, idempotent) before the first start of the Rust server; the server refuses to start without it.
6. Give the Rust server its own host name (or path) and a `FIDO_SERVER_ID` as in the beta; keep Django's. Users log in on each separately.
7. Rollback is stopping the Rust server: Django keeps working on the same database (the additive tables and columns stay; they cost nothing).
