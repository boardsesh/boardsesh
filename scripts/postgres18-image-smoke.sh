#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPOSITORY_ROOT
readonly IMAGE_TAG="boardsesh-postgres18-smoke:${GITHUB_RUN_ID:-local}-${$}"
readonly CONTAINER_NAME="boardsesh-postgres18-smoke-${GITHUB_RUN_ID:-local}-${$}"
readonly VOLUME_NAME="boardsesh-postgres18-smoke-${GITHUB_RUN_ID:-local}-${$}"
readonly TARGET_CONTAINER_NAME="boardsesh-postgres18-target-${GITHUB_RUN_ID:-local}-${$}"
readonly TARGET_VOLUME_NAME="boardsesh-postgres18-target-${GITHUB_RUN_ID:-local}-${$}"
readonly NETWORK_NAME="boardsesh-postgres18-smoke-${GITHUB_RUN_ID:-local}-${$}"
SEQUENCE_SQL_FILE="$(mktemp "${TMPDIR:-/tmp}/boardsesh-pg18-sequences.XXXXXX")"
readonly SEQUENCE_SQL_FILE
AUDIT_REPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/boardsesh-pg18-audit.XXXXXX")"
readonly AUDIT_REPORT_FILE
SYNC_REPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/boardsesh-pg18-sync.XXXXXX")"
readonly SYNC_REPORT_FILE

cleanup() {
  docker rm --force "$TARGET_CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$TARGET_VOLUME_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  docker image rm "$IMAGE_TAG" >/dev/null 2>&1 || true
  rm -f "$SEQUENCE_SQL_FILE" "$AUDIT_REPORT_FILE" "$SYNC_REPORT_FILE"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'docker is required\n' >&2
  exit 1
}
command -v psql >/dev/null 2>&1 || {
  printf 'psql is required\n' >&2
  exit 1
}

wait_for_postgres() {
  local container_name="${1:-$CONTAINER_NAME}"
  local attempt=0
  while [[ "$attempt" -lt 120 ]]; do
    if docker exec "$container_name" psql -X -Atq -U postgres -d main \
      -c 'SELECT 1;' >/dev/null 2>&1; then
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  docker logs "$container_name" >&2 || true
  printf 'PostgreSQL did not become ready within 120 seconds\n' >&2
  exit 1
}

docker build \
  --file "$REPOSITORY_ROOT/packages/db/docker/Dockerfile.postgres" \
  --tag "$IMAGE_TAG" \
  "$REPOSITORY_ROOT/packages/db/docker"

IMAGE_POSTGIS_VERSION="$(docker image inspect \
  --format '{{ index .Config.Labels "org.boardsesh.postgis.version" }}' \
  "$IMAGE_TAG")"
[[ "$IMAGE_POSTGIS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'image has an invalid org.boardsesh.postgis.version label: %s\n' \
    "$IMAGE_POSTGIS_VERSION" >&2
  exit 1
}
readonly IMAGE_POSTGIS_VERSION

docker network create "$NETWORK_NAME" >/dev/null
docker volume create "$VOLUME_NAME" >/dev/null
docker run --detach \
  --name "$CONTAINER_NAME" \
  --network "$NETWORK_NAME" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=main \
  --publish 127.0.0.1::5432 \
  --volume "$VOLUME_NAME:/var/lib/postgresql" \
  "$IMAGE_TAG" \
  postgres -c wal_level=logical -c max_slot_wal_keep_size=1GB >/dev/null
wait_for_postgres

[[ "$(docker exec "$CONTAINER_NAME" printenv PGDATA)" == '/var/lib/postgresql/18/docker' ]]

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -v expected_postgis_version="$IMAGE_POSTGIS_VERSION" <<'SQL'
CREATE EXTENSION postgis;
CREATE EXTENSION "uuid-ossp";
CREATE EXTENSION pg_trgm;
CREATE EXTENSION hypopg;

SELECT set_config('boardsesh.expected_postgis_version', :'expected_postgis_version', false);

DO $$
BEGIN
  IF current_setting('server_version') NOT LIKE '18.4%' THEN
    RAISE EXCEPTION 'expected PostgreSQL 18.4, got %', current_setting('server_version');
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
    WHERE name = 'hypopg' AND installed_version = '1.4.3'
  ) THEN
    RAISE EXCEPTION 'expected installed HypoPG 1.4.3';
  END IF;
END
$$;

