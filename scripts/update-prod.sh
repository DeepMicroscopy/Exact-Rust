#!/usr/bin/env bash
# Updates the production Rust server (deploy/docker-compose.prod.yml, project exact-rust-prod): pulls the code, builds the image, runs the
# additive database migration, recreates the containers (server and registration worker), waits until the server answers and, if it does
# not, goes back to the previous image. Run it in the repository on the server.
#   scripts/update-prod.sh              pull, build, migrate, recreate
#   scripts/update-prod.sh --no-pull    the same without `git pull` (the code is already there)
#   scripts/update-prod.sh --rollback   back to the image the last update replaced
# Needs deploy/docker-compose.prod.yml and deploy/exact.env.prod (see docs/DEPLOY.md, section 10).
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE=deploy/docker-compose.prod.yml
ENV_FILE=deploy/exact.env.prod
SERVICE=exact-rust-prod
IMAGE=exact-rust
PORT=8003   # the server's port on 127.0.0.1 in the compose file

rp() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
say() { printf '\n== %s\n' "$*"; }

[ -f "$COMPOSE_FILE" ] && [ -f "$ENV_FILE" ] || { echo "missing $COMPOSE_FILE or $ENV_FILE (docs/DEPLOY.md, section 10)" >&2; exit 1; }

wait_for_server() {
  for _ in $(seq 1 30); do
    curl -fsS -m 3 "http://127.0.0.1:$PORT/timesync/" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

rollback() {
  docker image inspect "$IMAGE:previous" >/dev/null 2>&1 || { echo "there is no $IMAGE:previous image to go back to" >&2; return 1; }
  say "going back to the previous image"
  docker tag "$IMAGE:previous" "$IMAGE"
  rp up -d --force-recreate
  if wait_for_server; then echo "the previous version is running again"; else echo "the server does not answer; look at: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs --tail 50" >&2; return 1; fi
}

case "${1:-}" in
  --rollback) rollback; exit $? ;;
  --no-pull | "") ;;
  *) echo "usage: $0 [--no-pull | --rollback]" >&2; exit 2 ;;
esac

if [ "${1:-}" != "--no-pull" ]; then
  say "git pull"
  git pull --ff-only
fi
git log --oneline -1

say "keeping the running image as $IMAGE:previous"
docker image inspect "$IMAGE" >/dev/null 2>&1 && docker tag "$IMAGE" "$IMAGE:previous" || echo "(no image yet)"

say "building the image"
docker build -f deploy/Dockerfile -t "$IMAGE" .

say "database migration (additive, safe to repeat)"
DB=$(grep -E '^SQL_DATABASE=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$DB" ] || { echo "SQL_DATABASE is not set in $ENV_FILE" >&2; exit 1; }
rp run --rm --no-deps "$SERVICE" exact-cli migrate --confirm-db "$DB"

say "recreating the containers"
rp up -d --force-recreate

say "waiting for the server"
if wait_for_server; then
  curl -fsS "http://127.0.0.1:$PORT/api/version"; echo
  rp ps
  echo "updated. Hard-reload the browser (Ctrl/Cmd+Shift+R). Back: $0 --rollback"
else
  echo "the server did not answer within a minute; its log:" >&2
  rp logs --tail 30 "$SERVICE" >&2 || true
  rollback || true
  exit 1
fi
