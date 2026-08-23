#!/usr/bin/env bash

# Runs migration 0205 exactly as the restricted production migrator will run
# it. Every schema object is created in a unique scratch database. The four
# canonical roles are still cluster-wide, so the script refuses non-loopback
# servers, requires an explicit destructive-test opt-in, and refuses a cluster
# where any contract role already exists.

set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP_SQL="$REPOSITORY_ROOT/packages/db/docker/bootstrap-pg18-development-roles.sql"
MIGRATION_SQL="$REPOSITORY_ROOT/packages/db/drizzle/0205_board_snapshot_replica_fence.sql"
DATABASE_URL="${SNAPSHOT_MIGRATION_PG18_DB_URL:?set SNAPSHOT_MIGRATION_PG18_DB_URL to a loopback PostgreSQL 18 admin database}"
if [[ "${SNAPSHOT_MIGRATION_PG18_ALLOW_LOCAL_ADMIN:-}" != '1' ]]; then
  printf 'set SNAPSHOT_MIGRATION_PG18_ALLOW_LOCAL_ADMIN=1 to acknowledge local cluster role creation\n' >&2
  exit 1
fi

connection_fields=()
while IFS= read -r connection_field; do
  connection_fields+=("$connection_field")
done < <(
  SNAPSHOT_MIGRATION_PG18_DB_URL="$DATABASE_URL" node -e '
    const databaseUrl = new URL(process.env.SNAPSHOT_MIGRATION_PG18_DB_URL);
    if (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") {
      throw new Error("snapshot migration smoke requires a PostgreSQL URL");
    }
    const fields = [
      databaseUrl.hostname.replace(/^\[(.*)\]$/, "$1"),
      databaseUrl.port || "5432",
      decodeURIComponent(databaseUrl.username),
      decodeURIComponent(databaseUrl.password),
      decodeURIComponent(databaseUrl.pathname.slice(1)),
      databaseUrl.searchParams.get("sslmode") || "disable",
    ];
    if (fields.some((field) => /[\t\r\n]/.test(field))) {
      throw new Error("PostgreSQL URL fields may not contain tabs or newlines");
    }
    fields.forEach((field) => console.log(field));
  '
)
if ((${#connection_fields[@]} != 6)); then
  printf 'could not parse SNAPSHOT_MIGRATION_PG18_DB_URL\n' >&2
  exit 1
fi

export PGHOST="${connection_fields[0]}"
export PGPORT="${connection_fields[1]}"
export PGUSER="${connection_fields[2]}"
export PGPASSWORD="${connection_fields[3]}"
ADMIN_DATABASE="${connection_fields[4]}"
export PGSSLMODE="${connection_fields[5]}"
unset DATABASE_URL SNAPSHOT_MIGRATION_PG18_DB_URL connection_field connection_fields

case "$PGHOST" in
  localhost | 127.0.0.1 | ::1) ;;
  *)
    printf 'snapshot migration smoke refuses non-loopback host %s\n' "$PGHOST" >&2
    exit 1
    ;;
esac
if [[ "$ADMIN_DATABASE" != 'postgres' ]]; then
  printf 'snapshot migration smoke admin URL must select the postgres maintenance database\n' >&2
  exit 1
fi

psql_admin() {
  PGDATABASE="$ADMIN_DATABASE" psql -X -v ON_ERROR_STOP=1 "$@"
}

SMOKE_DATABASE="boardsesh_snapshot_0205_${$}_${RANDOM}"
# Second scratch database for the development/CI apply path. It has to be a
# separate database because both scenarios apply 0205, and it has to be dropped
# before the production scenario runs because pg_shdepend is cluster-wide: the
# bootstrap's fence-owner ownership allowlist resolves ops function OIDs in the
# current database and would read another database's rows as foreign objects.
DEVELOPMENT_DATABASE="${SMOKE_DATABASE}_devdb"

admin_contract="$(psql_admin -Atq <<'SQL'
SELECT (role.rolsuper AND current_database() = 'postgres')::text
FROM pg_roles AS role
WHERE role.rolname = current_user;
SQL
)"
if [[ "$admin_contract" != 'true' ]]; then
  printf 'snapshot migration smoke requires a loopback PostgreSQL superuser on the postgres database\n' >&2
  exit 1