CREATE TABLE pg18_smoke_persistence (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  marker text NOT NULL
);
INSERT INTO pg18_smoke_persistence (marker) VALUES ('survives-restart');

CREATE TABLE pg18_smoke_never_called (
  id bigserial PRIMARY KEY
);

CREATE TABLE pg18_smoke_partitioned (
  id integer PRIMARY KEY,
  marker text NOT NULL
) PARTITION BY RANGE (id);
CREATE TABLE pg18_smoke_partitioned_low
  PARTITION OF pg18_smoke_partitioned FOR VALUES FROM (0) TO (100);
INSERT INTO pg18_smoke_partitioned VALUES (1, 'partition-survives-copy');

CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint NOT NULL
);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('pg18-smoke', 1);

-- Excluded/managed source schemas must never leak through the schema restore.
CREATE SCHEMA neon_control_plane;
CREATE TABLE neon_control_plane.must_not_migrate (id integer PRIMARY KEY);
INSERT INTO neon_control_plane.must_not_migrate VALUES (1);

CREATE ROLE pg18_smoke_owner NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_runtime LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_migrator LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_replication LOGIN NOSUPERUSER REPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_publisher LOGIN NOSUPERUSER REPLICATION NOBYPASSRLS
  PASSWORD 'publisher';
ALTER ROLE pg18_smoke_publisher SET row_security = off;
GRANT pg18_smoke_owner TO pg18_smoke_migrator WITH INHERIT FALSE, SET TRUE;
GRANT CREATE ON DATABASE main TO pg18_smoke_owner;

ALTER SCHEMA public OWNER TO pg18_smoke_owner;
ALTER SCHEMA drizzle OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_persistence OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_never_called OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_partitioned OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_partitioned_low OWNER TO pg18_smoke_owner;
ALTER TABLE drizzle.__drizzle_migrations OWNER TO pg18_smoke_owner;

GRANT USAGE ON SCHEMA public, drizzle TO pg18_smoke_runtime;
GRANT USAGE ON SCHEMA public, drizzle TO pg18_smoke_publisher;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.pg18_smoke_persistence, public.pg18_smoke_never_called,
     public.pg18_smoke_partitioned, public.pg18_smoke_partitioned_low,
     drizzle.__drizzle_migrations
  TO pg18_smoke_runtime;
GRANT SELECT
  ON public.pg18_smoke_persistence, public.pg18_smoke_never_called,
     public.pg18_smoke_partitioned, public.pg18_smoke_partitioned_low,
     drizzle.__drizzle_migrations
  TO pg18_smoke_publisher;
GRANT USAGE
  ON public.pg18_smoke_persistence_id_seq,
     public.pg18_smoke_never_called_id_seq,
     drizzle.__drizzle_migrations_id_seq
  TO pg18_smoke_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public, drizzle
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public, drizzle
  GRANT USAGE ON SEQUENCES TO pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public, drizzle
  GRANT EXECUTE ON FUNCTIONS TO pg18_smoke_runtime;
SQL

docker stop "$CONTAINER_NAME" >/dev/null
docker start "$CONTAINER_NAME" >/dev/null
wait_for_postgres

persisted_marker="$(docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main \
  -c "SELECT marker FROM pg18_smoke_persistence WHERE id = 1;")"
[[ "$persisted_marker" == 'survives-restart' ]]

host_port="$(docker port "$CONTAINER_NAME" 5432/tcp | awk -F: 'NR == 1 { print $NF }')"
[[ "$host_port" =~ ^[0-9]+$ ]]
readonly host_port
readonly smoke_database_url="postgresql://postgres:postgres@127.0.0.1:${host_port}/main"

SOURCE_DATABASE_URL="$smoke_database_url" \
  TARGET_DATABASE_URL="$smoke_database_url" \
  EXPECTED_SOURCE_MAJOR=18 \
  EXPECTED_POSTGIS_VERSION="$IMAGE_POSTGIS_VERSION" \
  MIGRATION_OWNER_ROLE=pg18_smoke_owner \
  MIGRATION_RUNTIME_ROLE=pg18_smoke_runtime \
  MIGRATION_MIGRATOR_ROLE=pg18_smoke_migrator \
  MIGRATION_REPLICATION_ROLE=pg18_smoke_replication \
  MIGRATION_RUNTIME_SCHEMAS='public drizzle' \
  "$REPOSITORY_ROOT/scripts/postgres-migration-audit.sh" >"$AUDIT_REPORT_FILE"
