#!/usr/bin/env bash
# The tables shared by EXACT (Django) and this port must have the same structure whichever side creates them.
# Builds two scratch databases from the backup: in A Django migrates first and the Rust migration second, in B the other
# way round; then compares the shared table(s) column by column and checks that Django's migration state is right.
# Needs the reference venv (reference/.venv), the backup dump and a PostgreSQL superuser (see restore-backup.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PGBIN="${PGBIN:-/Applications/Postgres.app/Contents/Versions/16/bin}"
SHARED_TABLES="${SHARED_TABLES:-images_pyramidregistration processing_plugin processing_pluginjob processing_pluginjobimage}"
PY="$ROOT/reference/.venv/bin/python"
# an EXACT checkout that contains the shared-table migration (default: ~/code/Exact; until the EXACT PR is merged use a worktree
# of its branch: git -C ~/code/Exact worktree add /tmp/exact-pr fix-slideio-level-registration, then copy the local,
# untracked exact/exact/settings.py into it)
EXACT_DIR="${EXACT_DIR:-$HOME/code/Exact}"
ls "$EXACT_DIR"/exact/exact/images/migrations/0041_pyramidregistration.py "$EXACT_DIR"/exact/exact/processing/migrations/0015_registration_plugins.py >/dev/null 2>&1 || { echo "SKIP - $EXACT_DIR has no images/0041_pyramidregistration and processing/0015_registration_plugins migrations (set EXACT_DIR to a checkout that does, e.g. a worktree of the registration-plugins branch); the Django side was not tested"; exit 0; }
export SDKROOT="${SDKROOT:-/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk}"
fail=0

django() {  # run manage.py migrate (the apps with shared tables) against database $1
  for app in images processing; do
    (cd "$EXACT_DIR/exact" && PYTHONPATH="$ROOT/reference:$EXACT_DIR/exact" DJANGO_SETTINGS_MODULE=settings_ref_db \
       DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib SQL_HOST=127.0.0.1 SQL_DATABASE="$1" SQL_USER=exact SQL_PASSWORD=exact \
       "$PY" manage.py migrate $app --noinput 2>&1 | grep -E "Applying (images|processing)|No migrations to apply|Error" | sed 's/^/    /')
  done
}
rust() {    # run the Rust migrations against database $1
  SQL_DATABASE="$1" cargo run -q -p exact-cli -- migrate --confirm-db "$1" 2>&1 | sed 's/^/    /'
}
columns() { # name type nullable default of every column of table $2 in database $1
  "$PGBIN/psql" -h 127.0.0.1 -d "$1" -Atc "select column_name||' '||data_type||' null='||is_nullable||' default='||coalesce(regexp_replace(column_default,'nextval.*','serial'),'-') from information_schema.columns where table_name='$2' order by ordinal_position"
}

for db in exact_sync_a exact_sync_b; do TARGET_DB=$db scripts/restore-backup.sh >/dev/null; done
echo "A: Django first, then Rust"; django exact_sync_a; rust exact_sync_a
echo "B: Rust first, then Django"; rust exact_sync_b; django exact_sync_b
for t in $SHARED_TABLES; do
  if diff <(columns exact_sync_a "$t") <(columns exact_sync_b "$t") >/dev/null && [ -n "$(columns exact_sync_a "$t")" ]; then
    echo "ok   - $t has the same columns whichever side created it"
  else
    echo "FAIL - $t differs:"; diff <(columns exact_sync_a "$t") <(columns exact_sync_b "$t") || true; fail=1
  fi
done
for db in exact_sync_a exact_sync_b; do
  for m in "images 0041_%" "processing 0015_%"; do
    n=$("$PGBIN/psql" -h 127.0.0.1 -d $db -Atc "select count(*) from django_migrations where app='${m% *}' and name like '${m#* }'")
    [ "$n" = "1" ] && echo "ok   - $db: Django has recorded the ${m% *} migration" || { echo "FAIL - $db: the ${m% *} migration is not recorded"; fail=1; }
  done
done
# the Rust server's expectation of the layout (the schema baseline) must match what the databases now contain
for db in exact_sync_a exact_sync_b; do
  if SQL_DATABASE=$db cargo run -q -p exact-cli -- schema-check baseline/schema-local-20261027.json >/dev/null 2>&1; then echo "ok   - $db matches the schema baseline"
  else echo "FAIL - $db differs from baseline/schema-local-20261027.json (regenerate it with schema-dump after a deliberate change)"; fail=1; fi
done
for db in exact_sync_a exact_sync_b; do "$PGBIN/psql" -h 127.0.0.1 -d postgres -qc "DROP DATABASE IF EXISTS $db WITH (FORCE)"; done
exit $fail
