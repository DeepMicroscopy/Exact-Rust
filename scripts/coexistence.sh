#!/usr/bin/env bash
# Coexistence: the unmodified Django EXACT (:8001) and the Rust server (:8002) on ONE database and ONE image store / MEDIA_ROOT, as they
# will run side by side in production. Restores a scratch database twice (the second copy, never migrated, is the reference for "the Rust
# migration only adds"), migrates the first with exact-cli, starts both servers, runs tests/coexistence, stops everything.
# Never touches `exact` or `exact_rust_test`. Usage: scripts/coexistence.sh [pytest args]   (env: KEEP=1 keeps the databases and folders, SERVE=1 only starts both servers and waits)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PY="$ROOT/reference/.venv/bin/python"
export DYLD_FALLBACK_LIBRARY_PATH="${FFMPEG_LIB_DIR:-/opt/miniconda3/envs/env311/lib}"
export SDKROOT="${SDKROOT:-/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk}"
export PGBIN="${PGBIN:-/Applications/Postgres.app/Contents/Versions/16/bin}"
export PATH="$PGBIN:$PATH" DB_CONNECT_TIMEOUT=60
DB=exact_coexist; PRISTINE=exact_coexist_pristine
WORK="$ROOT/reference/instance/coexist"
export IMAGE_PATH="$WORK/images" MEDIA_ROOT="$WORK/media" DATA_PATH="$WORK/data" EXACT_CACHE_DIR="$WORK/cache"
stop() { pkill -f "target/debug/exact-server.*coexist" 2>/dev/null; lsof -ti tcp:8001 | xargs kill 2>/dev/null; lsof -ti tcp:18002 | xargs kill 2>/dev/null; }
# the Rust server of this script listens on :18002 so that a development server on :8002 keeps running
trap 'stop; [ -n "${KEEP:-}" ] || { dropdb -h 127.0.0.1 -U exact --if-exists "$DB" 2>/dev/null; dropdb -h 127.0.0.1 -U exact --if-exists "$PRISTINE" 2>/dev/null; rm -rf "$WORK"; }' EXIT
stop; sleep 1
rm -rf "$WORK"; mkdir -p "$IMAGE_PATH" "$MEDIA_ROOT" "$DATA_PATH" "$EXACT_CACHE_DIR"
# The Django checkout may be newer than the dump (its models need columns the dump lacks), so each database gets its schema before it is
# seeded: the shared one from the Rust migration (Django's own `migrate` then has to go through on top of it: test_zz_django_migrate), the
# pristine one, the reference for "the Rust migration only adds", from Django's `migrate` (what Django alone would have made of the dump).
for db in "$DB" "$PRISTINE"; do
  TARGET_DB=$db scripts/restore-backup.sh >/dev/null || exit 1
  if [ "$db" = "$DB" ]; then
    SQL_DATABASE=$db cargo run -q -p exact-cli -- migrate --confirm-db $db >/dev/null || exit 1
  else
    SQL_DATABASE=$db DJANGO_SETTINGS_MODULE=settings_ref_coexist reference/run-django.sh migrate --noinput >/dev/null 2>&1 || exit 1
  fi
  SQL_DATABASE=$db reference/seed-users.sh >/dev/null 2>&1 || exit 1
done
SQL_DATABASE=$DB cargo run -q -p exact-cli -- migrate --confirm-db $DB >/dev/null || exit 1
cargo build -q -p exact-server || exit 1
(SQL_DATABASE=$DB DJANGO_SETTINGS_MODULE=settings_ref_coexist reference/run-django.sh runserver 127.0.0.1:8001 --noreload > "$WORK/django.log" 2>&1 &)
(SQL_DATABASE=$DB EXACT_LISTEN=127.0.0.1:18002 EXACT_STATIC_DIR=$PWD/frontend/dist exec -a "exact-server-coexist" ./target/debug/exact-server > "$WORK/rust.log" 2>&1 &)
for p in 8001 18002; do for i in $(seq 1 40); do curl -s -m 2 -o /dev/null "http://127.0.0.1:$p/timesync/" && break; sleep 1; done; done
if [ -n "${SERVE:-}" ]; then echo "both servers up on $DB: Django :8001, Rust :18002 (Ctrl+C stops)"; sleep 100000; exit 0; fi
cd tests/coexistence
DJANGO_URL=http://127.0.0.1:8001 RUST_URL=http://127.0.0.1:18002 COEX_DB=$DB COEX_PRISTINE_DB=$PRISTINE \
  "$PY" -m pytest -q "${@:-.}" 2>&1 | cut -c1-600 | tail -400
rc=${PIPESTATUS[0]}
exit $rc