fi

server_version_num="$(psql_admin -Atq -c "SELECT current_setting('server_version_num')::integer")"
if ((server_version_num < 180000)); then
  printf 'snapshot migration smoke requires PostgreSQL 18+, found %s\n' "$server_version_num" >&2
  exit 1
fi

existing_contract_roles="$(psql_admin -Atq -c \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('boardsesh_owner', 'boardsesh_snapshot_fence_owner', 'boardsesh_migrator', 'boardsesh_snapshot_coordinator', 'snapshot_smoke_indirect')")"
if [[ "$existing_contract_roles" != '0' ]]; then
  printf 'snapshot migration smoke refuses a cluster with existing Boardsesh contract roles\n' >&2
  exit 1
fi

psql_admin -v smoke_database="$SMOKE_DATABASE" >/dev/null <<'SQL'
CREATE DATABASE :"smoke_database" TEMPLATE template0;
SQL

psql_smoke() {
  PGDATABASE="$SMOKE_DATABASE" psql -X -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  local smoke_status=$?
  trap - EXIT
  set +e
  psql_admin -v smoke_database="$SMOKE_DATABASE" >/dev/null 2>&1 <<'SQL'
DROP DATABASE IF EXISTS :"smoke_database" WITH (FORCE);
SQL
  psql_admin -v development_database="$DEVELOPMENT_DATABASE" >/dev/null 2>&1 <<'SQL'
DROP DATABASE IF EXISTS :"development_database" WITH (FORCE);
SQL
  psql_admin >/dev/null 2>&1 <<'SQL'
DO $cleanup$
DECLARE
  cleanup_role text;
BEGIN
  FOREACH cleanup_role IN ARRAY ARRAY[
    'boardsesh_snapshot_coordinator',
    'boardsesh_migrator',
    'boardsesh_owner',
    'boardsesh_snapshot_fence_owner',
    'snapshot_smoke_indirect'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = cleanup_role) THEN
      EXECUTE format('DROP OWNED BY %I CASCADE', cleanup_role);
    END IF;
  END LOOP;
  FOREACH cleanup_role IN ARRAY ARRAY[
    'boardsesh_snapshot_coordinator',
    'boardsesh_migrator',
    'boardsesh_owner',
    'boardsesh_snapshot_fence_owner',
    'snapshot_smoke_indirect'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = cleanup_role) THEN
      EXECUTE format('DROP ROLE %I', cleanup_role);
    END IF;
  END LOOP;
END;
$cleanup$;
SQL
  exit "$smoke_status"
}
trap cleanup EXIT

run_bootstrap() {
  psql_smoke -v boardsesh_dev_role_bootstrap=true -f "$BOOTSTRAP_SQL" >/dev/null
}

run_exact_preflight_expect_failure() {
  local expected_message="$1"
  local output
  local status

  set +e
  output="$({
    printf '%s\n' 'SET SESSION AUTHORIZATION boardsesh_migrator;' 'BEGIN;'
    awk '/--> statement-breakpoint/ { statement_count += 1 } { print } statement_count == 4 { exit }' "$MIGRATION_SQL"
    printf '%s\n' 'COMMIT;'
  } | psql_smoke 2>&1)"
  status=$?
  set -e
  if ((status == 0)); then
    printf 'expected migration 0205 preflight to reject drift: %s\n' "$expected_message" >&2
    exit 1
  fi
  grep -Fq "$expected_message" <<<"$output"
}

# ---------------------------------------------------------------------------
# Scenario 1: the development and CI apply path.
#
# Nothing in dev or CI performs the production cutover, so packages/db/docker/
# Dockerfile.dev-db and scripts/dev-db-up.sh apply the whole journal as the
# bootstrap superuser and every pre-0205 object stays owned by that superuser.
# The fixture below reproduces that state exactly and must never pre-own
# anything for boardsesh_owner — pre-owning it is what hid the SET ROLE failure.
# The full journal cannot be replayed here: migration 0000 alters the Aurora
# tables pgloader imports into the image before any migration runs. The image
# build is the all-migrations gate; this covers the ownership state 0205 meets
# there, applied through the exact psql invocation apply-drizzle-migrations.sh
# makes.
# ---------------------------------------------------------------------------
psql_admin -v development_database="$DEVELOPMENT_DATABASE" >/dev/null <<'SQL'
CREATE DATABASE :"development_database" TEMPLATE template0;
SQL

