#!/usr/bin/env bash
# Read-only checks before the Rust server is started next to the running Django EXACT on the SAME database and image store.
# Changes nothing (SELECTs only, no writes to the folders). Run it as the PostgreSQL role and the operating-system user the Rust server will use.
#   SQL_HOST SQL_PORT SQL_DATABASE SQL_USER SQL_PASSWORD   as for the server (PGPASSWORD is taken from SQL_PASSWORD)
#   IMAGE_PATH MEDIA_ROOT                                    the folders the Rust server will be given (the same ones Django uses)
#   TIME_ZONE                                                what Django's settings say; the Rust server must be given the same
# Exit status 1 when a check FAILs; WARN and INFO lines are for a human to read.
set -uo pipefail
export PGPASSWORD="${SQL_PASSWORD:-${PGPASSWORD:-}}"
PSQL=(psql -h "${SQL_HOST:-127.0.0.1}" -p "${SQL_PORT:-5432}" -U "${SQL_USER:-exact}" -d "${SQL_DATABASE:?set SQL_DATABASE}" -Atq -v ON_ERROR_STOP=1)
fail=0
ok()   { echo "PASS  $*"; }
warn() { echo "WARN  $*"; }
bad()  { echo "FAIL  $*"; fail=1; }
info() { echo "INFO  $*"; }
q() { "${PSQL[@]}" -c "$1"; }

q "select 1" >/dev/null 2>&1 || { echo "FAIL  cannot connect to $SQL_DATABASE as ${SQL_USER:-exact}"; exit 1; }
info "PostgreSQL $(q 'show server_version') ($(q 'select current_user') on $(q 'select current_database()'))"

# 1. the Rust migration needs to create tables and to ALTER the Django tables it adds columns to: ownership
[ "$(q "select has_schema_privilege(current_user, 'public', 'CREATE')")" = t ] && ok "the role may create tables in public" || bad "the role may not create tables in schema public (exact-cli migrate needs it)"
notowned=$(q "select string_agg(tablename, ', ') from pg_tables where schemaname = 'public' and tablename in ('images_image','images_imageset','processing_plugin','processing_pluginjob','users_user') and not pg_has_role(current_user, tableowner, 'USAGE')")
[ -z "$notowned" ] && ok "the role owns (or is a member of the owner of) the Django tables the migration alters" || bad "tables the migration alters belong to someone else: $notowned"

# 2. passwords: every hash scheme in use must be one the Rust server verifies (and Django keeps verifying what Rust writes: pbkdf2_sha256)
schemes=$(q "select coalesce(nullif(split_part(password, '\$', 1), ''), '(empty)') s, count(*) from users_user group by 1 order by 2 desc" | tr '\n' ' ')
info "password hash schemes: $schemes"
unsupported=$(q "select string_agg(distinct s, ', ') from (select split_part(password, '\$', 1) s from users_user where password not like '!%' and password <> '') t where s not in ('pbkdf2_sha256','pbkdf2_sha1','argon2','bcrypt_sha256','bcrypt')")
[ -z "$unsupported" ] && ok "all password hashes are of a scheme the Rust server verifies" || bad "password schemes the Rust server cannot verify: $unsupported"

# 3. Django's migration state (informational: the Rust migration is idempotent on both orders, see scripts/check-schema-sync.sh)
info "latest Django migrations: $(q "select string_agg(app || '/' || name, '  ' order by app) from (select distinct on (app) app, name from django_migrations where app in ('images','processing','users','annotations') order by app, id desc) t")"
q "select 1 from django_migrations where app = 'processing' and name like '0015%'" | grep -q 1 && info "processing/0015 (registration plugins) is applied by Django" || info "processing/0015 is not applied by Django: the Rust migration adds the same columns, Django's later migration finds them present"

# 4. connections: the Rust server holds a pool of up to 10 next to Django's own
max=$(q "show max_connections"); used=$(q "select count(*) from pg_stat_activity")
[ $((used + 10)) -lt $((max * 8 / 10)) ] && ok "connections: $used in use of $max, room for the Rust pool (10)" || warn "connections: $used in use of $max; the Rust pool (up to 10) would take it above 80 %"
idle=$(q "select count(*) from pg_stat_activity where state like 'idle in transaction%' and datname = current_database()")
[ "$idle" = 0 ] && ok "no session idle in a transaction" || warn "$idle sessions are idle in a transaction (Django's? they hold locks the Rust server would wait for)"

# 5. what exists of ours already
info "tables of the Rust server already present: $(q "select count(*) from pg_tables where schemaname = 'public' and tablename like 'exact_rust_%'")"

# 6. time zone: naive local timestamps are written by both servers
if [ -z "${TIME_ZONE:-}" ]; then warn "TIME_ZONE is not set: give the Rust server Django's TIME_ZONE or rows it writes are stamped in another zone"; else ok "TIME_ZONE=$TIME_ZONE (must equal Django's setting)"; fi

# 7. folders: the same ones, writable, with permissions the other server's user can use
for v in IMAGE_PATH MEDIA_ROOT; do
  d="${!v:-}"
  if [ -z "$d" ]; then warn "$v is not set"; continue; fi
  [ -d "$d" ] || { bad "$v=$d is not a folder"; continue; }
  probe="$d/.coexistence-probe-$$"
  if ( : > "$probe" ) 2>/dev/null; then rm -f "$probe"; ok "$v is writable for $(id -un)"; else bad "$v=$d is not writable for $(id -un)"; fi
  newest=$(ls -1t "$d" 2>/dev/null | head -1)
  [ -n "$newest" ] && info "$v: newest entry '$newest' $(ls -ld "$d/$newest" | awk '{print $1, $3, $4}'); this user's umask $(umask) (folders and files one server creates must be usable by the other server's user: same group, group-writable)"
  info "$v: $(df -h "$d" | awk 'NR==2 {print $4 " free, " $5 " used"}')"
done

# 8. the image rows point at files the Rust server can see
if [ -n "${IMAGE_PATH:-}" ] && [ -d "$IMAGE_PATH" ]; then
  total=0; missing=0
  while IFS='|' read -r path file; do
    total=$((total + 1)); [ -e "$IMAGE_PATH/$path/$file" ] || missing=$((missing + 1))
  done < <(q "select s.path, i.filename from images_image i join images_imageset s on s.id = i.image_set_id order by i.id desc limit 200")
  if [ "$total" -gt 0 ]; then
    if [ "$missing" -eq 0 ]; then ok "the newest $total image files are where the database says"
    elif [ $((missing * 2)) -gt "$total" ]; then bad "$missing of the newest $total image files are not under IMAGE_PATH (a different mount or path?)"
    else warn "$missing of the newest $total image files are not under IMAGE_PATH (missing on disk for Django as well? scripts/audit-backup.sh lists them)"; fi
  fi
fi

echo
[ $fail = 0 ] && echo "preflight: no FAIL" || echo "preflight: FAILED"
exit $fail
