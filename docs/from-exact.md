---
title: Moving from EXACT
parent: Installation
nav_order: 2
---

# Moving from EXACT (Django) to EXACT-Rust

EXACT-Rust runs on **your existing EXACT database and image folders**: same users, passwords, API tokens, teams, image sets and
annotations; exact-sync and QueueRunner scripts keep working. It changes nothing in Django's tables, it only adds a few of its own,
so Django can keep running next to it and you can go back at any time. What is different is listed in
[Changes from the Django version](django-differences).

The move has three stages. Each one can be stopped and undone.

| Stage | What runs | Risk |
|---|---|---|
| **1. Try it on a copy** | EXACT-Rust on a copy of the database (and, ideally, of the slides) | none: production is not touched |
| **2. Run both** | EXACT-Rust and Django on the *same* database and image store, on two host names | low: both see the same data; Django stays the fallback |
| **3. Switch off Django** | EXACT-Rust only | when the last user has moved |

## Stage 1: try it on a copy
Uses `deploy/docker-compose.yml` (PostgreSQL in a container, the server, the registration worker) on any machine with Docker.

**1. Take a dump of the EXACT database.** In the folder of EXACT's docker compose (its database service is called `db`):
```
docker compose exec -T db pg_dump -Fc -U <SQL_USER> <SQL_DATABASE> > exact.dump
```

**2. Settings.** In the EXACT-Rust repository: `cp deploy/exact.env.example deploy/exact.env` and set
* `SQL_DATABASE`, `SQL_USER`, `SQL_PASSWORD`: for the *new* database container (any values; not production's);
* `IMAGE_PATH`, `MEDIA_ROOT`, `EXACT_CACHE_DIR`: host folders. `IMAGE_PATH` is a **copy** of EXACT's image folder
  (or the real one with `IMAGE_MODE=ro`, view-only: uploads, moves and crops then fail, nothing on disk can change);
* `TIME_ZONE` as in EXACT; `FIDO_SERVER_ID` the host name you will open (passkeys enrolled in EXACT work only on the same host name).

Do **not** set `EXACT_ADMIN_USER`: your EXACT accounts come with the dump.

**3. Restore and start**
```
alias dc='docker compose --env-file deploy/exact.env -f deploy/docker-compose.yml'   # PowerShell: function dc { docker compose --env-file deploy/exact.env -f deploy/docker-compose.yml @args }
dc build                       # 20-40 minutes the first time
dc up -d db
dc exec -T db pg_restore --no-owner --role=<SQL_USER> -U <SQL_USER> -d <SQL_DATABASE> < exact.dump
dc up -d                       # the server adds its tables on start
```
Without an NVIDIA GPU add `-f deploy/docker-compose.cpu.yml` to `dc` (see the [reference](DEPLOY#4c-gpu-for-the-registration-worker)).
Restore **before** the first `dc up -d`: on an empty database the server would create a new, empty EXACT layout, and the restore would collide with it.

**4. Log in** at `http://localhost:8002` with your usual EXACT account. Then check what matters to you: open slides of every
format you use, annotate in a test image set, run exact-sync or a notebook against it, export a set. The full checklist,
the read-only audit of the dump (`scripts/audit-backup.sh`: missing files, passkeys, sizes) and the registration worker are
in the [reference](DEPLOY), sections 4 to 6.

To start over: `dc down -v` and restore again.

## Stage 2: run both on the same data
EXACT-Rust gets its own host name next to Django's and uses the production database and image store directly. Users move over
one by one; whatever they do is visible in Django at once, and the other way round.
1. Read [Running next to Django](coexistence) (what is shared, the known differences) and run `scripts/coexistence-preflight.sh`
   against production; it only reads.
2. Take a fresh `pg_dump` and keep it.
3. Set up EXACT-Rust as in the worked example of the production host: [Reference §10](DEPLOY#10-production-next-to-the-running-django-the-same-database-and-image-store)
   (its own compose project without a database, the container networks, `IMAGE_MODE` read-write, PostgreSQL 12, the update script).
   Migrate once by hand (`exact-cli migrate`); it only adds tables and columns.
4. Give the new host name to a few users first, then to everyone; move workers over (they use `/api/v2`, or keep QueueRunner on `/api/v1`).

**Going back:** stop the EXACT-Rust container and point the host name back to Django. Django never noticed.

## Stage 3: switch off Django
When nobody uses Django any more, stop its web container. Keep its database container (EXACT-Rust uses it) or move the database
into EXACT-Rust's own compose project with a dump and restore. The tables EXACT-Rust added stay; the tables only Django used do no harm.