psql_development() {
  PGDATABASE="$DEVELOPMENT_DATABASE" psql -X -v ON_ERROR_STOP=1 "$@"
}

psql_development -v boardsesh_dev_role_bootstrap=true -f "$BOOTSTRAP_SQL" >/dev/null

# Pre-0205 objects, created by the connected superuser. The two public trigger
# functions carry the definitions migrations 0144/0146 leave behind, and both
# drizzle ledger tables are the ones apply-drizzle-migrations.sh creates before
# it starts applying files.
#
# snapshot_smoke_bystander_* stand in for the ~200 other public tables and the
# non-public schemas the dev image carries by the time 0205 runs. They exist so
# this scenario can tell a preamble that re-owns exactly what 0205 replaces from
# one that sweeps a whole schema or the whole database: an
# `ALTER TABLE ALL IN SCHEMA public OWNER TO boardsesh_owner` would move them
# too, and the post-apply contract below fails when it does.
psql_development >/dev/null <<'SQL'
CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
CREATE SCHEMA drizzle;
CREATE TABLE drizzle."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);

CREATE SEQUENCE public.board_climbs_sync_seq_seq;
CREATE SEQUENCE public.board_climb_stats_sync_seq_seq;
CREATE SEQUENCE public.board_climb_grades_sync_seq_seq;
CREATE TABLE public.board_climbs (updated_at timestamp, sync_seq bigint);
CREATE TABLE public.board_climb_stats (updated_at timestamp, sync_seq bigint);
CREATE TABLE public.board_climb_grades (computed_at timestamp, sync_seq bigint);
CREATE TABLE public.sync_deletions (deleted_at timestamp);

CREATE TABLE public.snapshot_smoke_bystander_table (id integer);
CREATE SCHEMA snapshot_smoke_bystander_schema;
CREATE TABLE snapshot_smoke_bystander_schema.bystander_table (id integer);
CREATE FUNCTION public.snapshot_smoke_bystander_function() RETURNS integer
  LANGUAGE sql AS 'SELECT 1';

CREATE FUNCTION public.set_board_climbs_sync_fields() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.sync_seq = nextval('board_climbs_sync_seq_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE FUNCTION public.set_board_climb_stats_sync_fields() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.sync_seq = nextval('board_climb_stats_sync_seq_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname IN ('public', 'drizzle', 'snapshot_smoke_bystander_schema')
      AND nspowner = 'boardsesh_owner'::regrole
  ) OR EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid IN (
        'public.set_board_climbs_sync_fields()'::regprocedure,
        'public.set_board_climb_stats_sync_fields()'::regprocedure,
        'public.snapshot_smoke_bystander_function()'::regprocedure
      )
      AND proowner = 'boardsesh_owner'::regrole
  ) OR EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN (
        'public.board_climbs'::regclass,
        'drizzle."__drizzle_migrations"'::regclass,
        'public.snapshot_smoke_bystander_table'::regclass,
        'snapshot_smoke_bystander_schema.bystander_table'::regclass
      )
      AND relowner = 'boardsesh_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'development fixture must leave every pre-0205 object owned by the bootstrap superuser';
  END IF;
END;
$$;
SQL

# Byte-for-byte the invocation packages/db/docker/apply-drizzle-migrations.sh
# makes: one transaction covering the migration file and both ledger writes.
psql_development --single-transaction \
  -f "$MIGRATION_SQL" \
  -c "INSERT INTO \"__drizzle_migrations\" (hash, created_at) VALUES ('0205', 1)" \
  -c "INSERT INTO drizzle.\"__drizzle_migrations\" (hash, created_at) VALUES ('0205', 1)" \
  >/dev/null

# dev-db-up re-runs the bootstrap on every start, including after 0205 landed.
psql_development -v boardsesh_dev_role_bootstrap=true -f "$BOOTSTRAP_SQL" >/dev/null

