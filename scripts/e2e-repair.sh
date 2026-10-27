#!/usr/bin/env bash
# Browser test of the one-time image repair on a *scratch copy* of a damaged TIFF (image 19 of the test DB):
# copies the file, starts a server on :8003 whose image root is the scratch folder, runs the test, cleans up.
# Needs the migrated scratch database (`make restore && make migrate`) and a built frontend (`make ui`).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
SRC=$(ls reference/instance/images/exact_1_1/TCGA-A1-A0SE-*2429.tiff | head -1)
TMP=$(mktemp -d); mkdir -p "$TMP/images/exact_1_1" "$TMP/cache"; cp "$SRC" "$TMP/images/exact_1_1/"
export DYLD_FALLBACK_LIBRARY_PATH="${FFMPEG_LIB_DIR:-/opt/miniconda3/envs/env311/lib}"
psql_bin=$(ls /Applications/Postgres.app/Contents/Versions/*/bin/psql 2>/dev/null | tail -1 || true)
[ -n "$psql_bin" ] && "$psql_bin" -h localhost -d exact_rust_test -qc "delete from exact_rust_image_repair" || true
SQL_DATABASE=exact_rust_test DB_CONNECT_TIMEOUT=60 IMAGE_PATH="$TMP/images" EXACT_CACHE_DIR="$TMP/cache" EXACT_LISTEN=127.0.0.1:8003 \
  ./target/debug/exact-server > "$TMP/server.log" 2>&1 &
PID=$!; trap 'kill $PID 2>/dev/null; rm -rf "$TMP"' EXIT
sleep 9
(cd frontend && SHOTS="${SHOTS:-/tmp/shots}" node e2e/repair.mjs http://127.0.0.1:8003 19 "$TMP/images/exact_1_1")
