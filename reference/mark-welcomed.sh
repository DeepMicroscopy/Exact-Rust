#!/usr/bin/env bash
# The users of the scratch database have seen the first-login greeting (it would stand in the way of every browser test); users that a test
# creates have not. Run after the Rust tables exist (make migrate).
set -euo pipefail
PGBIN="${PGBIN:-/Applications/Postgres.app/Contents/Versions/latest/bin}"
"$PGBIN/psql" -q -h 127.0.0.1 -U exact -d "${SQL_DATABASE:-exact_rust_test}" -c \
  "INSERT INTO exact_rust_user_flags (user_id, read_only, welcomed_at) SELECT id, false, now() FROM users_user ON CONFLICT (user_id) DO UPDATE SET welcomed_at = now()"
