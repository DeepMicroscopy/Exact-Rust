#!/usr/bin/env bash
# Recreate the scratch database exact_rust_test from a pg_dump (-Fc) backup.
# Never touches the live `exact` database (read-only source is the dump file).
# Usage: scripts/restore-backup.sh [backups/<dump>]   (default: newest backups/exact-local-*.dump)
set -euo pipefail
PGBIN="${PGBIN:-/Applications/Postgres.app/Contents/Versions/16/bin}"
PGHOST="${PGHOST:-127.0.0.1}"
ADMIN="${PG_ADMIN_USER:-$(whoami)}"      # superuser able to CREATE DATABASE
APPUSER="${APP_DB_USER:-exact}"
TARGET="${TARGET_DB:-exact_rust_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DUMP="${1:-$(ls -t "$ROOT"/backups/exact-local-*.dump | head -1)}"

[ "$TARGET" != "exact" ] || { echo "refusing to restore over live 'exact' DB" >&2; exit 1; }
[ -f "$DUMP" ] || { echo "dump not found: $DUMP" >&2; exit 1; }
echo "restoring $DUMP -> $TARGET"
"$PGBIN/psql" -h "$PGHOST" -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 -q <<SQL
DROP DATABASE IF EXISTS $TARGET WITH (FORCE);
CREATE DATABASE $TARGET OWNER $APPUSER;
SQL
"$PGBIN/pg_restore" -h "$PGHOST" -U "$ADMIN" -d "$TARGET" --no-owner --role="$APPUSER" "$DUMP"
"$PGBIN/psql" -h "$PGHOST" -U "$ADMIN" -d "$TARGET" -Atc \
  "select 'images='||(select count(*) from images_image)||' annotations='||(select count(*) from annotations_annotation)||' users='||(select count(*) from users_user)"