psql_development >/dev/null <<'SQL'
DO $contract$
DECLARE
  fence_owner_oid oid := 'boardsesh_snapshot_fence_owner'::regrole;
  bootstrap_superuser_oid oid := current_user::text::regrole;
BEGIN
  IF NOT COALESCE(
    (SELECT role.rolsuper FROM pg_roles AS role WHERE role.rolname = current_user),
    false
  ) THEN
    RAISE EXCEPTION 'SET LOCAL ROLE leaked past the migration transaction';
  END IF;
  IF (
    SELECT count(*) FROM pg_proc
    WHERE proowner = fence_owner_oid
      AND oid = ANY (ARRAY[
        'ops.board_snapshot_cluster_identity()'::regprocedure,
        'ops.acquire_board_snapshot_fence(integer)'::regprocedure
      ])
  ) <> 2 OR (
    SELECT count(*) FROM pg_proc WHERE proowner = fence_owner_oid
  ) <> 2 THEN
    RAISE EXCEPTION 'superuser apply did not leave exactly two fence-owner functions';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid IN (
        'public.set_board_climbs_sync_fields()'::regprocedure,
        'public.set_board_climb_stats_sync_fields()'::regprocedure
      )
      AND proowner <> 'boardsesh_owner'::regrole
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname IN ('public', 'drizzle', 'ops')
      AND nspowner <> 'boardsesh_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'superuser apply did not hand the replaced public objects to the fence model owner';
  END IF;
  -- The other half of the same contract: 0205 promises it re-owns exactly what
  -- it replaces, so everything else the dev image already holds must still
  -- belong to the bootstrap superuser.
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN (
        'public.snapshot_smoke_bystander_table'::regclass,
        'snapshot_smoke_bystander_schema.bystander_table'::regclass
      )
      AND relowner <> bootstrap_superuser_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname = 'snapshot_smoke_bystander_schema'
      AND nspowner <> bootstrap_superuser_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.snapshot_smoke_bystander_function()'::regprocedure
      AND proowner <> bootstrap_superuser_oid
  ) THEN
    RAISE EXCEPTION 'superuser apply re-owned objects outside the set migration 0205 replaces';
  END IF;
  IF (
    SELECT count(*) FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN (
        'trg_board_climbs_set_insert_sync_fields',
        'trg_board_climb_stats_set_insert_sync_fields',
        'trg_board_climb_grades_set_sync_fields',
        'trg_sync_deletions_set_cursor'
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'superuser apply did not install the four cursor triggers';
  END IF;
  IF (SELECT count(*) FROM "__drizzle_migrations") <> 1
     OR (SELECT count(*) FROM drizzle."__drizzle_migrations") <> 1 THEN
    RAISE EXCEPTION 'superuser apply did not record both drizzle ledger rows';
  END IF;
END;
$contract$;
SQL

psql_admin -v development_database="$DEVELOPMENT_DATABASE" >/dev/null <<'SQL'
DROP DATABASE :"development_database" WITH (FORCE);
SQL
printf 'Development superuser apply path for migration 0205 passed.\n'

# ---------------------------------------------------------------------------
# Scenario 2: the restricted production migrator, on a database whose public
# objects the cutover runbook has already handed to boardsesh_owner.
# ---------------------------------------------------------------------------
run_bootstrap
run_bootstrap

psql_smoke >/dev/null <<'SQL'
CREATE ROLE boardsesh_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  INHERIT NOREPLICATION NOBYPASSRLS;
GRANT boardsesh_owner TO boardsesh_migrator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

ALTER SCHEMA public OWNER TO boardsesh_owner;
SET ROLE boardsesh_owner;
CREATE SEQUENCE public.board_climbs_sync_seq_seq;
CREATE SEQUENCE public.board_climb_stats_sync_seq_seq;
CREATE SEQUENCE public.board_climb_grades_sync_seq_seq;
CREATE TABLE public.board_climbs (updated_at timestamp, sync_seq bigint);
CREATE TABLE public.board_climb_stats (updated_at timestamp, sync_seq bigint);
CREATE TABLE public.board_climb_grades (computed_at timestamp, sync_seq bigint);
CREATE TABLE public.sync_deletions (deleted_at timestamp);
RESET ROLE;

DO $$
BEGIN
  IF has_database_privilege('boardsesh_migrator', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'restricted migrator unexpectedly has direct database CREATE';
  END IF;
END;
$$;
SQL

psql_smoke -c 'ALTER ROLE boardsesh_snapshot_fence_owner CREATEDB' >/dev/null
run_exact_preflight_expect_failure 'NOCREATEDB'
run_bootstrap

psql_smoke -c 'ALTER ROLE boardsesh_snapshot_fence_owner CREATEROLE' >/dev/null
run_exact_preflight_expect_failure 'NOCREATEROLE'
run_bootstrap

psql_smoke >/dev/null <<'SQL'
CREATE ROLE snapshot_smoke_indirect NOLOGIN;
GRANT pg_read_all_stats TO snapshot_smoke_indirect
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
REVOKE pg_read_all_stats FROM boardsesh_snapshot_fence_owner;
GRANT snapshot_smoke_indirect TO boardsesh_snapshot_fence_owner
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
DO $$
BEGIN
  IF NOT pg_has_role('boardsesh_snapshot_fence_owner', 'pg_read_all_stats', 'USAGE') THEN
    RAISE EXCEPTION 'indirect stats fixture did not provide effective access';
  END IF;
END;
$$;
SQL
run_exact_preflight_expect_failure 'exact direct inherited pg_read_all_stats membership'
psql_smoke >/dev/null <<'SQL'
REVOKE snapshot_smoke_indirect FROM boardsesh_snapshot_fence_owner;
DROP ROLE snapshot_smoke_indirect;
SQL
run_bootstrap

psql_smoke -c \
  'GRANT pg_monitor TO boardsesh_snapshot_fence_owner WITH ADMIN FALSE, INHERIT TRUE, SET FALSE' >/dev/null
run_exact_preflight_expect_failure 'unexpected direct role membership'
psql_smoke -c 'REVOKE pg_monitor FROM boardsesh_snapshot_fence_owner' >/dev/null
run_bootstrap

psql_smoke >/dev/null <<'SQL'
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  pg_catalog.pg_control_checkpoint() TO pg_read_all_stats;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  pg_catalog.pg_control_checkpoint() FROM boardsesh_snapshot_fence_owner;
DO $$
BEGIN
  IF NOT has_function_privilege(
    'boardsesh_snapshot_fence_owner',
    'pg_catalog.pg_control_system()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'indirect control-function fixture did not provide effective access';
  END IF;
END;
$$;
SQL
run_exact_preflight_expect_failure 'exact direct non-grantable EXECUTE ACLs'
psql_smoke -c \
  'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system(), pg_catalog.pg_control_checkpoint() FROM pg_read_all_stats' \
  >/dev/null
run_bootstrap

psql_smoke -c \
  'GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO boardsesh_snapshot_fence_owner WITH GRANT OPTION' \
  >/dev/null
run_exact_preflight_expect_failure 'exact direct non-grantable EXECUTE ACLs'
run_bootstrap

psql_smoke -c \
  'GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_init() TO boardsesh_snapshot_fence_owner' >/dev/null
run_exact_preflight_expect_failure 'unexpected direct function EXECUTE ACL'
psql_smoke -c \
  'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_init() FROM boardsesh_snapshot_fence_owner' >/dev/null
run_bootstrap

psql_smoke >/dev/null <<'SQL'
CREATE FUNCTION public.snapshot_smoke_fence_owned() RETURNS integer LANGUAGE sql AS 'SELECT 1';
GRANT CREATE ON SCHEMA public TO boardsesh_snapshot_fence_owner;
ALTER FUNCTION public.snapshot_smoke_fence_owned() OWNER TO boardsesh_snapshot_fence_owner;
REVOKE CREATE ON SCHEMA public FROM boardsesh_snapshot_fence_owner;
SQL
run_exact_preflight_expect_failure 'must not own functions before migration 0205'
psql_smoke -c 'DROP FUNCTION public.snapshot_smoke_fence_owned()' >/dev/null
run_bootstrap

{
  printf '%s\n' 'SET SESSION AUTHORIZATION boardsesh_migrator;' 'BEGIN;'
  awk '{ print }' "$MIGRATION_SQL"
  printf '%s\n' 'COMMIT;' 'RESET SESSION AUTHORIZATION;'
} | psql_smoke >/dev/null

# dev-db-up invokes the bootstrap on every start, including after 0205 is in
# the ledger. Prove that post-migration repair preserves the two owned ops ACLs.
run_bootstrap

psql_smoke >/dev/null <<'SQL'
CREATE ROLE boardsesh_snapshot_coordinator LOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA ops TO boardsesh_snapshot_coordinator;
GRANT EXECUTE ON FUNCTION ops.acquire_board_snapshot_fence(integer),
  ops.board_snapshot_fence_held(),
  ops.release_board_snapshot_fence(),
  ops.board_snapshot_cluster_identity()
  TO boardsesh_snapshot_coordinator;

DO $contract$
DECLARE
  fence_owner_oid oid := 'boardsesh_snapshot_fence_owner'::regrole;
  coordinator_oid oid := 'boardsesh_snapshot_coordinator'::regrole;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE oid = fence_owner_oid
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR
           NOT rolinherit OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'fence owner attributes drifted after exact migration';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_proc
    WHERE oid = ANY (ARRAY[
      'ops.board_snapshot_cluster_identity()'::regprocedure,
      'ops.acquire_board_snapshot_fence(integer)'::regprocedure
    ])
      AND proowner = fence_owner_oid
  ) <> 2 OR (
    SELECT count(*) FROM pg_proc WHERE proowner = fence_owner_oid
  ) <> 2 THEN
    RAISE EXCEPTION 'exact migration did not leave exactly two fence-owner functions';
  END IF;
  IF (
    SELECT count(*) = 4
    FROM (
      VALUES
        ('pg_catalog.pg_control_system()'::regprocedure),
        ('pg_catalog.pg_control_checkpoint()'::regprocedure),
        ('ops.board_snapshot_cluster_identity()'::regprocedure),
        ('ops.acquire_board_snapshot_fence(integer)'::regprocedure)
    ) AS expected(function_oid)
    WHERE (
      SELECT count(*) = 1 AND bool_and(NOT privilege.is_grantable)
      FROM pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
      WHERE procedure.oid = expected.function_oid
        AND privilege.grantee = fence_owner_oid
        AND privilege.privilege_type = 'EXECUTE'
    ) IS true
  ) IS DISTINCT FROM true OR (
    SELECT count(*)
    FROM pg_proc AS procedure
    CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
    WHERE privilege.grantee = fence_owner_oid
      AND privilege.privilege_type = 'EXECUTE'
  ) <> 4 THEN
    RAISE EXCEPTION 'fence owner does not have its exact four direct function ACLs';
  END IF;
  IF (
    SELECT count(*) = 2 AND bool_and(NOT privilege.is_grantable)
    FROM pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
    WHERE namespace.nspname = 'ops'
      AND privilege.grantee = fence_owner_oid
      AND privilege.privilege_type IN ('USAGE', 'CREATE')
  ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'fence owner lacks exact direct ops schema ACLs';
  END IF;
  IF (
    SELECT count(*) = 1 AND bool_and(NOT privilege.is_grantable)
    FROM pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
    WHERE namespace.nspname = 'ops'
      AND privilege.grantee = coordinator_oid
      AND privilege.privilege_type = 'USAGE'
  ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'coordinator lacks exact direct schema USAGE';
  END IF;
  IF (
    SELECT count(*) = 4 AND bool_and(NOT privilege.is_grantable)
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
    WHERE namespace.nspname = 'ops'
      AND privilege.grantee = coordinator_oid
      AND privilege.privilege_type = 'EXECUTE'
  ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'coordinator lacks its exact four direct function ACLs';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members AS membership
    WHERE membership.member = coordinator_oid
       OR membership.roleid = coordinator_oid
  ) THEN
    RAISE EXCEPTION 'coordinator must have no direct role membership edges';
  END IF;
END;
$contract$;
SQL

printf 'PostgreSQL 18 exact migration 0205 smoke passed.\n'
