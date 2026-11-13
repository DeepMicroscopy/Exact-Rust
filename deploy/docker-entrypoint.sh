#!/bin/sh
# Container entrypoint: applies the database migrations of this version before the server starts, so that an update of the image
# needs no manual `exact-cli migrate` (the server refuses to start on a database that has not been migrated). Set
# EXACT_AUTO_MIGRATE=0 in exact.env to migrate by hand instead. Only the server is wrapped; the workers and one-off commands
# (`docker compose run server exact-cli ...`) run as they are.
# Before that, the folders the server writes to are checked: a host folder that does not exist (Docker creates it owned by root) or
# belongs to another user would otherwise only show up as failing uploads. With IMAGE_MODE=ro the image store is not checked.
# After the migration, EXACT_ADMIN_USER (if set) becomes the first superuser of a new installation.
set -e

# writable <folder in the container> <its setting in exact.env>: exits with an explanation when the server cannot write there
writable() {
  probe="$1/.exact-write-test.$$"
  if ! (: > "$probe") 2>/dev/null; then
    echo "exact-server: cannot write to $1 (the host folder set as $2 in exact.env) as user $(id -u)." >&2
    echo "  Linux: the folder must belong to that user: sudo chown -R $(id -u) <the $2 folder>" >&2
    echo "  Windows / macOS (Docker Desktop): set $2 to an existing folder of yours, e.g. $2=C:/exact-data/$(basename "$1")" >&2
    [ "$2" = "IMAGE_PATH" ] && echo "  Or, on the real image files of an existing EXACT that must not be changed: IMAGE_MODE=ro" >&2
    exit 1
  fi
  rm -f "$probe"
}

if [ "$1" = "exact-server" ]; then
  [ "${IMAGE_MODE:-rw}" = "ro" ] || writable "${IMAGE_PATH:-/data/images}" IMAGE_PATH
  writable "${MEDIA_ROOT:-/data/media}" MEDIA_ROOT
  writable "${EXACT_CACHE_DIR:-/data/cache}" EXACT_CACHE_DIR
  if [ "${EXACT_AUTO_MIGRATE:-1}" != "0" ]; then
    exact-cli migrate --confirm-db "$SQL_DATABASE"
  fi
  # The first account of a new installation (EXACT_ADMIN_USER / EXACT_ADMIN_PASSWORD in the env file); nothing happens once any
  # superuser exists, so an imported EXACT database and every later start are left alone.
  if [ -n "${EXACT_ADMIN_USER:-}" ]; then
    if [ "${EXACT_ADMIN_PASSWORD:-}" = "change-me" ]; then
      echo "exact-server: EXACT_ADMIN_PASSWORD is still the example value change-me: set a password of your own in the env file." >&2
      exit 1
    fi
    exact-cli create-superuser --if-none --username "$EXACT_ADMIN_USER" --email "${EXACT_ADMIN_EMAIL:-}" \
      ${EXACT_ADMIN_TEAM:+--team "$EXACT_ADMIN_TEAM"} --confirm-db "$SQL_DATABASE" </dev/null
  fi
fi
exec "$@"
