#!/bin/sh
# Container entrypoint: applies the database migrations of this version before the server starts, so that an update of the image
# needs no manual `exact-cli migrate` (the server refuses to start on a database that has not been migrated). Set
# EXACT_AUTO_MIGRATE=0 in exact.env to migrate by hand instead. Only the server is wrapped; the workers and one-off commands
# (`docker compose run server exact-cli ...`) run as they are.
set -e
if [ "$1" = "exact-server" ] && [ "${EXACT_AUTO_MIGRATE:-1}" != "0" ]; then
  exact-cli migrate --confirm-db "$SQL_DATABASE"
fi
exec "$@"
