#!/usr/bin/env bash
# Run the reference Django (unmodified EXACT) against exact_rust_test (or $SQL_DATABASE) on :8001.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PYTHONPATH="$HERE:$HOME/code/Exact/exact"
export DJANGO_SETTINGS_MODULE=settings_ref_db
export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib
export SQL_HOST=127.0.0.1 SQL_DATABASE="${SQL_DATABASE:-exact_rust_test}" SQL_USER=exact SQL_PASSWORD=exact
cd "$HOME/code/Exact/exact"
exec "$HERE/.venv/bin/python" manage.py "${@:-runserver 127.0.0.1:8001 --noreload}"
