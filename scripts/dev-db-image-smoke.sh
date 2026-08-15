#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 1 ]] || {
  printf 'usage: %s IMAGE_REFERENCE\n' "$0" >&2
  exit 1
}

readonly IMAGE_REFERENCE="$1"
REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPOSITORY_ROOT
readonly CONTAINER_NAME="boardsesh-dev-db-pg18-smoke-${GITHUB_RUN_ID:-local}-${$}"
readonly VOLUME_NAME="boardsesh-dev-db-pg18-smoke-${GITHUB_RUN_ID:-local}-${$}"
EXPECTED_MIGRATION_COUNT="$(jq -r '.entries | length' "$REPOSITORY_ROOT/packages/db/drizzle/meta/_journal.json")"
readonly EXPECTED_MIGRATION_COUNT

cleanup() {
  docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'docker is required\n' >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf 'jq is required\n' >&2
  exit 1
}

if ! docker image inspect "$IMAGE_REFERENCE" >/dev/null 2>&1; then
  docker pull "$IMAGE_REFERENCE"
fi

EXPECTED_POSTGIS_VERSION="$(docker image inspect \
  --format '{{ index .Config.Labels "org.boardsesh.postgis.version" }}' \
  "$IMAGE_REFERENCE")"
[[ "$EXPECTED_POSTGIS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'image has an invalid org.boardsesh.postgis.version label: %s\n' \
    "$EXPECTED_POSTGIS_VERSION" >&2
  exit 1
}
readonly EXPECTED_POSTGIS_VERSION

wait_for_postgres() {
  local attempt=0
  while [[ "$attempt" -lt 300 ]]; do
    if docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main \
      -c 'SELECT 1;' >/dev/null 2>&1; then
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  docker logs "$CONTAINER_NAME" >&2 || true
  printf 'Seeded PostgreSQL did not become ready within 300 seconds\n' >&2
  exit 1
}

docker volume create "$VOLUME_NAME" >/dev/null
docker run --detach \
  --name "$CONTAINER_NAME" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=password \
  --env POSTGRES_DB=main \
  --volume "$VOLUME_NAME:/var/lib/postgresql" \
  "$IMAGE_REFERENCE" >/dev/null
wait_for_postgres

[[ "$(docker exec "$CONTAINER_NAME" printenv PGDATA)" == '/var/lib/postgresql/18/docker' ]]
docker exec "$CONTAINER_NAME" test -f /var/lib/postgresql/18/docker/.boardsesh-dev-db-ready

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -v expected_migration_count="$EXPECTED_MIGRATION_COUNT" \
  -v expected_postgis_version="$EXPECTED_POSTGIS_VERSION" <<'SQL'
SELECT set_config('boardsesh.expected_migration_count', :'expected_migration_count', false);
SELECT set_config('boardsesh.expected_postgis_version', :'expected_postgis_version', false);
DO $$
DECLARE
  migration_count bigint;
BEGIN
  IF current_setting('server_version_num')::integer <> 180004 THEN
    RAISE EXCEPTION 'expected PostgreSQL server_version_num 180004, got %',
      current_setting('server_version_num');
  END IF;
  IF current_setting('data_checksums') <> 'on' THEN
    RAISE EXCEPTION 'expected data_checksums=on';
  END IF;
  IF postgis_lib_version() <> current_setting('boardsesh.expected_postgis_version') THEN
    RAISE EXCEPTION 'expected PostGIS %, got %',
      current_setting('boardsesh.expected_postgis_version'), postgis_lib_version();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_available_extensions
    WHERE name = 'hypopg' AND default_version = '1.4.3'
  ) THEN
    RAISE EXCEPTION 'expected available HypoPG 1.4.3';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE email = 'test@boardsesh.com') THEN
    RAISE EXCEPTION 'seeded test user is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM board_climbs) THEN
    RAISE EXCEPTION 'seeded board_climbs data is missing';
  END IF;

  SELECT count(*) INTO migration_count FROM drizzle.__drizzle_migrations;
  IF migration_count <> current_setting('boardsesh.expected_migration_count')::bigint THEN
    RAISE EXCEPTION 'expected % Drizzle ledger rows, got %',
      current_setting('boardsesh.expected_migration_count'), migration_count;
  END IF;
END
$$;
SQL

before_restart="$(docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main \
  -c "SELECT count(*) || '|' || (SELECT count(*) FROM drizzle.__drizzle_migrations) FROM board_climbs;")"
docker stop "$CONTAINER_NAME" >/dev/null
docker start "$CONTAINER_NAME" >/dev/null
wait_for_postgres
after_restart="$(docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main \
  -c "SELECT count(*) || '|' || (SELECT count(*) FROM drizzle.__drizzle_migrations) FROM board_climbs;")"
[[ "$after_restart" == "$before_restart" ]]

printf 'Seeded PostgreSQL 18.4 dev-db fresh-volume and restart smoke test passed for %s.\n' "$IMAGE_REFERENCE"
