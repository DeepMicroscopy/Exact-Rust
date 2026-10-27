#!/usr/bin/env bash
# Mutation parity: two copies of the same database, one served by Django (:8001), one by Rust (:8002); the same scripted
# writes run against both, responses and resulting rows are compared.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PY="$ROOT/reference/.venv/bin/python"
export DYLD_FALLBACK_LIBRARY_PATH="${FFMPEG_LIB_DIR:-/opt/miniconda3/envs/env311/lib}"
export SDKROOT="${SDKROOT:-/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk}"
export PGBIN="${PGBIN:-/Applications/Postgres.app/Contents/Versions/latest/bin}"
export DB_CONNECT_TIMEOUT=60
pkill -f "target/debug/exact-server" 2>/dev/null; pkill -f "manage.py runserver" 2>/dev/null; sleep 1
for db in exact_rust_test exact_django_test; do
  TARGET_DB=$db scripts/restore-backup.sh >/dev/null || exit 1
  SQL_DATABASE=$db reference/seed-users.sh >/dev/null 2>&1 || exit 1
done
SQL_DATABASE=exact_rust_test cargo run -q -p exact-cli -- migrate --confirm-db exact_rust_test >/dev/null || exit 1
cargo build -q -p exact-server || exit 1
(SQL_DATABASE=exact_django_test reference/run-django.sh runserver 127.0.0.1:8001 --noreload > reference/instance/django.log 2>&1 &)
(SQL_DATABASE=exact_rust_test EXACT_CACHE_DIR=$PWD/reference/instance/cache IMAGE_PATH=$PWD/reference/instance/images EXACT_LISTEN=127.0.0.1:8002 ./target/debug/exact-server > reference/instance/rust.log 2>&1 &)
for p in 8001 8002; do for i in $(seq 1 30); do curl -s -m 2 -o /dev/null "http://127.0.0.1:$p/timesync/" && break; sleep 1; done; done
cd tests/mutations
$PY -m pytest -q -x "${@:-.}" 2>&1 | cut -c1-400 | tail -60
rc=${PIPESTATUS[0]}
cd "$ROOT"; pkill -f "target/debug/exact-server"; pkill -f "manage.py runserver"
exit $rc
