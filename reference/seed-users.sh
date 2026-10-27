#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PYTHONPATH="$HERE:$HOME/code/Exact/exact" DJANGO_SETTINGS_MODULE=settings_ref_db
export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib SQL_HOST=127.0.0.1 SQL_DATABASE="${SQL_DATABASE:-exact_rust_test}" SQL_USER=exact SQL_PASSWORD=exact
cd "$HOME/code/Exact/exact"
exec "$HERE/.venv/bin/python" "$HERE/seed_test_users.py"
