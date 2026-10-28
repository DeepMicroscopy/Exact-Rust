#!/usr/bin/env bash
# Fresh scratch database, the Rust server on :8002 with the built UI, then the browser tests (frontend/e2e). Leaves the server running
# so that the result can be tried by hand; stop it with `pkill -f target/debug/exact-server`.
# Usage: scripts/run-e2e.sh [annotate|smoke|imageset|all]   (default: annotate)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export SDKROOT="${SDKROOT:-/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk}"
export DYLD_FALLBACK_LIBRARY_PATH="${FFMPEG_LIB_DIR:-/opt/miniconda3/envs/env311/lib}"
export PGBIN="${PGBIN:-/Applications/Postgres.app/Contents/Versions/latest/bin}"
pkill -f target/debug/exact-server 2>/dev/null; sleep 1
(cd frontend && pnpm -s build >/dev/null) || exit 1
make -s restore >/dev/null 2>&1 || { echo "restore failed"; exit 1; }
cargo build -q -p exact-server || exit 1
(SQL_DATABASE=exact_rust_test MEDIA_ROOT=$PWD/reference/instance/media IMAGE_PATH=$PWD/reference/instance/images EXACT_CACHE_DIR=$PWD/reference/instance/cache \
  EXACT_STATIC_DIR=$PWD/frontend/dist SLIDEIO_PYTHON=$PWD/reference/.venv/bin/python SLIDEIO_HELPER=$PWD/helpers/slideio_helper.py \
  REGISTRATION_PYTHON=/opt/miniconda3/envs/env311/bin/python REGISTRATION_HELPER=$PWD/helpers/registration_helper.py REGISTRATION_EXACT_DIR=$HOME/code/Exact/exact \
  EXACT_LISTEN=127.0.0.1:8002 nohup ./target/debug/exact-server > reference/instance/rust.log 2>&1 &)
for i in $(seq 1 30); do curl -s -m 2 -o /dev/null http://127.0.0.1:8002/api/version && break; sleep 1; done
cd frontend; rc=0
case "${1:-annotate}" in
  annotate) SHOTS=/tmp/shots node e2e/annotate.mjs || rc=$? ;;
  smoke) SHOTS=/tmp/shots node e2e/smoke.mjs || rc=$? ;;
  imageset) SHOTS=/tmp/shots node e2e/imageset.mjs || rc=$? ;;
  all) SHOTS=/tmp/shots node e2e/smoke.mjs && SHOTS=/tmp/shots node e2e/imageset.mjs && SHOTS=/tmp/shots node e2e/annotate.mjs || rc=$? ;;
esac
exit $rc
