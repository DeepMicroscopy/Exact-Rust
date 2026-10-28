#!/usr/bin/env bash
# Lists the images of the scratch database whose file is missing on disk (the test image folders are symlinks into a
# real EXACT checkout, so a test that deletes the wrong file destroys data). Exit 1 when something is missing.
# Usage: scripts/check-images.sh
set -euo pipefail
PGBIN="${PGBIN:-/Applications/Postgres.app/Contents/Versions/16/bin}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGES="${IMAGE_PATH:-$ROOT/reference/instance/images}"
missing=0
while IFS='|' read -r rel id; do
  [ -e "$IMAGES/$rel" ] || { echo "MISSING image $id: $rel"; missing=1; }
done < <("$PGBIN/psql" -h 127.0.0.1 -U "$(whoami)" -d exact_rust_test -Atc \
  "select s.path||'/'||i.name, i.id from images_image i join images_imageset s on s.id = i.image_set_id order by i.id")
exit $missing
