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
MIGRATION_CONTRACT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-pg18-migrations.XXXXXX")"
readonly MIGRATION_CONTRACT_ROOT

# A bare `grep -Fq` on a report exits 1 with no output, so a guard that does not
# fire looks identical to the script dying for an unrelated reason. Always show
# the report the assertion was made against.
assert_report_contains() {
  local expected_message="$1"
  local report="${2:-$AUDIT_REPORT_FILE}"
  if ! grep -Fq "$expected_message" "$report"; then
    cat "$report" >&2
    printf 'Expected the report to contain: %s\n' "$expected_message" >&2
    exit 1
  fi
}

cleanup() {
  docker rm --force "$TARGET_CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$TARGET_VOLUME_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  docker image rm "$IMAGE_TAG" >/dev/null 2>&1 || true
  rm -f "$SEQUENCE_SQL_FILE" "$AUDIT_REPORT_FILE" "$SYNC_REPORT_FILE"
  rm -rf "$MIGRATION_CONTRACT_ROOT"
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
    # The official entrypoint's temporary init server accepts Unix-socket
    # connections, then shuts down before starting the final postmaster. Only
    # the final server listens on TCP, so this cannot report readiness mid-init.
    if docker exec --env PGPASSWORD=postgres "$container_name" \
      psql -X -Atq -h 127.0.0.1 -U postgres -d main \
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

verify_development_role_bootstrap() {
  local container_name="$1"
  local bootstrap_sql="$REPOSITORY_ROOT/packages/db/docker/bootstrap-pg18-development-roles.sql"
  local role_contract

  if docker exec -i "$container_name" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
      -v boardsesh_dev_role_bootstrap=false \
      <"$bootstrap_sql" >"$AUDIT_REPORT_FILE" 2>&1; then
    printf 'Expected development role bootstrap without explicit opt-in to fail\n' >&2
    exit 1
  fi
  assert_report_contains 'development role bootstrap requires boardsesh_dev_role_bootstrap=true'

  # A second successful run proves the bootstrap repairs/reasserts the same
  # direct catalog contract without relying on one-time CREATE ROLE behavior.
  if ! docker exec -i "$container_name" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
      -v boardsesh_dev_role_bootstrap=true \
      <"$bootstrap_sql" >"$AUDIT_REPORT_FILE" 2>&1; then
    cat "$AUDIT_REPORT_FILE" >&2
    exit 1
  fi
  if ! docker exec -i "$container_name" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
      -v boardsesh_dev_role_bootstrap=true \
      <"$bootstrap_sql" >"$AUDIT_REPORT_FILE" 2>&1; then
    cat "$AUDIT_REPORT_FILE" >&2
    exit 1
  fi

  role_contract="$(docker exec "$container_name" \
    psql -X -Atq -F '|' -U postgres -d main -c "
WITH owner_role AS (
  SELECT * FROM pg_roles WHERE rolname = 'boardsesh_owner'
), fence_owner AS (
  SELECT * FROM pg_roles WHERE rolname = 'boardsesh_snapshot_fence_owner'
), stats_role AS (
  SELECT oid FROM pg_roles WHERE rolname = 'pg_read_all_stats'
)
SELECT fence_owner.rolcanlogin::text || '|' || fence_owner.rolsuper::text || '|' ||
       fence_owner.rolcreatedb::text || '|' || fence_owner.rolcreaterole::text || '|' ||
       fence_owner.rolinherit::text || '|' || fence_owner.rolreplication::text || '|' ||
       fence_owner.rolbypassrls::text || '|' ||
       (SELECT count(*) = 1 AND bool_and(
                 privilege.privilege_type = 'CREATE' AND NOT privilege.is_grantable)
        FROM pg_database AS database
        CROSS JOIN LATERAL aclexplode(database.datacl) AS privilege
        WHERE database.datname = current_database()
          AND privilege.grantee = owner_role.oid)::text || '|' ||
       (SELECT count(*) FROM pg_auth_members AS membership, stats_role
        WHERE membership.member = fence_owner.oid
          AND membership.roleid = stats_role.oid
          AND NOT membership.admin_option AND membership.inherit_option
          AND NOT membership.set_option)::text || '|' ||
       (SELECT count(*) FROM pg_auth_members AS membership
       WHERE membership.member = owner_role.oid
          AND membership.roleid = fence_owner.oid
          AND NOT membership.admin_option AND NOT membership.inherit_option
          AND membership.set_option)::text || '|' ||
       (SELECT count(*) FROM pg_auth_members AS membership
        WHERE membership.member = owner_role.oid)::text || '|' ||
       (SELECT count(*) = 2 AND bool_and(
                 per_function.direct_execute_count = 1
                 AND per_function.non_grantable_execute_count = 1
               )
        FROM (
          SELECT expected.function_oid,
                 count(*) FILTER (
                   WHERE privilege.grantee = fence_owner.oid
                     AND privilege.privilege_type = 'EXECUTE'
                 ) AS direct_execute_count,
                 count(*) FILTER (
                   WHERE privilege.grantee = fence_owner.oid
                     AND privilege.privilege_type = 'EXECUTE'
                     AND NOT privilege.is_grantable
                 ) AS non_grantable_execute_count
          FROM (VALUES
            ('pg_catalog.pg_control_system()'::regprocedure),
            ('pg_catalog.pg_control_checkpoint()'::regprocedure)
          ) AS expected(function_oid)
          JOIN pg_proc AS procedure ON procedure.oid = expected.function_oid
          LEFT JOIN LATERAL aclexplode(procedure.proacl) AS privilege ON true
          GROUP BY expected.function_oid
        ) AS per_function)::text || '|' ||
       (SELECT count(*) FROM pg_auth_members AS membership
        WHERE membership.member = fence_owner.oid
           OR membership.roleid = fence_owner.oid)::text
FROM owner_role, fence_owner;")"
  [[ "$role_contract" == 'false|false|false|false|true|false|false|true|1|1|1|true|2' ]] || {
    printf 'Development role bootstrap contract failed: %s\n' "$role_contract" >&2
    exit 1
  }
}

run_dev_db_migration_contract() {
  local contract_database=pg18_dev_db_migration_contract
  local successful_tag=0000_transaction_scope
  local successful_when=1734255307302
  local failing_tag=0001_second_ledger_failure
  local failing_when=1734255307303
  local migration_state rollback_state

  mkdir -p "$MIGRATION_CONTRACT_ROOT/meta"
  printf '%s\n' \
    "{\"entries\":[{\"tag\":\"$successful_tag\",\"when\":$successful_when}]}" \
    >"$MIGRATION_CONTRACT_ROOT/meta/_journal.json"
  cat >"$MIGRATION_CONTRACT_ROOT/$successful_tag.sql" <<'SQL'
CREATE TEMP TABLE migration_contract_temp ON COMMIT DROP AS SELECT 42 AS id;
CREATE TABLE migration_contract_effect AS
SELECT id FROM migration_contract_temp;
SQL

  docker exec "$CONTAINER_NAME" createdb -U postgres "$contract_database"
  PGHOST=127.0.0.1 \
    PGPORT="$host_port" \
    PGUSER=postgres \
    PGPASSWORD=postgres \
    PGDATABASE="$contract_database" \
    DRIZZLE_MIGRATIONS_DIR="$MIGRATION_CONTRACT_ROOT" \
    "$REPOSITORY_ROOT/packages/db/docker/apply-drizzle-migrations.sh" >/dev/null

  migration_state="$(docker exec "$CONTAINER_NAME" \
    psql -X -Atq -F '|' -U postgres -d "$contract_database" -c "
SELECT (SELECT id FROM migration_contract_effect) || '|' ||
       (SELECT count(*) FROM public.\"__drizzle_migrations\") || '|' ||
       (SELECT count(*) FROM drizzle.\"__drizzle_migrations\") || '|' ||
       (SELECT max(created_at) FROM public.\"__drizzle_migrations\") || '|' ||
       (SELECT max(created_at) FROM drizzle.\"__drizzle_migrations\");")"
  [[ "$migration_state" == "42|1|1|$successful_when|$successful_when" ]] || {
    printf 'Dev-db migration transaction contract failed: %s\n' "$migration_state" >&2
    exit 1
  }

  # Force the second ledger insert to fail after the migration DDL and first
  # ledger insert have run. --single-transaction must roll all three back.
  docker exec "$CONTAINER_NAME" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d "$contract_database" \
    -c "ALTER TABLE drizzle.\"__drizzle_migrations\" ADD CONSTRAINT reject_contract_timestamp CHECK (created_at <> $failing_when);" \
    >/dev/null
  printf '%s\n' \
    "{\"entries\":[{\"tag\":\"$failing_tag\",\"when\":$failing_when}]}" \
    >"$MIGRATION_CONTRACT_ROOT/meta/_journal.json"
  cat >"$MIGRATION_CONTRACT_ROOT/$failing_tag.sql" <<'SQL'
CREATE TABLE migration_contract_ledger_failure (id integer PRIMARY KEY);
INSERT INTO migration_contract_ledger_failure VALUES (1);
SQL

  if PGHOST=127.0.0.1 \
    PGPORT="$host_port" \
    PGUSER=postgres \
    PGPASSWORD=postgres \
    PGDATABASE="$contract_database" \
    DRIZZLE_MIGRATIONS_DIR="$MIGRATION_CONTRACT_ROOT" \
    "$REPOSITORY_ROOT/packages/db/docker/apply-drizzle-migrations.sh" \
    >"$AUDIT_REPORT_FILE" 2>&1; then
    printf 'Expected the second-ledger contract migration to fail\n' >&2
    exit 1
  fi
  assert_report_contains 'schema and ledger changes were rolled back'

  rollback_state="$(docker exec "$CONTAINER_NAME" \
    psql -X -Atq -F '|' -U postgres -d "$contract_database" -c "
SELECT (to_regclass('public.migration_contract_ledger_failure') IS NULL)::text || '|' ||
       (SELECT count(*) FROM public.\"__drizzle_migrations\" WHERE created_at = $failing_when) || '|' ||
       (SELECT count(*) FROM drizzle.\"__drizzle_migrations\" WHERE created_at = $failing_when);")"
  [[ "$rollback_state" == 'true|0|0' ]] || {
    printf 'Second-ledger failure did not roll back schema and ledgers: %s\n' \
      "$rollback_state" >&2
    exit 1
  }
}

run_production_role_transition_contract() {
  local transition_admin_url="postgresql://postgres:postgres@127.0.0.1:${host_port}/main"
  local transition_migrator_url="postgresql://pg18_transition_migrator:migrator-contract@127.0.0.1:${host_port}/main"
  local transition_runtime_url="postgresql://pg18_transition_runtime:runtime-contract@127.0.0.1:${host_port}/main"
  local transition_contract

  docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE ROLE pg18_transition_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_transition_runtime
  LOGIN PASSWORD 'runtime-contract'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_transition_migrator
  LOGIN PASSWORD 'migrator-contract'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA pg18_transition;
CREATE TABLE pg18_transition.probe (id integer PRIMARY KEY, marker text NOT NULL);
INSERT INTO pg18_transition.probe VALUES (1, 'must-survive-rollback');
CREATE FUNCTION pg18_transition.probe_function() RETURNS integer
  LANGUAGE sql AS 'SELECT 1';
CREATE PROCEDURE pg18_transition.probe_procedure()
  LANGUAGE sql AS 'SELECT 1';
SQL

  if EXPECTED_DATABASE=main \
    OWNER_ROLE=pg18_transition_owner \
    RUNTIME_ROLE=pg18_transition_runtime \
    MIGRATOR_ROLE=pg18_transition_migrator \
    FENCE_OWNER_ROLE=pg18_transition_fence_owner \
    INCLUDE_SCHEMAS=pg18_transition \
    INJECT_LATE_FAILURE=true \
    ADMIN_DATABASE_URL="$transition_admin_url" \
      "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
        prepare-source-acls >"$AUDIT_REPORT_FILE" 2>&1; then
    printf 'Expected injected prepare-source-acls failure\n' >&2
    exit 1
  fi
  assert_report_contains 'injected late prepare-source-acls failure'
  [[ "$(docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main -c "
SELECT (to_regrole('pg18_transition_fence_owner') IS NULL)::text || '|' ||
       (SELECT count(*) FROM pg_auth_members AS membership
        JOIN pg_roles AS member_role ON member_role.oid = membership.member
        WHERE member_role.rolname = 'pg18_transition_migrator') || '|' ||
       has_table_privilege('pg18_transition_runtime', 'pg18_transition.probe', 'SELECT')::text;")" == 'true|0|false' ]]

  EXPECTED_DATABASE=main \
  OWNER_ROLE=pg18_transition_owner \
  RUNTIME_ROLE=pg18_transition_runtime \
  MIGRATOR_ROLE=pg18_transition_migrator \
  FENCE_OWNER_ROLE=pg18_transition_fence_owner \
  INCLUDE_SCHEMAS=pg18_transition \
  ADMIN_DATABASE_URL="$transition_admin_url" \
    "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
      prepare-source-acls >/dev/null

  EXPECTED_DATABASE=main \
  OWNER_ROLE=pg18_transition_owner \
  RUNTIME_ROLE=pg18_transition_runtime \
  MIGRATOR_ROLE=pg18_transition_migrator \
  FENCE_OWNER_ROLE=pg18_transition_fence_owner \
  INCLUDE_SCHEMAS=pg18_transition \
  MIGRATOR_DATABASE_URL="$transition_migrator_url" \
    "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
      verify-migrator >/dev/null

  EXPECTED_DATABASE=main \
  OWNER_ROLE=pg18_transition_owner \
  RUNTIME_ROLE=pg18_transition_runtime \
  MIGRATOR_ROLE=pg18_transition_migrator \
  FENCE_OWNER_ROLE=pg18_transition_fence_owner \
  INCLUDE_SCHEMAS=pg18_transition \
  RUNTIME_DATABASE_URL="$transition_runtime_url" \
    "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
      probe-runtime >/dev/null

  PGPASSWORD=runtime-contract psql -X -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p "$host_port" -U pg18_transition_runtime -d main <<'SQL' >/dev/null
BEGIN;
INSERT INTO pg18_transition.probe VALUES (2, 'application-rollback-probe');
ROLLBACK;
SQL

  if EXPECTED_DATABASE=main \
    OWNER_ROLE=pg18_transition_owner \
  RUNTIME_ROLE=pg18_transition_runtime \
    MIGRATOR_ROLE=pg18_transition_migrator \
    FENCE_OWNER_ROLE=pg18_transition_fence_owner \
    INCLUDE_SCHEMAS=pg18_transition \
    DEPLOY_CREDENTIAL_ROTATED=true \
    ROLLBACK_PROBES_CONFIRMED=true \
    INJECT_LATE_FAILURE=true \
  ADMIN_DATABASE_URL="$transition_admin_url" \
  MIGRATOR_DATABASE_URL="$transition_migrator_url" \
  RUNTIME_DATABASE_URL="$transition_runtime_url" \
    "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
      transfer-ownership >"$AUDIT_REPORT_FILE" 2>&1; then
    printf 'Expected injected transfer-ownership failure\n' >&2
    exit 1
  fi
  assert_report_contains 'injected late transfer-ownership failure'
  [[ "$(docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main -c "
SELECT pg_get_userbyid(namespace.nspowner) || '|' || pg_get_userbyid(relation.relowner)
FROM pg_namespace AS namespace
JOIN pg_class AS relation ON relation.relnamespace = namespace.oid
WHERE namespace.nspname = 'pg18_transition' AND relation.relname = 'probe';")" == 'postgres|postgres' ]]

  EXPECTED_DATABASE=main \
  OWNER_ROLE=pg18_transition_owner \
  RUNTIME_ROLE=pg18_transition_runtime \
  MIGRATOR_ROLE=pg18_transition_migrator \
  FENCE_OWNER_ROLE=pg18_transition_fence_owner \
  INCLUDE_SCHEMAS=pg18_transition \
  DEPLOY_CREDENTIAL_ROTATED=true \
  ROLLBACK_PROBES_CONFIRMED=true \
  ADMIN_DATABASE_URL="$transition_admin_url" \
  MIGRATOR_DATABASE_URL="$transition_migrator_url" \
  RUNTIME_DATABASE_URL="$transition_runtime_url" \
    "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
      transfer-ownership >/dev/null

  MIGRATION_OWNER_TEST_DATABASE_URL="$transition_migrator_url" \
  MIGRATION_OWNER_TEST_ADMIN_DATABASE_URL="$transition_admin_url" \
  MIGRATION_OWNER_TEST_LOGIN_ROLE=pg18_transition_migrator \
  MIGRATION_OWNER_TEST_OWNER_ROLE=pg18_transition_owner \
  MIGRATION_OWNER_TEST_FENCE_OWNER_ROLE=pg18_transition_fence_owner \
  MIGRATION_OWNER_TEST_DATABASE_NAME=main \
  MIGRATION_OWNER_TEST_RUNTIME_DATABASE_URL="$transition_runtime_url" \
  MIGRATION_OWNER_TEST_RUNTIME_ROLE=pg18_transition_runtime \
  MIGRATION_OWNER_TEST_RUNTIME_SCHEMAS=pg18_transition \
    node --import tsx --test \
      "$REPOSITORY_ROOT/packages/db/scripts/migration-owner-role.integration.test.ts"

  transition_contract="$(docker exec "$CONTAINER_NAME" \
    psql -X -Atq -F '|' -U postgres -d main -c "
SELECT pg_get_userbyid(namespace.nspowner) || '|' ||
       pg_get_userbyid(relation.relowner) || '|' ||
       (SELECT count(*) FROM pg18_transition.probe) || '|' ||
       (SELECT count(*) = 1 AND bool_and(
                 privilege.privilege_type = 'CREATE' AND NOT privilege.is_grantable)
        FROM pg_database AS database
        JOIN pg_roles AS owner_role ON owner_role.rolname = 'pg18_transition_owner'
        CROSS JOIN LATERAL aclexplode(database.datacl) AS privilege
        WHERE database.datname = current_database()
          AND privilege.grantee = owner_role.oid)::text || '|' ||
       (SELECT count(*) = 1 AND bool_and(
                 NOT membership.admin_option AND NOT membership.inherit_option
                 AND membership.set_option)
        FROM pg_auth_members AS membership
        JOIN pg_roles AS member_role ON member_role.oid = membership.member
        JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
        WHERE member_role.rolname = 'pg18_transition_migrator'
          AND granted_role.rolname = 'pg18_transition_owner')::text
FROM pg_namespace AS namespace
JOIN pg_class AS relation ON relation.relnamespace = namespace.oid
WHERE namespace.nspname = 'pg18_transition' AND relation.relname = 'probe';")"
  [[ "$transition_contract" == 'pg18_transition_owner|pg18_transition_owner|1|true|true' ]] || {
    printf 'Production role transition contract failed: %s\n' "$transition_contract" >&2
    exit 1
  }

  docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL' >/dev/null
DROP SCHEMA pg18_transition CASCADE;
DROP OWNED BY pg18_transition_migrator;
DROP OWNED BY pg18_transition_runtime;
DROP OWNED BY pg18_transition_owner;
DROP OWNED BY pg18_transition_fence_owner;
DROP ROLE pg18_transition_migrator;
DROP ROLE pg18_transition_runtime;
DROP ROLE pg18_transition_owner;
DROP ROLE pg18_transition_fence_owner;
SQL
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
verify_development_role_bootstrap "$CONTAINER_NAME"

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -v expected_postgis_version="$IMAGE_POSTGIS_VERSION" <<'SQL'
CREATE EXTENSION postgis;
CREATE EXTENSION "uuid-ossp";
CREATE EXTENSION pg_trgm;
CREATE EXTENSION hypopg;

SELECT set_config('boardsesh.expected_postgis_version', :'expected_postgis_version', false);

DO $$
BEGIN
  IF current_setting('server_version_num')::integer <> 180006 THEN
    RAISE EXCEPTION 'expected PostgreSQL 18.6, got %', current_setting('server_version');
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
CREATE TABLE pg18_smoke_inheritance_parent (id integer PRIMARY KEY);
CREATE TABLE pg18_smoke_inheritance_child () INHERITS (pg18_smoke_inheritance_parent);
ALTER TABLE pg18_smoke_inheritance_child ADD PRIMARY KEY (id);

-- The first spatial fixture this smoke test has ever had. `CREATE EXTENSION
-- postgis` has been above since the file was written, with not one spatial
-- column under it, so the PostGIS half of the migration contract had nothing to
-- run against. This reproduces the application's real surface from the
-- migrations that created it: both geography(Point,4326) columns (0052, 0054),
-- both partial GiST indexes, and the lat/lng derivation trigger (0127).
--
-- The trigger is the reason the fixture exists in this shape. Its ST_MakePoint
-- call lives inside a plpgsql body, which PostgreSQL stores as opaque text and
-- records no pg_depend edge for, so a capability check built on catalog
-- dependencies alone would report that this database uses no PostGIS functions
-- at all. scripts/lib/postgres-spatial-capability.sh scans routine bodies for
-- exactly this reason, and this is what proves the scan works.
--
-- Everything past the two production-shaped tables is here to hold one specific
-- property of that library in place. Each is annotated where it is defined; the
-- assertions that read them are grouped after the post-teardown audit.
CREATE DOMAIN pg18_smoke_gps_point AS geography(Point, 4326);
CREATE TABLE pg18_smoke_gyms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  latitude double precision,
  longitude double precision,
  is_public boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  location geography(Point, 4326),
  -- A column that reaches geography through a user domain. The capability
  -- manifest must report the postgis type underneath, not this domain: the
  -- replication helper runs the same check BEFORE the schema restore, so a
  -- manifest naming pg18_smoke_gps_point would ask a pre-restore target for a
  -- type only that restore could create, and wedge the cutover permanently.
  checked_location pg18_smoke_gps_point
);
CREATE TABLE pg18_smoke_user_boards (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  latitude double precision,
  longitude double precision,
  is_public boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  location geography(Point, 4326)
);
CREATE FUNCTION pg18_smoke_set_location() RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location := ST_MakePoint(NEW.longitude, NEW.latitude)::geography;
  ELSE
    NEW.location := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pg18_smoke_gyms_set_location
  BEFORE INSERT OR UPDATE OF latitude, longitude ON pg18_smoke_gyms
  FOR EACH ROW EXECUTE FUNCTION pg18_smoke_set_location();
CREATE TRIGGER pg18_smoke_user_boards_set_location
  BEFORE INSERT OR UPDATE OF latitude, longitude ON pg18_smoke_user_boards
  FOR EACH ROW EXECUTE FUNCTION pg18_smoke_set_location();
CREATE INDEX pg18_smoke_gyms_location_idx ON pg18_smoke_gyms USING GIST (location)
  WHERE deleted_at IS NULL AND is_public = true;
CREATE INDEX pg18_smoke_user_boards_location_idx ON pg18_smoke_user_boards USING GIST (location)
  WHERE is_public = true AND deleted_at IS NULL;
-- An expression index is the cheapest object that records a real pg_depend edge
-- to a PostGIS function. Without one, every 'function' row in the manifest would
-- come from the routine-body scan and the catalog half of that dimension could
-- be deleted outright with this whole file still passing.
CREATE INDEX pg18_smoke_gyms_wkt_idx ON pg18_smoke_gyms (ST_AsText(location));
-- ... and an index predicate is the cheapest object that records an edge to a
-- PostGIS OPERATOR. `&&` is how a GiST index is actually driven, an operator
-- carries no pg_proc edge of its own, and the routine-body scan cannot see
-- operators at all, so this is the only thing holding that dimension up. The
-- bound is a literal rather than ST_MakePoint on purpose: a function call here
-- would add a catalog edge for st_makepoint and flip its manifest row from
-- 'routine-body' to 'catalog', which is exactly the evidence the plpgsql scan
-- assertion below depends on.
CREATE INDEX pg18_smoke_gyms_bbox_idx ON pg18_smoke_gyms USING GIST (location)
  WHERE location && 'SRID=4326;POINT(0 0)'::geography;
-- A user routine that shares a name with a PostGIS one. postgis_topology ships
-- its own st_srid/st_simplify/st_geometrytype, so this collision is production's
-- situation, not a contrivance; it deliberately breaks the pg18_smoke_ naming
-- convention because colliding is the entire point. If the manifest ever drops a
-- reference merely because some non-PostGIS routine shares the name, the
-- st_makepoint assertion below stops firing and the gate has gone quietly blind.
CREATE FUNCTION st_makepoint(text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT AS 'SELECT $1';
-- Every other row keeps a NULL location, so a copy that silently coerced NULL
-- to a point could not pass the EWKB comparison later in this file.
INSERT INTO pg18_smoke_gyms (name, latitude, longitude, is_public, deleted_at)
SELECT 'gym ' || n,
       CASE WHEN n % 2 = 0 THEN NULL ELSE -89 + (n * 1.77) END,
       CASE WHEN n % 2 = 0 THEN NULL ELSE -179 + (n * 3.55) END,
       n % 7 <> 0,
       CASE WHEN n % 11 = 0 THEN now() ELSE NULL END
FROM generate_series(1, 100) AS n;
INSERT INTO pg18_smoke_user_boards (name, latitude, longitude, is_public, deleted_at)
SELECT 'board ' || n,
       CASE WHEN n % 2 = 0 THEN NULL ELSE -88 + (n * 1.75) END,
       CASE WHEN n % 2 = 0 THEN NULL ELSE -178 + (n * 3.51) END,
       n % 5 <> 0,
       CASE WHEN n % 13 = 0 THEN now() ELSE NULL END
FROM generate_series(1, 100) AS n;

CREATE TYPE pg18_smoke_composite AS (
  marker text,
  attempt_count integer
);
CREATE DOMAIN pg18_smoke_domain AS integer
  DEFAULT 7 NOT NULL
  CONSTRAINT pg18_smoke_domain_positive CHECK (VALUE > 0);
CREATE TYPE pg18_smoke_range AS RANGE (
  subtype = integer,
  multirange_type_name = pg18_smoke_multirange
);
CREATE COLLATION pg18_smoke_collation (provider = libc, locale = 'C');
CREATE FUNCTION pg18_smoke_int_equal(integer, integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS 'SELECT $1 = $2';
CREATE PROCEDURE pg18_smoke_procedure()
  LANGUAGE sql AS 'SELECT 1';
CREATE OPERATOR === (
  LEFTARG = integer,
  RIGHTARG = integer,
  FUNCTION = pg18_smoke_int_equal,
  HASHES,
  MERGES
);
CREATE OPERATOR FAMILY pg18_smoke_btree_family USING btree;
CREATE OPERATOR CLASS pg18_smoke_btree_ops
  FOR TYPE integer USING btree FAMILY pg18_smoke_btree_family AS
  OPERATOR 3 = (integer, integer),
  FUNCTION 1 pg_catalog.btint4cmp(integer, integer);
CREATE STATISTICS pg18_smoke_statistics (dependencies)
  ON id, marker FROM pg18_smoke_persistence;

-- The schema is an extension member, but the table is a normal user object.
-- Schema discovery must classify it and the dump/audit must retain the table.
CREATE EXTENSION hstore;
CREATE SCHEMA pg18_extension_mixed;
ALTER EXTENSION hstore ADD SCHEMA pg18_extension_mixed;
CREATE TABLE pg18_extension_mixed.user_table (
  id integer PRIMARY KEY,
  marker text COLLATE public.pg18_smoke_collation NOT NULL
);
INSERT INTO pg18_extension_mixed.user_table VALUES (1, 'extension-schema-user-object');
CREATE SCHEMA pg18_empty_app;

CREATE SCHEMA drizzle;
CREATE TABLE public.__drizzle_migrations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint NOT NULL
);
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
CREATE ROLE pg18_smoke_runtime LOGIN PASSWORD 'runtime-smoke'
  NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_migrator LOGIN PASSWORD 'migration-owner-contract'
  NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_replication LOGIN NOSUPERUSER REPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_publisher LOGIN NOSUPERUSER REPLICATION NOBYPASSRLS
  PASSWORD 'publisher';
CREATE ROLE pg18_smoke_fence_owner NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_coordinator LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
ALTER ROLE pg18_smoke_publisher SET row_security = off;
GRANT pg18_smoke_owner TO pg18_smoke_migrator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT pg_read_all_stats TO pg18_smoke_fence_owner
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  pg_catalog.pg_control_checkpoint()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  pg_catalog.pg_control_checkpoint()
  TO pg18_smoke_fence_owner;
GRANT pg18_smoke_fence_owner TO pg18_smoke_owner
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT CREATE ON DATABASE main TO pg18_smoke_owner;

ALTER SCHEMA public OWNER TO pg18_smoke_owner;
ALTER SCHEMA drizzle OWNER TO pg18_smoke_owner;
ALTER SCHEMA pg18_extension_mixed OWNER TO pg18_smoke_owner;
ALTER SCHEMA pg18_empty_app OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_persistence OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_never_called OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_partitioned OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_partitioned_low OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_inheritance_parent OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_inheritance_child OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_gyms OWNER TO pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_user_boards OWNER TO pg18_smoke_owner;
ALTER FUNCTION public.pg18_smoke_set_location() OWNER TO pg18_smoke_owner;
ALTER FUNCTION public.st_makepoint(text) OWNER TO pg18_smoke_owner;
ALTER DOMAIN public.pg18_smoke_gps_point OWNER TO pg18_smoke_owner;
ALTER TABLE public.__drizzle_migrations OWNER TO pg18_smoke_owner;
ALTER TABLE drizzle.__drizzle_migrations OWNER TO pg18_smoke_owner;
ALTER TABLE pg18_extension_mixed.user_table OWNER TO pg18_smoke_owner;
ALTER TYPE public.pg18_smoke_composite OWNER TO pg18_smoke_owner;
ALTER DOMAIN public.pg18_smoke_domain OWNER TO pg18_smoke_owner;
ALTER TYPE public.pg18_smoke_range OWNER TO pg18_smoke_owner;
ALTER FUNCTION public.pg18_smoke_int_equal(integer, integer) OWNER TO pg18_smoke_owner;
ALTER PROCEDURE public.pg18_smoke_procedure() OWNER TO pg18_smoke_owner;
SELECT format('ALTER FUNCTION %s OWNER TO pg18_smoke_owner;', procedure.oid::regprocedure)
FROM pg_proc AS procedure
JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname = 'public'
  AND procedure.proname IN ('pg18_smoke_range', 'pg18_smoke_multirange')
ORDER BY procedure.oid
\gexec

GRANT USAGE ON SCHEMA public, drizzle, pg18_extension_mixed, pg18_empty_app TO pg18_smoke_runtime;
GRANT USAGE ON SCHEMA public, drizzle, pg18_extension_mixed TO pg18_smoke_publisher;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.pg18_smoke_persistence, public.pg18_smoke_never_called,
     public.pg18_smoke_partitioned, public.pg18_smoke_partitioned_low,
     public.pg18_smoke_inheritance_parent, public.pg18_smoke_inheritance_child,
     public.pg18_smoke_gyms, public.pg18_smoke_user_boards,
     pg18_extension_mixed.user_table
  TO pg18_smoke_runtime;
GRANT SELECT
  ON public.pg18_smoke_persistence, public.pg18_smoke_never_called,
     public.pg18_smoke_partitioned, public.pg18_smoke_partitioned_low,
     public.pg18_smoke_inheritance_parent, public.pg18_smoke_inheritance_child,
     public.pg18_smoke_gyms, public.pg18_smoke_user_boards,
     public.__drizzle_migrations, drizzle.__drizzle_migrations,
     pg18_extension_mixed.user_table
  TO pg18_smoke_publisher;
GRANT USAGE
  ON public.pg18_smoke_persistence_id_seq,
     public.pg18_smoke_never_called_id_seq,
     public.pg18_smoke_gyms_id_seq,
     public.pg18_smoke_user_boards_id_seq
  TO pg18_smoke_runtime;
REVOKE USAGE ON TYPE public.pg18_smoke_composite, public.pg18_smoke_domain,
  public.pg18_smoke_range, public.pg18_smoke_gps_point FROM PUBLIC;
GRANT USAGE ON TYPE public.pg18_smoke_composite, public.pg18_smoke_domain,
  public.pg18_smoke_range, public.pg18_smoke_gps_point
  TO pg18_smoke_runtime;
SELECT format('REVOKE ALL PRIVILEGES ON ROUTINE %s FROM PUBLIC; GRANT EXECUTE ON ROUTINE %s TO pg18_smoke_runtime;',
              procedure.oid::regprocedure, procedure.oid::regprocedure)
FROM pg_proc AS procedure
JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname IN ('public', 'drizzle')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_proc'::regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY procedure.oid
\gexec

ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner
  REVOKE ALL ON TABLES FROM PUBLIC, pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner
  REVOKE ALL ON SEQUENCES FROM PUBLIC, pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner
  REVOKE ALL ON ROUTINES FROM PUBLIC, pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner
  REVOKE ALL ON TYPES FROM PUBLIC, pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public, drizzle, pg18_extension_mixed, pg18_empty_app
  REVOKE ALL ON ROUTINES FROM PUBLIC, pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public, drizzle, pg18_extension_mixed, pg18_empty_app
  GRANT EXECUTE ON ROUTINES TO pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public, drizzle, pg18_extension_mixed, pg18_empty_app
  REVOKE ALL ON TYPES FROM PUBLIC, pg18_smoke_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public, drizzle, pg18_extension_mixed, pg18_empty_app
  GRANT USAGE ON TYPES TO pg18_smoke_runtime;
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

run_dev_db_migration_contract
run_production_role_transition_contract

MIGRATION_OWNER_TEST_DATABASE_URL="postgresql://pg18_smoke_migrator:migration-owner-contract@127.0.0.1:${host_port}/main" \
MIGRATION_OWNER_TEST_ADMIN_DATABASE_URL="$smoke_database_url" \
MIGRATION_OWNER_TEST_RUNTIME_DATABASE_URL="postgresql://pg18_smoke_runtime:runtime-smoke@127.0.0.1:${host_port}/main" \
MIGRATION_OWNER_TEST_LOGIN_ROLE=pg18_smoke_migrator \
MIGRATION_OWNER_TEST_OWNER_ROLE=pg18_smoke_owner \
MIGRATION_OWNER_TEST_FENCE_OWNER_ROLE=pg18_smoke_fence_owner \
MIGRATION_OWNER_TEST_RUNTIME_ROLE=pg18_smoke_runtime \
MIGRATION_OWNER_TEST_RUNTIME_SCHEMAS='public drizzle' \
  node --import tsx --test \
    "$REPOSITORY_ROOT/packages/db/scripts/migration-owner-role.integration.test.ts"

SOURCE_DATABASE_URL="$smoke_database_url" \
  TARGET_DATABASE_URL="$smoke_database_url" \
  EXPECTED_SOURCE_MAJOR=18 \
  EXPECTED_SOURCE_DATABASE=main \
  EXPECTED_TARGET_DATABASE=main \
  EXPECTED_POSTGIS_VERSION="$IMAGE_POSTGIS_VERSION" \
  MIGRATION_OWNER_ROLE=pg18_smoke_owner \
  MIGRATION_RUNTIME_ROLE=pg18_smoke_runtime \
  MIGRATION_MIGRATOR_ROLE=pg18_smoke_migrator \
  MIGRATION_REPLICATION_ROLE=pg18_smoke_replication \
  MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE=pg18_smoke_fence_owner \
  MIGRATION_SNAPSHOT_COORDINATOR_ROLE=pg18_smoke_coordinator \
  MIGRATION_SCHEMAS='public drizzle pg18_extension_mixed pg18_empty_app' \
  MIGRATION_RUNTIME_SCHEMAS='public drizzle pg18_extension_mixed pg18_empty_app' \
  "$REPOSITORY_ROOT/scripts/postgres-migration-audit.sh" >"$AUDIT_REPORT_FILE"
assert_report_contains 'Audit result: 0 blocker(s).'

# A schema with no table can still carry DDL which pg_dump must include. Prove
# each catalog family is classified rather than letting the explicit schema
# allowlist silently omit it.
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE SCHEMA pg18_unknown_view;
CREATE VIEW pg18_unknown_view.only_view AS SELECT 1 AS id;
CREATE SCHEMA pg18_unknown_composite;
CREATE TYPE pg18_unknown_composite.only_composite AS (id integer);
CREATE SCHEMA pg18_unknown_function;
CREATE FUNCTION pg18_unknown_function.only_function() RETURNS integer
  LANGUAGE sql IMMUTABLE AS 'SELECT 1';
CREATE SCHEMA pg18_unknown_type;
CREATE DOMAIN pg18_unknown_type.only_domain AS integer CHECK (VALUE > 0);
CREATE SCHEMA pg18_unknown_empty;
SQL
if SOURCE_DATABASE_URL="$smoke_database_url" \
  TARGET_DATABASE_URL="$smoke_database_url" \
  EXPECTED_SOURCE_MAJOR=18 \
  EXPECTED_SOURCE_DATABASE=main \
  EXPECTED_TARGET_DATABASE=main \
  EXPECTED_POSTGIS_VERSION="$IMAGE_POSTGIS_VERSION" \
  MIGRATION_OWNER_ROLE=pg18_smoke_owner \
  MIGRATION_RUNTIME_ROLE=pg18_smoke_runtime \
  MIGRATION_MIGRATOR_ROLE=pg18_smoke_migrator \
  MIGRATION_REPLICATION_ROLE=pg18_smoke_replication \
  MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE=pg18_smoke_fence_owner \
  MIGRATION_SNAPSHOT_COORDINATOR_ROLE=pg18_smoke_coordinator \
  MIGRATION_SCHEMAS='public drizzle pg18_extension_mixed pg18_empty_app' \
  MIGRATION_RUNTIME_SCHEMAS='public drizzle pg18_extension_mixed pg18_empty_app' \
  "$REPOSITORY_ROOT/scripts/postgres-migration-audit.sh" >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected unclassified schema-only objects to block the audit\n' >&2
  exit 1
fi
assert_report_contains 'pg18_unknown_composite, pg18_unknown_empty, pg18_unknown_function, pg18_unknown_type, pg18_unknown_view'
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
DROP SCHEMA pg18_unknown_view CASCADE;
DROP SCHEMA pg18_unknown_composite CASCADE;
DROP SCHEMA pg18_unknown_function CASCADE;
DROP SCHEMA pg18_unknown_type CASCADE;
DROP SCHEMA pg18_unknown_empty;
SQL

SOURCE_DATABASE_URL="$smoke_database_url" \
  TARGET_DATABASE_URL="$smoke_database_url" \
  EXPECTED_SOURCE_DATABASE=main \
  EXPECTED_TARGET_DATABASE=main \
  MIGRATION_SCHEMAS='public drizzle pg18_extension_mixed pg18_empty_app' \
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
  --publish 127.0.0.1::5432 \
  --volume "$TARGET_VOLUME_NAME:/var/lib/postgresql" \
  "$IMAGE_TAG" >/dev/null
wait_for_postgres "$TARGET_CONTAINER_NAME"
target_host_port="$(docker port "$TARGET_CONTAINER_NAME" 5432/tcp | awk -F: 'NR == 1 { print $NF }')"
[[ "$target_host_port" =~ ^[0-9]+$ ]]
readonly target_host_port

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE EXTENSION hstore;
CREATE SCHEMA pg18_extension_mixed;
ALTER EXTENSION hstore ADD SCHEMA pg18_extension_mixed;
CREATE OPERATOR FAMILY public.pg18_smoke_btree_family USING btree;
CREATE OPERATOR CLASS public.pg18_smoke_btree_ops
  FOR TYPE integer USING btree FAMILY public.pg18_smoke_btree_family AS
  OPERATOR 3 = (integer, integer),
  FUNCTION 1 pg_catalog.btint4cmp(integer, integer);
CREATE ROLE pg18_smoke_owner NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_runtime LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_migrator LOGIN PASSWORD 'migration-owner-contract'
  NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_standby LOGIN NOSUPERUSER REPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_subscriber LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_fence_owner NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg18_smoke_coordinator LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
GRANT pg18_smoke_owner TO pg18_smoke_migrator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT pg18_smoke_owner TO pg18_smoke_subscriber
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT pg_create_subscription TO pg18_smoke_subscriber
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
GRANT pg_read_all_stats TO pg18_smoke_fence_owner
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  pg_catalog.pg_control_checkpoint()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  pg_catalog.pg_control_checkpoint()
  TO pg18_smoke_fence_owner;
GRANT pg18_smoke_fence_owner TO pg18_smoke_owner
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT CREATE ON DATABASE main TO pg18_smoke_owner;
GRANT CREATE ON DATABASE main TO pg18_smoke_subscriber;
SQL

readonly source_admin_url="postgresql://postgres:postgres@${CONTAINER_NAME}:5432/main"
readonly source_publisher_url="postgresql://pg18_smoke_publisher:publisher@${CONTAINER_NAME}:5432/main"
readonly target_admin_url="postgresql://postgres:postgres@${TARGET_CONTAINER_NAME}:5432/main"

run_two_host_audit() {
  local publisher_url="${1:-$source_publisher_url}"
  docker run --rm \
    --network "$NETWORK_NAME" \
    --volume "$REPOSITORY_ROOT:/workspace:ro" \
    --entrypoint bash \
    --env SOURCE_DATABASE_URL="$source_admin_url" \
    --env SOURCE_REPLICATION_DATABASE_URL="$publisher_url" \
    --env TARGET_DATABASE_URL="$target_admin_url" \
    --env EXPECTED_SOURCE_MAJOR=18 \
    --env EXPECTED_SOURCE_DATABASE=main \
    --env EXPECTED_TARGET_DATABASE=main \
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
    --env MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE=pg18_smoke_fence_owner \
    --env MIGRATION_SNAPSHOT_COORDINATOR_ROLE=pg18_smoke_coordinator \
    --env 'MIGRATION_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app ops' \
    --env 'MIGRATION_RUNTIME_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app' \
    "$IMAGE_TAG" /workspace/scripts/postgres-migration-audit.sh
}

run_two_host_audit_without_publication() {
  docker run --rm \
    --network "$NETWORK_NAME" \
    --volume "$REPOSITORY_ROOT:/workspace:ro" \
    --entrypoint bash \
    --env SOURCE_DATABASE_URL="$source_admin_url" \
    --env TARGET_DATABASE_URL="$target_admin_url" \
    --env EXPECTED_SOURCE_MAJOR=18 \
    --env EXPECTED_SOURCE_DATABASE=main \
    --env EXPECTED_TARGET_DATABASE=main \
    --env EXPECTED_POSTGIS_VERSION="$IMAGE_POSTGIS_VERSION" \
    --env REQUIRE_PUBLICATION=false \
    --env MIGRATION_OWNER_ROLE=pg18_smoke_owner \
    --env MIGRATION_RUNTIME_ROLE=pg18_smoke_runtime \
    --env MIGRATION_MIGRATOR_ROLE=pg18_smoke_migrator \
    --env MIGRATION_REPLICATION_ROLE=pg18_smoke_standby \
    --env MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE=pg18_smoke_fence_owner \
    --env MIGRATION_SNAPSHOT_COORDINATOR_ROLE=pg18_smoke_coordinator \
    --env 'MIGRATION_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app ops' \
    --env 'MIGRATION_RUNTIME_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app' \
    "$IMAGE_TAG" /workspace/scripts/postgres-migration-audit.sh
}

expect_catalog_drift() {
  local label="$1"
  if run_two_host_audit >"$AUDIT_REPORT_FILE" 2>&1; then
    printf 'Expected %s to fail the catalog audit\n' "$label" >&2
    exit 1
  fi
  assert_report_contains 'catalog DDL manifest differs'
}

expect_audit_blocker() {
  local label="$1"
  local expected_message="$2"
  if run_two_host_audit >"$AUDIT_REPORT_FILE" 2>&1; then
    printf 'Expected %s to fail the migration audit\n' "$label" >&2
    exit 1
  fi
  if ! grep -Fq "$expected_message" "$AUDIT_REPORT_FILE"; then
    cat "$AUDIT_REPORT_FILE" >&2
    printf 'Audit rejected %s without the expected blocker: %s\n' \
      "$label" "$expected_message" >&2
    exit 1
  fi
}

assert_audit_clean() {
  if ! run_two_host_audit >"$AUDIT_REPORT_FILE" 2>&1; then
    cat "$AUDIT_REPORT_FILE" >&2
    printf 'Expected the source/target migration audit to be clean\n' >&2
    exit 1
  fi
  assert_report_contains 'Audit result: 0 blocker(s).'
}

run_sequence_sync() {
  docker run --rm \
    --network "$NETWORK_NAME" \
    --volume "$REPOSITORY_ROOT:/workspace:ro" \
    --entrypoint bash \
    --env NEON_DATABASE_URL="$source_admin_url" \
    --env RAILWAY_DATABASE_URL="$target_admin_url" \
    --env NEON_REPLICATION_DATABASE_URL="$source_publisher_url" \
    --env TARGET_OWNER_ROLE=pg18_smoke_owner \
    --env TARGET_SUBSCRIBER_ROLE=pg18_smoke_subscriber \
    --env SOURCE_DATABASE_NAME=main \
    --env TARGET_DATABASE_NAME=main \
    --env PUBLICATION_NAME=pg18_smoke_publication \
    --env SUBSCRIPTION_NAME=pg18_smoke_subscription \
    --env SLOT_NAME=pg18_smoke_subscription \
    --env 'INCLUDE_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app' \
    --env WRITES_FENCED=true \
    --env 'FENCED_WRITER_ROLES=pg18_smoke_runtime pg18_smoke_migrator' \
    "$IMAGE_TAG" /workspace/scripts/postgres-logical-replication.sh sync-sequences
}

run_data_verification() {
  docker run --rm \
    --network "$NETWORK_NAME" \
    --volume "$REPOSITORY_ROOT:/workspace:ro" \
    --entrypoint bash \
    --env SOURCE_DATABASE_URL="$source_admin_url" \
    --env TARGET_DATABASE_URL="$target_admin_url" \
    --env EXPECTED_SOURCE_DATABASE=main \
    --env EXPECTED_TARGET_DATABASE=main \
    --env 'MIGRATION_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app' \
    --env WRITES_FENCED=true \
    "$IMAGE_TAG" /workspace/scripts/postgres-migration-verify-data.sh
}

run_replication_setup_validation() {
  local publisher_url="${1:-$source_publisher_url}"
  docker run --rm \
    --network "$NETWORK_NAME" \
    --volume "$REPOSITORY_ROOT:/workspace:ro" \
    --entrypoint bash \
    --env NEON_DATABASE_URL="$source_admin_url" \
    --env RAILWAY_DATABASE_URL="$target_admin_url" \
    --env NEON_REPLICATION_DATABASE_URL="$publisher_url" \
    --env TARGET_OWNER_ROLE=pg18_smoke_owner \
    --env TARGET_MIGRATOR_ROLE=pg18_smoke_migrator \
    --env TARGET_SUBSCRIBER_ROLE=pg18_smoke_subscriber \
    --env TARGET_RUNTIME_ROLE=pg18_smoke_runtime \
    --env 'TARGET_RUNTIME_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app' \
    --env TARGET_SNAPSHOT_FENCE_OWNER_ROLE=pg18_smoke_fence_owner \
    --env SOURCE_DATABASE_NAME=main \
    --env TARGET_DATABASE_NAME=main \
    --env PUBLICATION_NAME=pg18_smoke_publication \
    --env SUBSCRIPTION_NAME=pg18_smoke_subscription \
    --env SLOT_NAME=pg18_smoke_subscription \
    --env 'INCLUDE_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app' \
    --env LOAD_SCHEMA=false \
    "$IMAGE_TAG" /workspace/scripts/postgres-logical-replication.sh setup
}

expect_setup_publisher_blocker() {
  local label="$1"
  local expected_message="${2:-publisher credential must be an ownership-free exact replication LOGIN}"
  if run_replication_setup_validation >"$AUDIT_REPORT_FILE" 2>&1; then
    printf 'Expected %s to fail publisher setup validation\n' "$label" >&2
    exit 1
  fi
  if ! grep -Fq "$expected_message" "$AUDIT_REPORT_FILE"; then
    cat "$AUDIT_REPORT_FILE" >&2
    printf 'Publisher setup rejected %s for an unexpected reason\n' "$label" >&2
    exit 1
  fi
}

expect_setup_subscriber_blocker() {
  local label="$1"
  if run_replication_setup_validation >"$AUDIT_REPORT_FILE" 2>&1; then
    printf 'Expected %s to fail subscriber setup validation\n' "$label" >&2
    exit 1
  fi
  if ! grep -Fq 'TARGET_SUBSCRIBER_ROLE must be a passwordless ownership-free exact LOGIN' \
    "$AUDIT_REPORT_FILE"; then
    cat "$AUDIT_REPORT_FILE" >&2
    printf 'Subscriber setup rejected %s for an unexpected reason\n' "$label" >&2
    exit 1
  fi
}

install_snapshot_fence_contract() {
  local container_name="$1"
  docker exec -i "$container_name" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE SCHEMA ops AUTHORIZATION pg18_smoke_owner;
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA ops TO pg18_smoke_fence_owner;

SET ROLE pg18_smoke_owner;
CREATE FUNCTION ops.board_snapshot_cluster_identity()
RETURNS TABLE (system_identifier text, timeline_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT system_control.system_identifier::text,
         checkpoint_control.timeline_id::bigint
  FROM pg_control_system() AS system_control
  CROSS JOIN pg_control_checkpoint() AS checkpoint_control;
$$;
REVOKE ALL ON FUNCTION ops.board_snapshot_cluster_identity() FROM PUBLIC;
ALTER FUNCTION ops.board_snapshot_cluster_identity() OWNER TO pg18_smoke_fence_owner;

CREATE FUNCTION ops.acquire_board_snapshot_fence(stability_window_seconds integer DEFAULT 30)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT count(*)
  FROM pg_stat_activity
  WHERE xact_start IS NOT NULL
    AND stability_window_seconds BETWEEN 0 AND 3600;
$$;
REVOKE ALL ON FUNCTION ops.acquire_board_snapshot_fence(integer) FROM PUBLIC;
ALTER FUNCTION ops.acquire_board_snapshot_fence(integer) OWNER TO pg18_smoke_fence_owner;
RESET ROLE;

GRANT USAGE ON SCHEMA ops TO pg18_smoke_coordinator;
GRANT EXECUTE ON FUNCTION ops.board_snapshot_cluster_identity(),
  ops.acquire_board_snapshot_fence(integer)
  TO pg18_smoke_coordinator;

SET ROLE pg18_smoke_coordinator;
SELECT system_identifier, timeline_id
FROM ops.board_snapshot_cluster_identity();
SELECT ops.acquire_board_snapshot_fence(0);
RESET ROLE;

DO $$
BEGIN
  IF pg_has_role('pg18_smoke_runtime', 'pg18_smoke_fence_owner', 'SET')
     OR pg_has_role('pg18_smoke_runtime', 'pg18_smoke_fence_owner', 'USAGE')
     OR has_schema_privilege('pg18_smoke_runtime', 'ops', 'CREATE')
     OR pg_has_role('pg18_smoke_coordinator', 'pg18_smoke_fence_owner', 'SET')
     OR pg_has_role('pg18_smoke_coordinator', 'pg18_smoke_fence_owner', 'USAGE')
     OR has_schema_privilege('pg18_smoke_coordinator', 'ops', 'CREATE') THEN
    RAISE EXCEPTION 'runtime or coordinator can cross the snapshot fence-owner boundary';
  END IF;
END
$$;
SQL
}

set_role_publisher_url="postgresql://postgres:postgres@${CONTAINER_NAME}:5432/main?application_name=pg18_smoke_subscription&options=-c%20role%3Dpg18_smoke_publisher"
if run_replication_setup_validation "$set_role_publisher_url" >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected privileged publisher URL using startup SET ROLE to fail\n' >&2
  exit 1
fi
assert_report_contains 'publisher URL must authenticate directly as its restricted role; startup SET ROLE is forbidden'

if run_replication_setup_validation >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected LOAD_SCHEMA=false with a missing target manifest to fail before publication mutation\n' >&2
  exit 1
fi
grep -Eq 'target is missing .* schema|target table manifest differs' "$AUDIT_REPORT_FILE"
retry_side_effects="$(docker exec "$CONTAINER_NAME" psql -X -Atq -F '|' -U postgres -d main -c "
SELECT count(*) || '|' ||
       (SELECT count(*) FROM pg_replication_slots WHERE slot_name = 'pg18_smoke_subscription')
FROM pg_publication
WHERE pubname = 'pg18_smoke_publication';")"
[[ "$retry_side_effects" == '0|0' ]]

run_replication_setup() {
  docker run --rm \
    --network "$NETWORK_NAME" \
    --volume "$REPOSITORY_ROOT:/workspace:ro" \
    --entrypoint bash \
    --env NEON_DATABASE_URL="$source_admin_url" \
    --env RAILWAY_DATABASE_URL="$target_admin_url" \
    --env NEON_REPLICATION_DATABASE_URL="$source_publisher_url" \
    --env TARGET_OWNER_ROLE=pg18_smoke_owner \
    --env TARGET_MIGRATOR_ROLE=pg18_smoke_migrator \
    --env TARGET_SUBSCRIBER_ROLE=pg18_smoke_subscriber \
    --env TARGET_RUNTIME_ROLE=pg18_smoke_runtime \
    --env 'TARGET_RUNTIME_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app' \
    --env TARGET_SNAPSHOT_FENCE_OWNER_ROLE=pg18_smoke_fence_owner \
    --env SOURCE_DATABASE_NAME=main \
    --env TARGET_DATABASE_NAME=main \
    --env PUBLICATION_NAME=pg18_smoke_publication \
    --env SUBSCRIPTION_NAME=pg18_smoke_subscription \
    --env SLOT_NAME=pg18_smoke_subscription \
    --env 'INCLUDE_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app' \
    --env EXPECTED_POSTGIS_VERSION="$IMAGE_POSTGIS_VERSION" \
    "$IMAGE_TAG" /workspace/scripts/postgres-logical-replication.sh setup
}

# setup must not have written a single catalog entry when a spatial gate fires:
# that gate runs before the dump, and running it after would make it advice.
assert_target_schema_unrestored() {
  local label="$1" unrestored_target_state
  unrestored_target_state="$(docker exec "$TARGET_CONTAINER_NAME" psql -X -Atq -U postgres -d main \
    -c "SELECT (to_regclass('public.pg18_smoke_gyms') IS NULL)::text;")"
  [[ "$unrestored_target_state" == 'true' ]] || {
    printf 'Setup restored schema despite %s\n' "$label" >&2
    exit 1
  }
}

# Drop one postgis member on the TARGET, prove setup aborts naming it, put it
# back. Extension membership is the right lever: the object itself is untouched,
# and every DDL/ownership/ACL manifest in this file filters deptype='e', so the
# capability gate is the only thing that can react to the change.
expect_setup_spatial_gap() {
  local label="$1" drop_statement="$2" add_statement="$3" expected_message="$4"
  local setup_succeeded=false
  docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
    -c "$drop_statement" >/dev/null
  run_replication_setup >"$AUDIT_REPORT_FILE" 2>&1 && setup_succeeded=true
  docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
    -c "$add_statement" >/dev/null
  if [[ "$setup_succeeded" == 'true' ]]; then
    printf 'Expected a target missing %s to abort setup\n' "$label" >&2
    exit 1
  fi
  assert_report_contains "$expected_message"
  assert_target_schema_unrestored "a target missing $label"
}

# Model the production reality the narrowed PostGIS gate exists for. Railway's
# PG16 tracks the mutable postgis/postgis:16-master tag and reports 3.7.0dev;
# the attested PG18 artifact is pinned to 3.6.4; PGDG publishes no stable 3.7
# for PostgreSQL 18 and PostGIS ships no downgrade script, so neither side can
# be moved to meet the other. Both containers here run the same image, so
# writing the source's recorded version is the only way to exercise a version
# difference at all. extversion is pure metadata -- pg_dump never emits it and
# nothing in the copy path reads it -- so this changes exactly the one fact the
# old gate compared and nothing else. Everything below runs with the difference
# in place, including the final post-teardown audit.
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "UPDATE pg_catalog.pg_extension SET extversion = '3.7.0dev' WHERE extname = 'postgis';" >/dev/null
source_postgis_extversion="$(docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main \
  -c "SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'postgis';")"
[[ "$source_postgis_extversion" == '3.7.0dev' ]] || {
  printf 'Could not stage a PostGIS version difference; source reports %s\n' \
    "$source_postgis_extversion" >&2
  exit 1
}

# The negative case for the narrowed gate: a PostGIS capability the source has
# and the target does not. Adding a function to the postgis extension is the
# only way to manufacture that between two containers running one image, and it
# is a faithful model -- a 3.7.0dev build genuinely does carry functions 3.6.4
# lacks. The reference goes in the plpgsql trigger body, so this also proves the
# routine-body scan is what catches it: there is no pg_depend edge here.
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL' >/dev/null
CREATE FUNCTION public.st_pg18_smoke_source_only(integer) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT AS 'SELECT $1';
ALTER EXTENSION postgis ADD FUNCTION public.st_pg18_smoke_source_only(integer);
CREATE OR REPLACE FUNCTION public.pg18_smoke_set_location() RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location := ST_MakePoint(NEW.longitude, NEW.latitude)::geography;
    PERFORM ST_PG18_Smoke_Source_Only(1);
  ELSE
    NEW.location := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
SQL
if run_replication_setup >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected a source PostGIS capability the target lacks to abort setup\n' >&2
  exit 1
fi
assert_report_contains 'the target PostGIS build does not provide function "st_pg18_smoke_source_only"'
assert_report_contains 'the target PostGIS build does not provide every capability the source uses'
assert_target_schema_unrestored 'an unsatisfied spatial capability'
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION public.pg18_smoke_set_location() RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location := ST_MakePoint(NEW.longitude, NEW.latitude)::geography;
  ELSE
    NEW.location := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
ALTER EXTENSION postgis DROP FUNCTION public.st_pg18_smoke_source_only(integer);
DROP FUNCTION public.st_pg18_smoke_source_only(integer);
SQL

# The function branch above is one of four the gap query decides. Before these
# three cases existed, rewriting `WHEN 'type' THEN EXISTS (...)` to
# `WHEN 'type' THEN true` -- or the opclass or operator branch the same way --
# passed this entire file.
expect_setup_spatial_gap 'the geography type' \
  'ALTER EXTENSION postgis DROP TYPE public.geography;' \
  'ALTER EXTENSION postgis ADD TYPE public.geography;' \
  'the target PostGIS build does not provide type "geography(Point,4326)"'
expect_setup_spatial_gap 'the geography GiST operator class' \
  'ALTER EXTENSION postgis DROP OPERATOR CLASS public.gist_geography_ops USING gist;' \
  'ALTER EXTENSION postgis ADD OPERATOR CLASS public.gist_geography_ops USING gist;' \
  'the target PostGIS build does not provide opclass "gist/public.gist_geography_ops"'
expect_setup_spatial_gap 'the geography overlap operator' \
  'ALTER EXTENSION postgis DROP OPERATOR public.&&(geography,geography);' \
  'ALTER EXTENSION postgis ADD OPERATOR public.&&(geography,geography);' \
  'the target PostGIS build does not provide operator "public.&&(geography,geography)"'

# Making the postgis row version-tolerant took the last exact PostGIS version
# comparison out of this script's path; assert_spatial_capability_precreated
# pins the target itself instead. Without it an operator who skipped the audit
# could restore into a build no rehearsal ever saw, so long as its function
# names happened to cover the manifest.
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "UPDATE pg_catalog.pg_extension SET extversion = '3.4.0' WHERE extname = 'postgis';" >/dev/null
if run_replication_setup >"$AUDIT_REPORT_FILE" 2>&1; then
  docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
    -c "UPDATE pg_catalog.pg_extension SET extversion = '$IMAGE_POSTGIS_VERSION' WHERE extname = 'postgis';" >/dev/null
  printf 'Expected an unexpected target PostGIS version to abort setup\n' >&2
  exit 1
fi
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "UPDATE pg_catalog.pg_extension SET extversion = '$IMAGE_POSTGIS_VERSION' WHERE extname = 'postgis';" >/dev/null
assert_report_contains "target PostGIS is 3.4.0; expected exactly $IMAGE_POSTGIS_VERSION"
assert_target_schema_unrestored 'an unexpected target PostGIS version'

# Same command, capability satisfied, PostGIS versions still different: this is
# the case the old version-equality gate made impossible.
run_replication_setup

excluded_target_state="$(docker exec "$TARGET_CONTAINER_NAME" psql -X -Atq -F '|' -U postgres -d main -c "
SELECT (to_regnamespace('neon_control_plane') IS NULL)::text || '|' ||
       (to_regclass('neon_control_plane.must_not_migrate') IS NULL)::text || '|' ||
       (to_regclass('pg18_extension_mixed.user_table') IS NOT NULL)::text || '|' ||
       (to_regnamespace('pg18_empty_app') IS NOT NULL)::text;")"
[[ "$excluded_target_state" == 'true|true|true|true' ]]

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

# The comparison docs/postgres-18-migration.md asks for by name: the on-the-wire
# binary of every populated geography, byte for byte, plus the row and populated
# counts so a copy that dropped rows or coerced NULL to a point cannot pass.
#
# ST_AsEWKB takes geometry, not geography. The rehearsal's first version
# compared a signature that does not exist, both sides errored to the empty
# string, and the comparison reported a match; the shape assertion below is what
# stops that recurring here.
spatial_geography_digest() {
  local container_name="$1"
  docker exec "$container_name" psql -X -Atq -v ON_ERROR_STOP=1 -U postgres -d main -c "
SELECT (SELECT md5(string_agg(encode(ST_AsEWKB(location::geometry), 'hex'), ',' ORDER BY id))
               || '|' || count(*) || '|' || count(location)
        FROM public.pg18_smoke_gyms)
       || '/' ||
       (SELECT md5(string_agg(encode(ST_AsEWKB(location::geometry), 'hex'), ',' ORDER BY id))
               || '|' || count(*) || '|' || count(location)
        FROM public.pg18_smoke_user_boards);"
}
source_geography_digest="$(spatial_geography_digest "$CONTAINER_NAME")"
target_geography_digest="$(spatial_geography_digest "$TARGET_CONTAINER_NAME")"
[[ "$source_geography_digest" =~ ^[0-9a-f]{32}\|100\|50/[0-9a-f]{32}\|100\|50$ ]] || {
  printf 'Source geography digest is not the expected shape: %s\n' "$source_geography_digest" >&2
  exit 1
}
[[ "$source_geography_digest" == "$target_geography_digest" ]] || {
  printf 'Geography EWKB differs across the logical copy:\n  source %s\n  target %s\n' \
    "$source_geography_digest" "$target_geography_digest" >&2
  exit 1
}

install_snapshot_fence_contract "$CONTAINER_NAME"
install_snapshot_fence_contract "$TARGET_CONTAINER_NAME"

# Migration 0200 is intentionally target-only and post-cutover. If it appears
# on the PG16 source, setup must stop before a generic --no-acl restore can
# strip its privileged ownership/ACL contract or restore triggers without it.
if run_replication_setup_validation >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected source-side post-cutover ops schema to block setup\n' >&2
  exit 1
fi
grep -Fq \
  'source contains the post-cutover ops schema; complete logical PG18 cutover before applying snapshot-fence migration 0200' \
  "$AUDIT_REPORT_FILE"

if run_two_host_audit "$set_role_publisher_url" >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected audit to reject privileged publisher URL using startup SET ROLE\n' >&2
  exit 1
fi
assert_report_contains 'publisher URL must authenticate directly as its restricted role; startup SET ROLE is forbidden'

MIGRATION_OWNER_TEST_DATABASE_URL="postgresql://pg18_smoke_migrator:migration-owner-contract@127.0.0.1:${target_host_port}/main" \
MIGRATION_OWNER_TEST_ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${target_host_port}/main" \
MIGRATION_OWNER_TEST_LOGIN_ROLE=pg18_smoke_migrator \
MIGRATION_OWNER_TEST_OWNER_ROLE=pg18_smoke_owner \
MIGRATION_OWNER_TEST_FENCE_OWNER_ROLE=pg18_smoke_fence_owner \
MIGRATION_OWNER_TEST_SUBSCRIBER_ROLE=pg18_smoke_subscriber \
MIGRATION_OWNER_TEST_SUBSCRIPTION_NAME=pg18_smoke_subscription \
MIGRATION_OWNER_TEST_DATABASE_NAME=main \
  node --import tsx --test \
    "$REPOSITORY_ROOT/packages/db/scripts/migration-owner-role.integration.test.ts"

# Establish a clean baseline before adversarial mutations so every later
# expected failure is attributable to the mutation it labels.
assert_audit_clean

# That clean audit ran with source PostGIS 3.7.0dev against target 3.6.4, which
# the old version-equality gate could never allow. Prove it reached the clean
# result by satisfying capabilities rather than by not looking: every dimension
# of the manifest has to be present, including the ST_MakePoint that lives only
# inside a plpgsql body and produces no catalog dependency.
assert_report_contains "NOTE: source PostGIS is 3.7.0dev and the pinned target artifact is $IMAGE_POSTGIS_VERSION"
assert_report_contains "('type', 'geography(Point,4326)', 'catalog'"
assert_report_contains "('opclass', 'gist/public.gist_geography_ops', 'catalog'"
assert_report_contains "('function', 'st_makepoint', 'routine-body'"
# The catalog half of the function dimension, which the routine-body assertion
# above cannot reach: st_astext is here only because an expression index records
# a real pg_depend edge to it. Delete that branch of the manifest query and this
# is the assertion that notices.
assert_report_contains "('function', 'st_astext', 'catalog'"
# The operator dimension. Nothing else in the manifest sees `&&`: it carries no
# pg_proc edge, and the textual scan matches st_*/postgis_* names only.
assert_report_contains "('operator', 'public.&&(geography,geography)', 'catalog'"
assert_report_contains "Spatial capability: target PostGIS $IMAGE_POSTGIS_VERSION satisfies every capability the source PostGIS 3.7.0dev manifest requires."

# The domain column must have been normalised to the postgis type underneath.
# Reporting the domain's own name instead is what wedges the cutover: the
# replication helper runs this same manifest before the restore, so the target
# would be asked for a type only that restore could create. Assert both halves --
# the postgis token names the domain column, and the domain name appears nowhere.
assert_report_contains "('type', 'geography(Point,4326)', 'catalog', 'public.pg18_smoke_gyms.checked_location"
if grep -Fq "'type', 'pg18_smoke_gps_point'" "$AUDIT_REPORT_FILE"; then
  cat "$AUDIT_REPORT_FILE" >&2
  printf 'Spatial manifest named a user domain instead of the PostGIS type under it\n' >&2
  exit 1
fi

# public.st_makepoint(text) exists in this fixture and is not a PostGIS routine.
# The st_makepoint assertion above therefore also proves the manifest keeps a
# reference whose name postgis provides even when something else shares it --
# the postgis_topology st_srid/st_simplify/st_geometrytype collision in
# miniature. A "does any other routine share this name?" test deletes that row.

# Tolerating the PostGIS version must not have tolerated versions in general.
# Every other extension is still compared exactly.
source_pg_trgm_extversion="$(docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main \
  -c "SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'pg_trgm';")"
[[ -n "$source_pg_trgm_extversion" ]]
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "UPDATE pg_catalog.pg_extension SET extversion = '0.0-smoke-drift' WHERE extname = 'pg_trgm';" >/dev/null
expect_audit_blocker 'non-PostGIS extension version drift' \
  'target is missing or mismatches source extension definition(s): pg_trgm|0.0-smoke-drift|public|'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "UPDATE pg_catalog.pg_extension SET extversion = '$source_pg_trgm_extversion' WHERE extname = 'pg_trgm';" >/dev/null
assert_audit_clean

# The audit's half of the target version pin. Target strictness is what makes
# source tolerance sound -- a capability manifest proven against a build no
# rehearsal ever saw proves nothing -- so this is the one comparison on the
# postgis row that must stay exact. The extension manifest is version-tolerant
# for postgis now, so nothing else can be reacting to this mutation.
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "UPDATE pg_catalog.pg_extension SET extversion = '3.4.0' WHERE extname = 'postgis';" >/dev/null
expect_audit_blocker 'target PostGIS version drift' \
  "target PostGIS is 3.4.0; expected exactly $IMAGE_POSTGIS_VERSION"
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "UPDATE pg_catalog.pg_extension SET extversion = '$IMAGE_POSTGIS_VERSION' WHERE extname = 'postgis';" >/dev/null
assert_audit_clean

# The audit's half of the capability negative. Both bodies change together so
# the DDL manifest stays identical and the only thing the audit can be reacting
# to is the missing capability itself.
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL' >/dev/null
CREATE FUNCTION public.st_pg18_smoke_source_only(integer) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT AS 'SELECT $1';
ALTER EXTENSION postgis ADD FUNCTION public.st_pg18_smoke_source_only(integer);
SQL
replace_smoke_location_trigger_body() {
  local extra_statement="$1" container_name
  for container_name in "$CONTAINER_NAME" "$TARGET_CONTAINER_NAME"; do
    docker exec -i "$container_name" psql -X -v ON_ERROR_STOP=1 -U postgres -d main >/dev/null <<SQL
CREATE OR REPLACE FUNCTION public.pg18_smoke_set_location() RETURNS trigger AS \$\$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location := ST_MakePoint(NEW.longitude, NEW.latitude)::geography;
    ${extra_statement}
  ELSE
    NEW.location := NULL;
  END IF;
  RETURN NEW;
END;
\$\$ LANGUAGE plpgsql;
SQL
  done
}
replace_smoke_location_trigger_body 'PERFORM ST_PG18_Smoke_Source_Only(1);'
expect_audit_blocker 'PostGIS capability the target build lacks' \
  'the target PostGIS build does not provide function "st_pg18_smoke_source_only"'
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL' >/dev/null
ALTER EXTENSION postgis DROP FUNCTION public.st_pg18_smoke_source_only(integer);
DROP FUNCTION public.st_pg18_smoke_source_only(integer);
SQL

# A PostGIS-shaped name that resolves nowhere is not silently tolerated either.
# The routine-body scan is textual and cannot resolve overloads or operators, so
# the one thing it must never do is treat "I do not recognise this" as "fine".
replace_smoke_location_trigger_body 'PERFORM ST_PG18_Smoke_Absent(1);'
expect_audit_blocker 'unclassifiable spatial reference' \
  'source spatial capability cannot be classified'
replace_smoke_location_trigger_body '-- no extra spatial reference'
assert_audit_clean

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT EXECUTE ON FUNCTION ops.acquire_board_snapshot_fence(integer) TO PUBLIC;' >/dev/null
expect_audit_blocker 'PUBLIC snapshot fence execution' \
  'snapshot SECURITY DEFINER functions must have the dedicated fence owner and no PUBLIC EXECUTE grant'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE EXECUTE ON FUNCTION ops.acquire_board_snapshot_fence(integer) FROM PUBLIC;' >/dev/null

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_checkpoint() FROM pg18_smoke_fence_owner;' >/dev/null
expect_audit_blocker 'missing control-function privilege' \
  'snapshot fence owner lacks exact direct non-grantable EXECUTE ACLs on pg_control_system() or pg_control_checkpoint()'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_checkpoint() TO pg18_smoke_fence_owner;' >/dev/null

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_checkpoint() TO pg18_smoke_fence_owner WITH GRANT OPTION;' >/dev/null
expect_audit_blocker 'grantable control-function privilege' \
  'snapshot fence owner lacks exact direct non-grantable EXECUTE ACLs on pg_control_system() or pg_control_checkpoint()'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION pg_catalog.pg_control_checkpoint() FROM pg18_smoke_fence_owner;' >/dev/null

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE ROLE pg18_smoke_acl_grantor NOLOGIN;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system()
  TO pg18_smoke_acl_grantor WITH GRANT OPTION;
SET ROLE pg18_smoke_acl_grantor;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO pg18_smoke_fence_owner;
RESET ROLE;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_checkpoint() FROM pg18_smoke_fence_owner;
SQL
expect_audit_blocker 'duplicate grantor masking a missing control-function ACL' \
  'snapshot fence owner lacks exact direct non-grantable EXECUTE ACLs on pg_control_system() or pg_control_checkpoint()'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_checkpoint() TO pg18_smoke_fence_owner;
SET ROLE pg18_smoke_acl_grantor;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM pg18_smoke_fence_owner;
RESET ROLE;
REVOKE ALL ON FUNCTION pg_catalog.pg_control_system() FROM pg18_smoke_acl_grantor;
DROP ROLE pg18_smoke_acl_grantor;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_stat_file(text) TO pg18_smoke_fence_owner;
SQL
expect_audit_blocker 'unexpected direct fence-owner function privilege' \
  'snapshot fence owner has a direct function EXECUTE ACL outside the four-function boundary'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_stat_file(text) FROM pg18_smoke_fence_owner;' >/dev/null

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE pg_read_all_stats FROM pg18_smoke_fence_owner;
CREATE ROLE pg18_smoke_stats_proxy NOLOGIN;
GRANT pg_read_all_stats TO pg18_smoke_stats_proxy
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
GRANT pg18_smoke_stats_proxy TO pg18_smoke_fence_owner
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
SQL
expect_audit_blocker 'inherited but non-direct stats membership' \
  'snapshot fence owner must inherit pg_read_all_stats without ADMIN or SET OPTION'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE pg18_smoke_stats_proxy FROM pg18_smoke_fence_owner;
REVOKE pg_read_all_stats FROM pg18_smoke_stats_proxy;
DROP ROLE pg18_smoke_stats_proxy;
GRANT pg_read_all_stats TO pg18_smoke_fence_owner
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
SQL

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'ALTER ROLE pg18_smoke_fence_owner CREATEDB;' >/dev/null
expect_audit_blocker 'fence owner CREATEDB escalation' \
  'snapshot fence owner must be NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, NOREPLICATION, and NOBYPASSRLS'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'ALTER ROLE pg18_smoke_fence_owner NOCREATEDB CREATEROLE;' >/dev/null
expect_audit_blocker 'fence owner CREATEROLE escalation' \
  'snapshot fence owner must be NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, NOREPLICATION, and NOBYPASSRLS'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'ALTER ROLE pg18_smoke_fence_owner NOCREATEDB NOCREATEROLE;' >/dev/null

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT TEMPORARY ON DATABASE main TO pg18_smoke_fence_owner;' >/dev/null
expect_audit_blocker 'unexpected fence-owner database ACL' \
  'snapshot fence owner has unexpected database/schema/object ownership or a direct ACL outside its ops/function/column allowlist'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE TEMPORARY ON DATABASE main FROM pg18_smoke_fence_owner;' >/dev/null

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT USAGE ON SCHEMA public TO pg18_smoke_fence_owner;' >/dev/null
expect_audit_blocker 'unexpected fence-owner schema ACL' \
  'snapshot fence owner has unexpected database/schema/object ownership or a direct ACL outside its ops/function/column allowlist'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE USAGE ON SCHEMA public FROM pg18_smoke_fence_owner;' >/dev/null

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT SELECT ON TABLE public.pg18_smoke_persistence TO pg18_smoke_fence_owner;' >/dev/null
expect_audit_blocker 'unexpected fence-owner relation ACL' \
  'snapshot fence owner has unexpected database/schema/object ownership or a direct ACL outside its ops/function/column allowlist'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE SELECT ON TABLE public.pg18_smoke_persistence FROM pg18_smoke_fence_owner;' >/dev/null

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT SELECT (marker) ON TABLE public.pg18_smoke_persistence TO pg18_smoke_fence_owner;' >/dev/null
expect_audit_blocker 'unexpected fence-owner column ACL' \
  'snapshot fence owner has unexpected database/schema/object ownership or a direct ACL outside its ops/function/column allowlist'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE SELECT (marker) ON TABLE public.pg18_smoke_persistence FROM pg18_smoke_fence_owner;' >/dev/null

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE SCHEMA pg18_fence_rogue;
CREATE TABLE pg18_fence_rogue.owned_table (id integer);
ALTER TABLE pg18_fence_rogue.owned_table OWNER TO pg18_smoke_fence_owner;
SQL
expect_audit_blocker 'unexpected fence-owner object ownership' \
  'snapshot fence owner has unexpected database/schema/object ownership or a direct ACL outside its ops/function/column allowlist'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'DROP SCHEMA pg18_fence_rogue CASCADE;' >/dev/null

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE ROLE pg18_fence_incoming_rogue NOLOGIN;
GRANT pg18_smoke_fence_owner TO pg18_fence_incoming_rogue
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
SQL
expect_audit_blocker 'unexpected incoming fence-owner membership' \
  'snapshot fence owner must have exactly the two direct membership edges in the role contract'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE pg18_smoke_fence_owner FROM pg18_fence_incoming_rogue;
DROP ROLE pg18_fence_incoming_rogue;
SQL

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT pg18_smoke_fence_owner TO pg18_smoke_runtime WITH INHERIT FALSE, SET TRUE;' >/dev/null
expect_audit_blocker 'runtime fence-owner escalation' \
  'runtime role can SET/USE the snapshot fence owner or CREATE in ops'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE pg18_smoke_fence_owner FROM pg18_smoke_runtime;' >/dev/null

# Composite attributes and every domain/range definition are part of the DDL
# gate. Exercise each independently so a future catalog-query simplification
# cannot turn a real mismatch into a false green.
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER TYPE public.pg18_smoke_composite ALTER ATTRIBUTE marker TYPE varchar(64);
RESET ROLE;
SQL
expect_catalog_drift 'composite attribute drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER TYPE public.pg18_smoke_composite ALTER ATTRIBUTE marker TYPE text;
RESET ROLE;
SQL

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_inheritance_child
  NO INHERIT public.pg18_smoke_inheritance_parent;
RESET ROLE;
SQL
expect_catalog_drift 'table inheritance drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_inheritance_child
  INHERIT public.pg18_smoke_inheritance_parent;
ALTER TABLE public.pg18_smoke_persistence ALTER COLUMN marker SET STATISTICS 321;
RESET ROLE;
SQL
expect_catalog_drift 'column statistics target drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_persistence ALTER COLUMN marker SET STATISTICS -1;
ALTER TABLE public.pg18_smoke_persistence
  REPLICA IDENTITY USING INDEX pg18_smoke_persistence_pkey;
RESET ROLE;
SQL
expect_catalog_drift 'replica-identity index flag drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_persistence REPLICA IDENTITY DEFAULT;
CLUSTER public.pg18_smoke_persistence USING pg18_smoke_persistence_pkey;
RESET ROLE;
SQL
expect_catalog_drift 'clustered index flag drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER TABLE public.pg18_smoke_persistence SET WITHOUT CLUSTER;
RESET ROLE;
SQL

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER SCHEMA pg18_empty_app RENAME TO pg18_empty_app_drift;
RESET ROLE;
SQL
expect_catalog_drift 'schema-only definition drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER SCHEMA pg18_empty_app_drift RENAME TO pg18_empty_app;
RESET ROLE;
SQL

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER DOMAIN public.pg18_smoke_domain DROP CONSTRAINT pg18_smoke_domain_positive;
RESET ROLE;
SQL
expect_catalog_drift 'domain constraint drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER DOMAIN public.pg18_smoke_domain
  ADD CONSTRAINT pg18_smoke_domain_positive CHECK (VALUE > 0);
ALTER DOMAIN public.pg18_smoke_domain SET DEFAULT 8;
RESET ROLE;
SQL
expect_catalog_drift 'domain default drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER DOMAIN public.pg18_smoke_domain SET DEFAULT 7;
RESET ROLE;
SQL

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
DROP TYPE public.pg18_smoke_range CASCADE;
CREATE TYPE public.pg18_smoke_range AS RANGE (
  subtype = bigint,
  multirange_type_name = pg18_smoke_multirange
);
RESET ROLE;
SQL
expect_catalog_drift 'range and multirange definition drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
DROP TYPE public.pg18_smoke_range CASCADE;
CREATE TYPE public.pg18_smoke_range AS RANGE (
  subtype = integer,
  multirange_type_name = pg18_smoke_multirange
);
RESET ROLE;
SELECT format('ALTER FUNCTION %s OWNER TO pg18_smoke_owner;', procedure.oid::regprocedure)
FROM pg_proc AS procedure
JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname = 'public'
  AND procedure.proname IN ('pg18_smoke_range', 'pg18_smoke_multirange')
ORDER BY procedure.oid
\gexec
REVOKE USAGE ON TYPE public.pg18_smoke_range FROM PUBLIC;
GRANT USAGE ON TYPE public.pg18_smoke_range
  TO pg18_smoke_runtime;
SELECT format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC; GRANT EXECUTE ON FUNCTION %s TO pg18_smoke_runtime;',
              procedure.oid::regprocedure, procedure.oid::regprocedure)
FROM pg_proc AS procedure
JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname = 'public'
  AND procedure.proname IN ('pg18_smoke_range', 'pg18_smoke_multirange')
ORDER BY procedure.oid
\gexec
SQL

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER COLLATION public.pg18_smoke_collation RENAME TO pg18_smoke_collation_drift;
RESET ROLE;
SQL
expect_catalog_drift 'collation definition drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER COLLATION public.pg18_smoke_collation_drift RENAME TO pg18_smoke_collation;
ALTER OPERATOR public.=== (integer, integer) SET SCHEMA pg18_empty_app;
SQL
expect_catalog_drift 'custom operator drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER OPERATOR pg18_empty_app.=== (integer, integer) SET SCHEMA public;
ALTER OPERATOR CLASS public.pg18_smoke_btree_ops USING btree
  RENAME TO pg18_smoke_btree_ops_drift;
SQL
expect_catalog_drift 'operator family/class drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER OPERATOR CLASS public.pg18_smoke_btree_ops_drift USING btree
  RENAME TO pg18_smoke_btree_ops;
SET ROLE pg18_smoke_owner;
ALTER STATISTICS public.pg18_smoke_statistics RENAME TO pg18_smoke_statistics_drift;
RESET ROLE;
SQL
expect_catalog_drift 'extended statistics drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER STATISTICS public.pg18_smoke_statistics_drift RENAME TO pg18_smoke_statistics;
ALTER STATISTICS public.pg18_smoke_statistics SET STATISTICS 777;
RESET ROLE;
SQL
expect_catalog_drift 'extended statistics target drift'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
ALTER STATISTICS public.pg18_smoke_statistics SET STATISTICS DEFAULT;
RESET ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO pg18_smoke_coordinator;
SQL
expect_catalog_drift 'default ACL drift'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public REVOKE SELECT ON TABLES FROM pg18_smoke_coordinator;' >/dev/null
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public GRANT TRUNCATE ON TABLES TO pg18_smoke_runtime;' >/dev/null
expect_audit_blocker 'unexpected runtime default privilege' \
  'unexpected or grantable owner→runtime default privilege(s) exist'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM pg18_smoke_runtime;' >/dev/null

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner GRANT EXECUTE ON ROUTINES TO PUBLIC;' >/dev/null
expect_audit_blocker 'owner-wide PUBLIC routine default privilege' \
  'owner-wide defaults still grant PUBLIC routine EXECUTE or type USAGE'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner REVOKE ALL ON ROUTINES FROM PUBLIC;' >/dev/null

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner GRANT USAGE ON TYPES TO PUBLIC;' >/dev/null
expect_audit_blocker 'owner-wide PUBLIC type default privilege' \
  'owner-wide defaults still grant PUBLIC routine EXECUTE or type USAGE'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE pg18_smoke_owner REVOKE ALL ON TYPES FROM PUBLIC;' >/dev/null

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
SET ROLE pg18_smoke_owner;
CREATE AGGREGATE public.pg18_smoke_unsupported_sum(integer) (
  SFUNC = pg_catalog.int4pl,
  STYPE = integer,
  INITCOND = '0'
);
RESET ROLE;
SQL
expect_audit_blocker 'unsupported aggregate DDL' \
  'source contains DDL classes that are deliberately unsupported by the migration catalog gate: aggregate:public.pg18_smoke_unsupported_sum(integer)'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'DROP AGGREGATE public.pg18_smoke_unsupported_sum(integer);' >/dev/null

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE TYPE public.pg18_smoke_unsupported_shell;
SQL
expect_audit_blocker 'unsupported shell/base type DDL' \
  'source contains DDL classes that are deliberately unsupported by the migration catalog gate: base_or_pseudo_type:public.pg18_smoke_unsupported_shell'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'DROP TYPE public.pg18_smoke_unsupported_shell;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT SELECT (marker) ON public.pg18_smoke_persistence TO pg18_smoke_coordinator;' >/dev/null
expect_audit_blocker 'source column ACL omitted by --no-acl' \
  'source has 1 included non-extension column ACL(s); --no-acl cannot preserve column grants'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE SELECT (marker) ON public.pg18_smoke_persistence FROM pg18_smoke_coordinator;' >/dev/null
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT SELECT (marker) ON public.pg18_smoke_persistence TO pg18_smoke_coordinator;' >/dev/null
expect_audit_blocker 'target column ACL outside reconstruction policy' \
  'target has 1 included non-extension column ACL(s); exact post-restore ACL reconstruction forbids column grants'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE SELECT (marker) ON public.pg18_smoke_persistence FROM pg18_smoke_coordinator;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'DROP EXTENSION hypopg;' >/dev/null
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'DROP EXTENSION hypopg;' >/dev/null
assert_audit_clean
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'CREATE EXTENSION hypopg;' >/dev/null
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'CREATE EXTENSION hypopg;' >/dev/null

# Direct ACL/role-edge checks must not turn green through PUBLIC or inherited
# proxy roles.
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE SELECT ON TABLE pg18_extension_mixed.user_table FROM pg18_smoke_runtime;
GRANT SELECT ON TABLE pg18_extension_mixed.user_table TO PUBLIC;
SQL
expect_audit_blocker 'PUBLIC masking a missing direct runtime ACL' \
  'runtime role lacks exact direct non-grantable CRUD ACLs'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE SELECT ON TABLE pg18_extension_mixed.user_table FROM PUBLIC;
GRANT SELECT ON TABLE pg18_extension_mixed.user_table TO pg18_smoke_runtime;
GRANT TRUNCATE ON TABLE pg18_extension_mixed.user_table TO pg18_smoke_runtime;
SQL
expect_audit_blocker 'unexpected direct runtime table privilege' \
  'runtime role lacks exact direct non-grantable CRUD ACLs'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE TRUNCATE ON TABLE pg18_extension_mixed.user_table FROM pg18_smoke_runtime;
ALTER ROLE pg18_smoke_runtime CREATEDB;
SQL
expect_audit_blocker 'runtime CREATEDB escalation' \
  'runtime role must be LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, NOREPLICATION, and NOBYPASSRLS'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER ROLE pg18_smoke_runtime NOCREATEDB;
GRANT pg18_smoke_owner TO pg18_smoke_migrator
  WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
SQL
expect_audit_blocker 'migrator ADMIN OPTION escalation' \
  'migrator role cannot SET ROLE to the NOLOGIN app owner'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE ADMIN OPTION FOR pg18_smoke_owner FROM pg18_smoke_migrator;
REVOKE CREATE ON DATABASE main FROM pg18_smoke_owner;
CREATE ROLE pg18_smoke_database_create_proxy NOLOGIN;
GRANT CREATE ON DATABASE main TO pg18_smoke_database_create_proxy;
GRANT pg18_smoke_database_create_proxy TO pg18_smoke_owner
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
SQL
expect_audit_blocker 'effective proxy database CREATE false green' \
  'owner role needs exactly one direct non-grantable CREATE ACL'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE CREATE ON DATABASE main FROM pg18_smoke_database_create_proxy;
GRANT CREATE ON DATABASE main TO pg18_smoke_owner;
SQL
expect_audit_blocker 'unexpected direct owner membership' \
  'app owner must have exactly one direct role membership: SET-only in the snapshot fence owner'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE pg18_smoke_database_create_proxy FROM pg18_smoke_owner;
DROP ROLE pg18_smoke_database_create_proxy;
GRANT TEMPORARY ON DATABASE main TO pg18_smoke_owner;
SQL
expect_audit_blocker 'unexpected direct owner database privilege' \
  'owner role needs exactly one direct non-grantable CREATE ACL'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE TEMPORARY ON DATABASE main FROM pg18_smoke_owner;
SQL

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c 'ALTER DATABASE main OWNER TO pg18_smoke_owner;' >/dev/null
if run_replication_setup_validation >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected a target owner that owns the database to fail setup validation\n' >&2
  exit 1
fi
assert_report_contains 'TARGET_OWNER_ROLE must match the exact restricted NOLOGIN/database-CREATE contract'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c 'ALTER DATABASE main OWNER TO postgres;' >/dev/null
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT CREATE ON DATABASE main TO pg18_smoke_owner;' >/dev/null

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT pg_create_subscription TO pg18_smoke_subscriber WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;' >/dev/null
expect_audit_blocker 'subscriber SET OPTION escalation' \
  'subscriber owner lacks direct non-grantable database CREATE or exact direct pg_create_subscription membership'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE SET OPTION FOR pg_create_subscription FROM pg18_smoke_subscriber;
GRANT TEMPORARY ON DATABASE main TO pg18_smoke_subscriber;
SQL
expect_audit_blocker 'unexpected direct subscriber database privilege' \
  'subscriber owner lacks direct non-grantable database CREATE or exact direct pg_create_subscription membership'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE TEMPORARY ON DATABASE main FROM pg18_smoke_subscriber;
ALTER ROLE pg18_smoke_subscriber PASSWORD 'must-not-be-externally-usable';
SQL
expect_setup_subscriber_blocker 'subscriber password is present'
expect_audit_blocker 'subscriber password is present' \
  'subscriber owner must be a passwordless LOGIN'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER ROLE pg18_smoke_subscriber PASSWORD NULL;
GRANT CREATE ON SCHEMA public TO pg18_smoke_subscriber;
SQL
expect_audit_blocker 'unexpected direct subscriber schema privilege' \
  'subscriber owner has an incoming role edge, schema CREATE/DML, or ownership outside the exact active subscription'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE CREATE ON SCHEMA public FROM pg18_smoke_subscriber;
SQL

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE ROLE pg18_subscriber_incoming_rogue NOLOGIN;
GRANT pg18_smoke_subscriber TO pg18_subscriber_incoming_rogue
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
SQL
expect_setup_subscriber_blocker 'subscriber incoming membership'
expect_audit_blocker 'subscriber incoming membership' \
  'subscriber owner has an incoming role edge, schema CREATE/DML, or ownership outside the exact active subscription'
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE pg18_smoke_subscriber FROM pg18_subscriber_incoming_rogue;
DROP ROLE pg18_subscriber_incoming_rogue;
SQL

docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT INSERT ON TABLE public.pg18_smoke_persistence TO PUBLIC;' >/dev/null
expect_setup_subscriber_blocker 'PUBLIC DML inherited by subscriber'
expect_audit_blocker 'PUBLIC DML inherited by subscriber' \
  'subscriber owner has an incoming role edge, schema CREATE/DML, or ownership outside the exact active subscription'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE INSERT ON TABLE public.pg18_smoke_persistence FROM PUBLIC;' >/dev/null

docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE SCHEMA pg18_subscriber_rogue;
CREATE TABLE pg18_subscriber_rogue.owned_table (id integer);
ALTER TABLE pg18_subscriber_rogue.owned_table OWNER TO pg18_smoke_subscriber;
SQL
expect_setup_subscriber_blocker 'subscriber object ownership'
expect_audit_blocker 'subscriber object ownership' \
  'subscriber owner has an incoming role edge, schema CREATE/DML, or ownership outside the exact active subscription'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'DROP SCHEMA pg18_subscriber_rogue CASCADE;' >/dev/null

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE SELECT ON TABLE pg18_extension_mixed.user_table FROM pg18_smoke_publisher;
GRANT SELECT ON TABLE pg18_extension_mixed.user_table TO PUBLIC;
SQL
expect_audit_blocker 'PUBLIC masking a missing direct publisher ACL' \
  'lacks direct non-grantable SELECT'
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE SELECT ON TABLE pg18_extension_mixed.user_table FROM PUBLIC;
GRANT SELECT ON TABLE pg18_extension_mixed.user_table TO pg18_smoke_publisher;
GRANT INSERT ON TABLE pg18_extension_mixed.user_table TO pg18_smoke_publisher;
SQL
expect_setup_publisher_blocker 'unexpected direct publisher table privilege'
expect_audit_blocker 'unexpected direct publisher table privilege' \
  'publisher role pg18_smoke_publisher must be an ownership-free exact replication LOGIN'
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE INSERT ON TABLE pg18_extension_mixed.user_table FROM pg18_smoke_publisher;
SQL

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT SELECT ON TABLE neon_control_plane.must_not_migrate TO pg18_smoke_publisher;' >/dev/null
expect_setup_publisher_blocker 'publisher SELECT on excluded relation' \
  'publisher credential has 1 direct relation ACL(s) outside exact non-grantable SELECT on the publication manifest'
expect_audit_blocker 'publisher SELECT on excluded relation' \
  'publisher role pg18_smoke_publisher has 1 direct relation ACL(s) outside exact non-grantable SELECT on the publication manifest'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE SELECT ON TABLE neon_control_plane.must_not_migrate FROM pg18_smoke_publisher;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT USAGE ON SCHEMA neon_control_plane TO pg18_smoke_publisher;' >/dev/null
expect_setup_publisher_blocker 'publisher USAGE on excluded schema' \
  'publisher credential has 1 direct schema ACL(s) outside exact non-grantable USAGE on publication schemas'
expect_audit_blocker 'publisher USAGE on excluded schema' \
  'publisher role pg18_smoke_publisher has 1 direct schema ACL(s) outside exact non-grantable USAGE on publication schemas'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE USAGE ON SCHEMA neon_control_plane FROM pg18_smoke_publisher;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT SELECT (marker) ON TABLE public.pg18_smoke_persistence TO pg18_smoke_publisher;' >/dev/null
expect_setup_publisher_blocker 'publisher column ACL' \
  'publisher credential has 1 direct column ACL(s); publication access must use exact table SELECT grants'
expect_audit_blocker 'publisher column ACL' \
  'publisher role pg18_smoke_publisher has 1 direct column ACL(s); publication access must use exact table SELECT grants'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE SELECT (marker) ON TABLE public.pg18_smoke_persistence FROM pg18_smoke_publisher;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT TEMP ON DATABASE main TO pg18_smoke_publisher;' >/dev/null
expect_setup_publisher_blocker 'publisher direct database ACL' \
  'publisher credential has 1 direct database ACL(s); connection must rely only on the reviewed cluster baseline'
expect_audit_blocker 'publisher direct database ACL' \
  'publisher role pg18_smoke_publisher has 1 direct database ACL(s); connection must rely only on the reviewed cluster baseline'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE TEMP ON DATABASE main FROM pg18_smoke_publisher;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT EXECUTE ON FUNCTION public.pg18_smoke_int_equal(integer, integer) TO pg18_smoke_publisher;' >/dev/null
expect_setup_publisher_blocker 'publisher direct routine ACL' \
  'publisher credential has 1 direct routine ACL(s); publication access is table-only'
expect_audit_blocker 'publisher direct routine ACL' \
  'publisher role pg18_smoke_publisher has 1 direct routine ACL(s); publication access is table-only'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE EXECUTE ON FUNCTION public.pg18_smoke_int_equal(integer, integer) FROM pg18_smoke_publisher;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT EXECUTE ON FUNCTION public.pg18_smoke_int_equal(integer, integer) TO PUBLIC;' >/dev/null
expect_setup_publisher_blocker 'publisher PUBLIC routine execution' \
  'publisher credential can effectively EXECUTE 1 non-extension application routine(s); publication access is table-only'
expect_audit_blocker 'publisher PUBLIC routine execution' \
  'publisher role pg18_smoke_publisher can effectively EXECUTE 1 non-extension application routine(s); publication access is table-only'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE EXECUTE ON FUNCTION public.pg18_smoke_int_equal(integer, integer) FROM PUBLIC;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT USAGE ON TYPE public.pg18_smoke_composite TO pg18_smoke_publisher;' >/dev/null
expect_setup_publisher_blocker 'publisher direct type ACL' \
  'publisher credential has 1 direct type ACL(s); publication access is table-only'
expect_audit_blocker 'publisher direct type ACL' \
  'publisher role pg18_smoke_publisher has 1 direct type ACL(s); publication access is table-only'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE USAGE ON TYPE public.pg18_smoke_composite FROM pg18_smoke_publisher;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT CREATE ON DATABASE main TO PUBLIC;' >/dev/null
expect_setup_publisher_blocker 'PUBLIC database CREATE inherited by publisher'
expect_audit_blocker 'PUBLIC database CREATE inherited by publisher' \
  'publisher role pg18_smoke_publisher must be an ownership-free exact replication LOGIN'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE CREATE ON DATABASE main FROM PUBLIC;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT CREATE ON SCHEMA public TO PUBLIC;' >/dev/null
expect_setup_publisher_blocker 'PUBLIC schema CREATE inherited by publisher'
expect_audit_blocker 'PUBLIC schema CREATE inherited by publisher' \
  'publisher role pg18_smoke_publisher must be an ownership-free exact replication LOGIN'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;' >/dev/null

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT INSERT ON TABLE pg18_extension_mixed.user_table TO PUBLIC;' >/dev/null
expect_setup_publisher_blocker 'PUBLIC DML inherited by publisher'
expect_audit_blocker 'PUBLIC DML inherited by publisher' \
  'publisher role pg18_smoke_publisher must be an ownership-free exact replication LOGIN'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE INSERT ON TABLE pg18_extension_mixed.user_table FROM PUBLIC;' >/dev/null

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE TABLE neon_control_plane.pg18_publisher_owned_rogue (id integer);
ALTER TABLE neon_control_plane.pg18_publisher_owned_rogue OWNER TO pg18_smoke_publisher;
SQL
expect_setup_publisher_blocker 'publisher object ownership'
expect_audit_blocker 'publisher object ownership' \
  'publisher role pg18_smoke_publisher must be an ownership-free exact replication LOGIN'
docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'DROP TABLE neon_control_plane.pg18_publisher_owned_rogue;' >/dev/null

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE ROLE pg18_publisher_incoming_rogue NOLOGIN;
GRANT pg18_smoke_publisher TO pg18_publisher_incoming_rogue
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
SQL
expect_setup_publisher_blocker 'publisher incoming membership'
expect_audit_blocker 'publisher incoming membership' \
  'publisher role pg18_smoke_publisher must be an ownership-free exact replication LOGIN'
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
REVOKE pg18_smoke_publisher FROM pg18_publisher_incoming_rogue;
DROP ROLE pg18_publisher_incoming_rogue;
SQL

# Prove the exact publication audit rejects a column-list projection even when
# the relation-name manifest and subscription readiness still look complete.
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER PUBLICATION pg18_smoke_publication SET TABLE
  public.pg18_smoke_persistence (id),
  public.pg18_smoke_never_called,
  public.pg18_smoke_partitioned,
  public.pg18_smoke_partitioned_low,
  public.pg18_smoke_inheritance_parent,
  public.pg18_smoke_inheritance_child,
  public.pg18_smoke_gyms,
  public.pg18_smoke_user_boards,
  public.__drizzle_migrations,
  drizzle.__drizzle_migrations,
  pg18_extension_mixed.user_table;
SQL
if run_two_host_audit >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected the audit to reject a publication column list\n' >&2
  exit 1
fi
assert_report_contains 'publication table(s) use a row filter or omit columns'

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER PUBLICATION pg18_smoke_publication SET TABLE
  public.pg18_smoke_persistence,
  public.pg18_smoke_never_called,
  public.pg18_smoke_partitioned,
  public.pg18_smoke_partitioned_low,
  public.pg18_smoke_inheritance_parent,
  public.pg18_smoke_inheritance_child,
  public.pg18_smoke_gyms,
  public.pg18_smoke_user_boards,
  public.__drizzle_migrations,
  drizzle.__drizzle_migrations,
  pg18_extension_mixed.user_table;
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
assert_report_contains 'catalog DDL manifest differs'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'DROP INDEX public.pg18_smoke_unexpected_idx;' >/dev/null

assert_audit_clean

# The destructive teardown path must remain inert until an operator explicitly
# confirms the post-cutover acceptance and restore-drill gate.
if docker run --rm \
  --network "$NETWORK_NAME" \
  --volume "$REPOSITORY_ROOT:/workspace:ro" \
  --entrypoint bash \
  --env NEON_DATABASE_URL="$source_admin_url" \
  --env RAILWAY_DATABASE_URL="$target_admin_url" \
  "$IMAGE_TAG" /workspace/scripts/postgres-logical-replication.sh teardown \
  >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected teardown without TEARDOWN_CONFIRMED=true to be rejected\n' >&2
  exit 1
fi
assert_report_contains 'teardown requires TEARDOWN_CONFIRMED=true'

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
assert_report_contains 'Table data verification failed'
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "UPDATE public.pg18_smoke_partitioned SET marker = 'partition-survives-copy' WHERE id = 1;" >/dev/null

run_data_verification

run_confirmed_teardown() {
  docker run --rm \
    --network "$NETWORK_NAME" \
    --volume "$REPOSITORY_ROOT:/workspace:ro" \
    --entrypoint bash \
    --env NEON_DATABASE_URL="$source_admin_url" \
    --env RAILWAY_DATABASE_URL="$target_admin_url" \
    --env NEON_REPLICATION_DATABASE_URL="$source_publisher_url" \
    --env TARGET_OWNER_ROLE=pg18_smoke_owner \
    --env TARGET_SUBSCRIBER_ROLE=pg18_smoke_subscriber \
    --env SOURCE_DATABASE_NAME=main \
    --env TARGET_DATABASE_NAME=main \
    --env PUBLICATION_NAME=pg18_smoke_publication \
    --env SUBSCRIPTION_NAME=pg18_smoke_subscription \
    --env SLOT_NAME=pg18_smoke_subscription \
    --env 'INCLUDE_SCHEMAS=public drizzle pg18_extension_mixed pg18_empty_app' \
    --env TEARDOWN_CONFIRMED=true \
    "$IMAGE_TAG" /workspace/scripts/postgres-logical-replication.sh teardown
}

# Teardown also removes the temporary subscriber credential, because the
# reserved migrator's exact incoming-edge contract stays red while that role
# keeps its owner edge. Run the first teardown with the role deliberately outside
# its contract: the replication objects must still go, but a role the helper can
# no longer prove is the disposable subscriber must survive untouched.
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'GRANT CREATE ON SCHEMA public TO pg18_smoke_subscriber;' >/dev/null
if run_confirmed_teardown >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected teardown to refuse a contract-violating subscriber role\n' >&2
  exit 1
fi
assert_report_contains 'teardown refuses to drop any other role'
assert_report_contains 'TARGET_SUBSCRIBER_ROLE must be a passwordless ownership-free exact LOGIN'
assert_subscriber_role_count() {
  local expected="$1" actual
  actual="$(docker exec "$TARGET_CONTAINER_NAME" psql -X -Atq -U postgres -d main \
    -c "SELECT count(*) FROM pg_roles WHERE rolname = 'pg18_smoke_subscriber';")"
  [[ "$actual" == "$expected" ]] || {
    printf 'Expected %s subscriber role(s), found %s\n' "$expected" "$actual" >&2
    exit 1
  }
}
assert_subscriber_role_count 1
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'REVOKE CREATE ON SCHEMA public FROM pg18_smoke_subscriber;' >/dev/null

# Ownership is the other half of the same guard: a role that owns anything is not
# the disposable subscriber, and dropping it would take real objects with it.
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE SCHEMA pg18_subscriber_teardown_rogue;
CREATE TABLE pg18_subscriber_teardown_rogue.owned_table (id integer);
ALTER TABLE pg18_subscriber_teardown_rogue.owned_table OWNER TO pg18_smoke_subscriber;
SQL
if run_confirmed_teardown >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected teardown to refuse a subscriber role that owns an object\n' >&2
  exit 1
fi
assert_report_contains 'TARGET_SUBSCRIBER_ROLE must be a passwordless ownership-free exact LOGIN'
assert_subscriber_role_count 1
docker exec "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c 'DROP SCHEMA pg18_subscriber_teardown_rogue CASCADE;' >/dev/null

# Contract restored: the same command now finishes the job. The replication
# objects are already gone, so this doubles as the re-run-after-partial-teardown
# path for everything except the role.
if ! run_confirmed_teardown >"$AUDIT_REPORT_FILE" 2>&1; then
  cat "$AUDIT_REPORT_FILE" >&2
  printf 'Expected teardown to drop the contract-matching subscriber role\n' >&2
  exit 1
fi
assert_report_contains "Temporary subscriber role 'pg18_smoke_subscriber' removed"
assert_subscriber_role_count 0
subscriber_residue="$(docker exec "$TARGET_CONTAINER_NAME" psql -X -Atq -U postgres -d main -c "
SELECT count(*) FROM pg_shdepend AS dependency
WHERE dependency.refclassid = 'pg_authid'::regclass
  AND NOT EXISTS (
    SELECT 1 FROM pg_authid AS role_row WHERE role_row.oid = dependency.refobjid
  );")"
[[ "$subscriber_residue" == '0' ]] || {
  printf 'Dropped subscriber role left %s dangling shared dependency row(s)\n' "$subscriber_residue" >&2
  exit 1
}

# Same-name objects are not proof of ownership. A disabled subscription with
# different owner/options plus a partial publication and live-looking slot must
# all survive the helper's pre-mutation contract check.
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
CREATE PUBLICATION pg18_smoke_publication
  FOR TABLE public.pg18_smoke_persistence
  WITH (publish = 'insert');
SELECT * FROM pg_create_logical_replication_slot('pg18_smoke_subscription', 'pgoutput');
SQL
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<SQL
SET standard_conforming_strings = on;
CREATE SUBSCRIPTION pg18_smoke_subscription
  CONNECTION 'host=''${CONTAINER_NAME}'' port=''5432'' dbname=''main'' user=''pg18_smoke_publisher'' password=''publisher'''
  PUBLICATION pg18_smoke_publication
  WITH (connect = false, create_slot = false, slot_name = 'pg18_smoke_subscription', enabled = false);
SQL
if run_confirmed_teardown >"$AUDIT_REPORT_FILE" 2>&1; then
  printf 'Expected teardown to reject unrelated same-name replication objects\n' >&2
  exit 1
fi
if ! grep -Fq 'does not match the exact owner/options/publication/slot/canonical connection contract' \
  "$AUDIT_REPORT_FILE"; then
  cat "$AUDIT_REPORT_FILE" >&2
  printf 'Teardown did not report the expected exact subscription-contract blocker\n' >&2
  exit 1
fi
same_name_objects="$(docker exec "$TARGET_CONTAINER_NAME" psql -X -Atq -U postgres -d main -c \
  "SELECT count(*) FROM pg_subscription WHERE subname = 'pg18_smoke_subscription';")|$(
  docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main -c \
    "SELECT count(*) FROM pg_publication WHERE pubname = 'pg18_smoke_publication';"
)|$(docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main -c \
  "SELECT count(*) FROM pg_replication_slots WHERE slot_name = 'pg18_smoke_subscription';")"
[[ "$same_name_objects" == '1|1|1' ]]
docker exec -i "$TARGET_CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER SUBSCRIPTION pg18_smoke_subscription SET (slot_name = NONE);
DROP SUBSCRIPTION pg18_smoke_subscription;
SQL
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
DROP PUBLICATION pg18_smoke_publication;
SELECT pg_drop_replication_slot('pg18_smoke_subscription');
SQL

docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -c "SELECT * FROM pg_create_logical_replication_slot('pg18_smoke_subscription', 'pgoutput');" >/dev/null
# The subscriber role is already gone, so this run also proves the cleanup is
# idempotent: it must skip with a clear message instead of failing.
if ! run_confirmed_teardown >"$AUDIT_REPORT_FILE" 2>&1; then
  cat "$AUDIT_REPORT_FILE" >&2
  printf 'Expected the orphan-slot teardown re-run to succeed\n' >&2
  exit 1
fi
assert_report_contains "Temporary subscriber role 'pg18_smoke_subscriber' does not exist"
orphan_slot_count="$(docker exec "$CONTAINER_NAME" psql -X -Atq -U postgres -d main \
  -c "SELECT count(*) FROM pg_replication_slots WHERE slot_name = 'pg18_smoke_subscription';")"
[[ "$orphan_slot_count" == '0' ]]

# The ordinary (non-migration) audit contract permits no latent subscriber
# edge or subscription. The guarded teardown above already removed the
# short-lived cutover credential; restore the source writer roles after the
# fenced sequence copy and prove the exact post-teardown role graph is clean.
docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main <<'SQL'
ALTER ROLE pg18_smoke_runtime LOGIN;
ALTER ROLE pg18_smoke_migrator LOGIN;
SQL
assert_subscriber_role_count 0
MIGRATION_OWNER_TEST_DATABASE_URL="postgresql://pg18_smoke_migrator:migration-owner-contract@127.0.0.1:${target_host_port}/main" \
MIGRATION_OWNER_TEST_LOGIN_ROLE=pg18_smoke_migrator \
MIGRATION_OWNER_TEST_OWNER_ROLE=pg18_smoke_owner \
MIGRATION_OWNER_TEST_FENCE_OWNER_ROLE=pg18_smoke_fence_owner \
MIGRATION_OWNER_TEST_DATABASE_NAME=main \
MIGRATION_OWNER_TEST_EXPECT_SUBSCRIBER_ABSENT=true \
  node --import tsx --test \
    "$REPOSITORY_ROOT/packages/db/scripts/migration-owner-role.integration.test.ts"
if ! run_two_host_audit_without_publication >"$AUDIT_REPORT_FILE" 2>&1; then
  cat "$AUDIT_REPORT_FILE" >&2
  printf 'Expected the default post-teardown audit and role graph to be clean\n' >&2
  exit 1
fi
assert_report_contains 'Audit result: 0 blocker(s).'

printf 'PostgreSQL 18.6 image, audit, and two-host logical-migration smoke test passed.\n'