grep -Fq 'Audit result: 0 blocker(s).' "$AUDIT_REPORT_FILE"

SOURCE_DATABASE_URL="$smoke_database_url" \
  TARGET_DATABASE_URL="$smoke_database_url" \
  WRITES_FENCED=true \
  "$REPOSITORY_ROOT/scripts/postgres-migration-verify-data.sh"

docker exec -i "$CONTAINER_NAME" psql -X -Atq -U postgres -d main \
  -v excluded_schemas= \
  <"$REPOSITORY_ROOT/scripts/postgres-owned-sequence-setvals.sql" >"$SEQUENCE_SQL_FILE"

grep -Fq "pg18_smoke_persistence_id_seq" "$SEQUENCE_SQL_FILE"
grep -Eq "pg18_smoke_never_called_id_seq.*1, 'f'" "$SEQUENCE_SQL_FILE"

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SELECT setval('pg18_smoke_persistence_id_seq', 500, true);
SELECT setval('pg18_smoke_never_called_id_seq', 500, true);
SQL
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <"$SEQUENCE_SQL_FILE"

never_called_state="$(docker exec "$CONTAINER_NAME" psql -X -Atq -F '|' -U postgres -d main \
  -c 'SELECT last_value, is_called FROM pg18_smoke_never_called_id_seq;')"
[[ "$never_called_state" == '1|f' ]]

# Exercise the two-host logical migration contract with PG18 at both ends. This
# catches catalog and CREATE SUBSCRIPTION drift that a same-database audit cannot
# expose, but it does not replace the required real PG16-to-PG18 rehearsal.
docker volume create "$TARGET_VOLUME_NAME" >/dev/null
docker run --detach \
  --name "$TARGET_CONTAINER_NAME" \
  --network "$NETWORK_NAME" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=main \
  --volume "$TARGET_VOLUME_NAME:/var/lib/postgresql" \
  "$IMAGE_TAG" >/dev/null
wait_for_postgres "$TARGET_CONTAINER_NAME"

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE ROLE pg18_smoke_owner NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_runtime LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_migrator LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_standby LOGIN NOSUPERUSER REPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_subscriber LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
GRANT pg18_smoke_owner TO pg18_smoke_migrator WITH INHERIT FALSE, SET TRUE;
GRANT pg18_smoke_owner TO pg18_smoke_subscriber WITH INHERIT FALSE, SET TRUE;
GRANT pg_create_subscription TO pg18_smoke_subscriber;
GRANT CREATE ON DATABASE main TO pg18_smoke_owner;
GRANT CREATE ON DATABASE main TO pg18_smoke_subscriber;
SQL

readonly source_admin_url="postgresql://postgres:postgres@${CONTAINER_NAME}:5432/main"
readonly source_publisher_url="postgresql://pg18_smoke_publisher:publisher@${CONTAINER_NAME}:5432/main"
readonly target_admin_url="postgresql://postgres:postgres@${TARGET_CONTAINER_NAME}:5432/main"

run_two_host_audit() {
  docker run --rm \
    --network "$NETWORK_NAME" \
    --volume "$REPOSITORY_ROOT:/workspace:ro" \
    --entrypoint bash \
    --env SOURCE_DATABASE_URL="$source_admin_url" \
    --env SOURCE_REPLICATION_DATABASE_URL="$source_publisher_url" \
    --env TARGET_DATABASE_URL="$target_admin_url" \
    --env EXPECTED_SOURCE_MAJOR=18 \
    --env EXPECTED_POSTGIS_VERSION="$IMAGE_POSTGIS_VERSION" \
    --env REQUIRE_PUBLICATION=true \
    --env MIGRATION_PUBLICATION_NAME=pg18_smoke_publication \
    --env MIGRATION_SUBSCRIPTION_NAME=pg18_smoke_subscription \
    --env MIGRATION_SLOT_NAME=pg18_smoke_subscription \
    --env MIGRATION_OWNER_ROLE=pg18_smoke_owner \
    --env MIGRATION_RUNTIME_ROLE=pg18_smoke_runtime \
    --env MIGRATION_MIGRATOR_ROLE=pg18_smoke_migrator \
    --env MIGRATION_REPLICATION_ROLE=pg18_smoke_standby \
    --env MIGRATION_SUBSCRIBER_ROLE=pg18_smoke_subscriber \
    --env 'MIGRATION_RUNTIME_SCHEMAS=public drizzle' \
    "$IMAGE_TAG" /workspace/scripts/postgres-migration-audit.sh
}

