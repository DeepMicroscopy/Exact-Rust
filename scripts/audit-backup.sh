#!/usr/bin/env bash
# Looks at a restored COPY of the production database (reads only) and reports what the beta has to cope with: sizes, image
# formats, source files missing on disk, passkeys the server cannot use, the Django migration state, big image sets, and (when
# EXACT_URL/EXACT_USER/EXACT_PASSWORD are set) how long loading the annotations of the biggest images takes.
# The output holds counts and ids, no names or e-mail addresses.
#
# Usage: SQL_DATABASE=exact_beta SQL_USER=exact SQL_PASSWORD=... IMAGE_PATH=/srv/exact-beta/images scripts/audit-backup.sh
#   optional: PGBIN=/usr/lib/postgresql/16/bin  EXACT_URL=https://exact-beta.example.org EXACT_USER=... EXACT_PASSWORD=...
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(dirname "$(command -v psql 2>/dev/null || echo /usr/bin/psql)")}"
export PGHOST="${SQL_HOST:-127.0.0.1}" PGPORT="${SQL_PORT:-5432}" PGUSER="${SQL_USER:-exact}" PGPASSWORD="${SQL_PASSWORD:-exact}" PGDATABASE="${SQL_DATABASE:?set SQL_DATABASE}"
IMAGES="${IMAGE_PATH:?set IMAGE_PATH}"
q() { "$PGBIN/psql" -X -At -F ' | ' -v ON_ERROR_STOP=0 -c "$1" 2>&1; }
h() { echo; echo "=== $*"; }
[ "$PGDATABASE" != "exact" ] || { echo "refusing: SQL_DATABASE is 'exact'; run this on the restored copy" >&2; exit 1; }

h "database"
q "select current_database()||' on '||version()"
q "select 'django migrations: '||app||' up to '||max(name) from django_migrations where app in ('images','processing','annotations','users','administration') group by app order by app"
q "select 'registration-plugin migration (processing 0015) applied: '||exists(select 1 from django_migrations where app='processing' and name='0015_registration_plugins')"

h "sizes"
q "select 'users '||count(*)||' (active '||count(*) filter (where is_active)||', staff '||count(*) filter (where is_staff)||', superusers '||count(*) filter (where is_superuser)||')' from users_user"
q "select 'teams '||(select count(*) from users_team)||', image sets '||(select count(*) from images_imageset)||', images '||(select count(*) from images_image)||', frames '||(select coalesce(sum(frames),0) from images_image)"
q "select 'annotations '||count(*)||' (deleted '||count(*) filter (where deleted)||')' from annotations_annotation"
q "select 'annotation types '||(select count(*) from annotations_annotationtype)||', products '||(select count(*) from administration_product)||', verifications '||(select count(*) from annotations_verification)"
q "select 'plugins '||count(*)||' ('||count(*) filter (where coalesce(plugin_type,1)=1)||' analysis), plugin jobs '||(select count(*) from processing_pluginjob)||', results '||(select count(*) from processing_pluginresult) from processing_plugin" 
q "select 'registrations '||count(*) from images_imageregistration"
q "select 'personal access tokens '||count(*) from users_personalaccesstoken" 2>&1 | head -1

h "image formats (by file extension)"
q "select lower(substring(filename from '(nii\\.gz|[^.]+)$')) as ext, count(*) from images_image group by 1 order by 2 desc"

h "source files on disk (IMAGE_PATH=$IMAGES)"
missing=0; total=0
while IFS='|' read -r id rel; do
  total=$((total+1))
  [ -e "$IMAGES/$rel" ] || { missing=$((missing+1)); [ "$missing" -le 20 ] && echo "MISSING image $id: $rel"; }
done < <(q "select i.id||'|'||s.path||'/'||i.filename from images_image i join images_imageset s on s.id = i.image_set_id order by i.id")
echo "$total images checked, $missing without a file on disk"

h "stored passkeys (can this server use them?)"
if command -v exact-cli >/dev/null; then CLI=exact-cli; elif [ -x "$ROOT/target/release/exact-cli" ]; then CLI="$ROOT/target/release/exact-cli"; elif [ -x "$ROOT/target/debug/exact-cli" ]; then CLI="$ROOT/target/debug/exact-cli"; else CLI=""; fi
if [ -n "$CLI" ]; then SQL_HOST="$PGHOST" SQL_PORT="$PGPORT" SQL_USER="$PGUSER" SQL_PASSWORD="$PGPASSWORD" SQL_DATABASE="$PGDATABASE" "$CLI" audit-passkeys; else echo "exact-cli not found (cargo build --release -p exact-cli)"; fi

h "data quality"
q "select 'images without size: '||count(*) from images_image where width <= 0 or height <= 0"
q "select 'annotations without image: '||count(*) from annotations_annotation a where not exists (select 1 from images_image i where i.id = a.image_id)"
q "select 'annotations with an empty vector: '||count(*) from annotations_annotation where vector is null or vector::text in ('null', '{}')" 2>&1 | head -1
q "select 'annotation unique_identifier duplicates: '||count(*) from (select unique_identifier from annotations_annotation group by 1 having count(*) > 1) d"
q "select 'image sets without a folder: '||count(*) from images_imageset where path is null or path = ''"

h "the biggest image sets and images (by annotations)"
q "select 'image set '||s.id||': '||count(distinct i.id)||' images, '||count(a.id)||' annotations' from images_imageset s join images_image i on i.image_set_id = s.id left join annotations_annotation a on a.image_id = i.id group by s.id order by count(a.id) desc limit 5"
q "select 'image '||image_id||': '||count(*)||' annotations' from annotations_annotation group by image_id order by count(*) desc limit 5"

if [ -n "${EXACT_URL:-}" ] && [ -n "${EXACT_USER:-}" ]; then
  h "loading the annotations of the biggest images through the API ($EXACT_URL)"
  for id in $(q "select image_id from annotations_annotation group by image_id order by count(*) desc limit 3"); do
    out=$(curl -s -o /dev/null -w "%{http_code} %{time_total}s %{size_download} bytes" -u "$EXACT_USER:${EXACT_PASSWORD:-}" "$EXACT_URL/api/v1/annotations/annotations/?image=$id&limit=1000000")
    echo "image $id: $out"
  done
fi
echo; echo "(done; nothing was changed)"
