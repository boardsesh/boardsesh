#!/bin/sh
set -eu

[ -n "${PGBOUNCER_CLIENT_USER:-}" ] || exit 1
[ -n "${PGBOUNCER_CLIENT_PASSWORD:-}" ] || exit 1
[ -n "${PGBOUNCER_DATABASE_NAME:-}" ] || exit 1

PGPASSWORD=$PGBOUNCER_CLIENT_PASSWORD \
PGSSLMODE=require \
  psql \
    --no-password \
    --no-psqlrc \
    --quiet \
    --host=127.0.0.1 \
    --port="${PGBOUNCER_LISTEN_PORT:-6432}" \
    --username="$PGBOUNCER_CLIENT_USER" \
    --dbname="$PGBOUNCER_DATABASE_NAME" \
    --command='SELECT 1' \
    >/dev/null 2>&1