run_sequence_sync() {
  docker run --rm \
    --network "$NETWORK_NAME" \
    --volume "$REPOSITORY_ROOT:/workspace:ro" \
    --entrypoint bash \
    --env NEON_DATABASE_URL="$source_admin_url" \
    --env RAILWAY_DATABASE_URL="$target_admin_url" \
    --env TARGET_OWNER_ROLE=pg18_smoke_owner \
    --env TARGET_SUBSCRIBER_ROLE=pg18_smoke_subscriber \
    --env PUBLICATION_NAME=pg18_smoke_publication \
    --env SUBSCRIPTION_NAME=pg18_smoke_subscription \
    --env SLOT_NAME=pg18_smoke_subscription \
    --env WRITES_FENCED=true \
    --env 'FENCED_WRITER_ROLES=pg18_smoke_runtime pg18_smoke_migrator' \
    "$IMAGE_TAG" /workspace/scripts/neon-to-railway-replication.sh sync-sequences
}

run_data_verification() {
  docker run --rm \
    --network "$NETWORK_NAME" \
    --volume "$REPOSITORY_ROOT:/workspace:ro" \
    --entrypoint bash \
    --env SOURCE_DATABASE_URL="$source_admin_url" \
    --env TARGET_DATABASE_URL="$target_admin_url" \
    --env WRITES_FENCED=true \
    "$IMAGE_TAG" /workspace/scripts/postgres-migration-verify-data.sh
}

docker run --rm \
  --network "$NETWORK_NAME" \
  --volume "$REPOSITORY_ROOT:/workspace:ro" \
  --entrypoint bash \
  --env NEON_DATABASE_URL="$source_admin_url" \
  --env RAILWAY_DATABASE_URL="$target_admin_url" \
  --env NEON_REPLICATION_DATABASE_URL="$source_publisher_url" \
  --env TARGET_OWNER_ROLE=pg18_smoke_owner \
  --env TARGET_SUBSCRIBER_ROLE=pg18_smoke_subscriber \
  --env PUBLICATION_NAME=pg18_smoke_publication \
  --env SUBSCRIPTION_NAME=pg18_smoke_subscription \
  --env SLOT_NAME=pg18_smoke_subscription \
  "$IMAGE_TAG" /workspace/scripts/neon-to-railway-replication.sh setup

excluded_target_state="$(docker exec "$TARGET_CONTAINER_NAME" psql -X -Atq -F '|' -U postgres -d main -c "
SELECT (to_regnamespace('neon_control_plane') IS NULL)::text || '|' ||
       (to_regclass('neon_control_plane.must_not_migrate') IS NULL)::text;")"
[[ "$excluded_target_state" == 'true|true' ]]

attempt=0
while [[ "$attempt" -lt 120 ]]; do
  subscription_state="$(docker exec "$TARGET_CONTAINER_NAME" psql -X -Atq -F '|' -U postgres -d main -c "
SELECT count(*) || '|' || count(*) FILTER (WHERE subscription_relation.srsubstate <> 'r')
FROM pg_subscription_rel AS subscription_relation
JOIN pg_subscription AS subscription ON subscription.oid = subscription_relation.srsubid
WHERE subscription.subname = 'pg18_smoke_subscription';")"
  if [[ "$subscription_state" =~ ^[1-9][0-9]*\|0$ ]]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[[ "$subscription_state" =~ ^[1-9][0-9]*\|0$ ]]

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER SCHEMA public OWNER TO pg18_smoke_owner;
ALTER SCHEMA drizzle OWNER TO pg18_smoke_owner;
GRANT USAGE ON SCHEMA public, drizzle TO pg18_smoke_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.pg18_smoke_persistence, public.pg18_smoke_never_called,
     public.pg18_smoke_partitioned, public.pg18_smoke_partitioned_low,
     drizzle.__drizzle_migrations
  TO pg18_smoke_runtime;
GRANT USAGE
  ON public.pg18_smoke_persistence_id_seq,
     public.pg18_smoke_never_called_id_seq,
     drizzle.__drizzle_migrations_id_seq
  TO pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public, drizzle
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public, drizzle
  GRANT USAGE ON SEQUENCES TO pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public, drizzle
  GRANT EXECUTE ON FUNCTIONS TO pg18_smoke_runtime;
SQL

