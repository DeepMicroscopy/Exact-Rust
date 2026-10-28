#!/usr/bin/env bash
# Full local verification: fresh scratch DB -> both servers -> read-only suites -> mutating suites -> stop.
# Order matters: the Django goldens describe the freshly seeded DB, the v2 suites create users/keys/invitations.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PY="$ROOT/reference/.venv/bin/python"
# libav* for video decoding (conda env on the dev machine; system libs elsewhere)
export DYLD_FALLBACK_LIBRARY_PATH="${FFMPEG_LIB_DIR:-/opt/miniconda3/envs/env311/lib}"
export SDKROOT="${SDKROOT:-/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk}"
export SQL_DATABASE=exact_rust_test DB_CONNECT_TIMEOUT=60
# registration worker / helper: the Python with qt-wsi-registration (the real worker test runs when it is importable)
export REGISTRATION_PYTHON="${REGISTRATION_PYTHON:-/opt/miniconda3/envs/env311/bin/python}" REGISTRATION_HELPER="$ROOT/helpers/registration_helper.py" REGISTRATION_EXACT_DIR="${REGISTRATION_EXACT_DIR:-$HOME/code/Exact/exact}"
"$REGISTRATION_PYTHON" -c 'import qt_wsi_reg' 2>/dev/null && export REG_E2E=1
fail=0
step() { echo; echo "=== $*"; }

pkill -f "target/debug/exact-server" 2>/dev/null; pkill -f "manage.py runserver" 2>/dev/null; sleep 1
step "cargo fmt/clippy/test"
cargo fmt --all -- --check && cargo clippy -q --workspace --all-targets -- -D warnings && cargo test --workspace -q 2>&1 | grep -E "test result|FAILED" | grep -v " 0 passed" || fail=1
step "frontend typecheck + unit tests"
if command -v pnpm >/dev/null; then (cd frontend && pnpm -s typecheck && pnpm -s test 2>&1 | grep -E "Tests|FAIL") || fail=1; else echo "pnpm not installed: skipped"; fi
step "restore scratch DB"
make -s restore >/dev/null 2>&1 || { echo "restore failed"; exit 1; }
cargo build -q -p exact-server
(reference/run-django.sh runserver 127.0.0.1:8001 --noreload > reference/instance/django.log 2>&1 &)
(MEDIA_ROOT=$PWD/reference/instance/media EXACT_CACHE_DIR=$PWD/reference/instance/cache SLIDEIO_PYTHON=$PWD/reference/.venv/bin/python SLIDEIO_HELPER=$PWD/helpers/slideio_helper.py IMAGE_PATH=$PWD/reference/instance/images EXACT_LISTEN=127.0.0.1:8002 ./target/debug/exact-server > reference/instance/rust.log 2>&1 &)
for p in 8001 8002; do for i in $(seq 1 30); do curl -s -m 2 -o /dev/null "http://127.0.0.1:$p/timesync/" && break; sleep 1; done; done
cd tests/conformance
step "Django reference (self-check: goldens vs Django)"
$PY -m pytest -q test_conformance.py 2>&1 | grep -E "^FAILED|passed|failed" | cut -c1-200
step "Rust: conformance vs Django goldens (read-only)"
EXACT_URL=http://127.0.0.1:8002 $PY -m pytest -q test_conformance.py 2>&1 | grep -E "^FAILED|passed|failed" | cut -c1-200
step "Rust: exact-sync interface (read-only)"
EXACT_URL=http://127.0.0.1:8002 $PY -m pytest -q test_exact_sync.py 2>&1 | grep -E "^FAILED|passed|failed" | cut -c1-200
step "Rust: v2 auth, passkeys, invitations (mutating)"
EXACT_URL=http://127.0.0.1:8002 $PY -m pytest -q test_v2_auth.py test_v2_passkeys.py test_v2_invitations.py test_v2_resources.py test_v2_annotation_writes.py test_v2_upload.py test_v2_image_sets.py test_v2_catalog.py test_v2_processing.py test_v2_move_image.py test_v2_admin.py test_v2_registration.py test_mock_worker.py test_v2_crop.py test_v2_export.py test_v2_segmentation.py 2>&1 | grep -E "^FAILED|passed|failed" | cut -c1-200
cd "$ROOT"; pkill -f "target/debug/exact-server"; pkill -f "manage.py runserver"
step "schema sync: shared tables, both creation orders"
PGBIN="${PGBIN:-/Applications/Postgres.app/Contents/Versions/latest/bin}" scripts/check-schema-sync.sh 2>&1 | grep -E "^(ok|FAIL)" || fail=1
echo; echo "(scratch DB now contains test-created users; run 'make restore' before the next conformance run)"
exit $fail