# Prove the exact publication audit rejects a column-list projection even when
# the relation-name manifest and subscription readiness still look complete.
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER PUBLICATION pg18_smoke_publication SET TABLE
  public.pg18_smoke_persistence (id),
  public.pg18_smoke_never_called,
  public.pg18_smoke_partitioned,
  public.pg18_smoke_partitioned_low,
  drizzle.__drizzle_migrations;
SQL
if run_two_host_audit >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected the audit to reject a publication column list\n' >&2
  exit 1
fi
grep -Fq 'publication table(s) use a row filter or omit columns' "$AUDIT_REPORT_FILE"

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER PUBLICATION pg18_smoke_publication SET TABLE
  public.pg18_smoke_persistence,
  public.pg18_smoke_never_called,
  public.pg18_smoke_partitioned,
  public.pg18_smoke_partitioned_low,
  drizzle.__drizzle_migrations;
SQL

# An owner-correct but source-only index must still block the catalog gate.
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
CREATE INDEX pg18_smoke_unexpected_idx ON public.pg18_smoke_persistence (marker);
RESET ROLE;
SQL
if run_two_host_audit >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected the audit to reject target DDL drift\n' >&2
  exit 1
fi
grep -Fq 'catalog DDL manifest differs' "$AUDIT_REPORT_FILE"
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'DROP INDEX public.pg18_smoke_unexpected_idx;' >/dev/null

run_two_host_audit >"$AUDIT_REPORT_FILE"
grep -Fq 'Audit result: 0 blocker(s).' "$AUDIT_REPORT_FILE"

# The destructive teardown path must remain inert until an operator explicitly
# confirms the post-cutover acceptance and restore-drill gate.
if docker run --rm \
  --network "$NETWORK_NAME" \
  --volume "$REPOSITORY_ROOT:/workspace:ro" \
  --entrypoint bash \
  --env NEON_DATABASE_URL="$source_admin_url" \
  --env RAILWAY_DATABASE_URL="$target_admin_url" \
  "$IMAGE_TAG" /workspace/scripts/neon-to-railway-replication.sh teardown \
  >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected teardown without TEARDOWN_CONFIRMED=true to be rejected\n' >&2
  exit 1
fi
grep -Fq 'teardown requires TEARDOWN_CONFIRMED=true' "$AUDIT_REPORT_FILE"

# Deliberately diverge every target sequence, then exercise the real guarded
# source-to-subscriber sequence copy, including the never-called state.
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SELECT setval('public.pg18_smoke_persistence_id_seq', 900, true);
SELECT setval('public.pg18_smoke_never_called_id_seq', 900, true);
SELECT setval('drizzle.__drizzle_migrations_id_seq', 900, true);
SQL
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER ROLE pg18_smoke_runtime NOLOGIN;
ALTER ROLE pg18_smoke_migrator NOLOGIN;
SQL

attempt=0
while ! run_sequence_sync >"$SYNC_REPORT_FILE" 2>&1; do
  if ! grep -Fq 'has not replayed the source flush LSN' "$SYNC_REPORT_FILE" || \
    [[ "$attempt" -ge 120 ]]; then
    cat "$SYNC_REPORT_FILE" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done

target_sequence_state="$(docker exec -i "$TARGET_CONTAINER_NAME" \
  psql -X -Atq -F '|' -U postgres -d main <<'SQL'
SELECT last_value, is_called FROM public.pg18_smoke_persistence_id_seq;
SELECT last_value, is_called FROM public.pg18_smoke_never_called_id_seq;
SELECT last_value, is_called FROM drizzle.__drizzle_migrations_id_seq;
SQL
)"
if [[ "$target_sequence_state" != $'1|t\n1|f\n1|t' ]]; then
  printf 'Target sequence state did not match the source after sync:\n%s\n' \
    "$target_sequence_state" >&2
  exit 1
fi

# A row drift in a leaf partition must be visible through the logical parent
# digest even though the partition itself is not hashed a second time.
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "UPDATE public.pg18_smoke_partitioned SET marker = 'target-drift' WHERE id = 1;" >/dev/null
if run_data_verification >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected partition row drift to fail data verification\n' >&2
  exit 1
fi
grep -Fq 'Table data verification failed' "$AUDIT_REPORT_FILE"
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "UPDATE public.pg18_smoke_partitioned SET marker = 'partition-survives-copy' WHERE id = 1;" >/dev/null

run_data_verification

printf 'PostgreSQL 18.4 image, audit, and two-host logical-migration smoke test passed.\n'
