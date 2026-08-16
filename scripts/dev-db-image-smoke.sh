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
  fence_membership_count integer;
  fence_owner pg_roles%ROWTYPE;
  fence_owner_oid oid;
  migration_count bigint;
  owner_oid oid;
  owner_membership_count integer;
  stats_role_oid oid;
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

  SELECT * INTO STRICT fence_owner
  FROM pg_roles WHERE rolname = 'boardsesh_snapshot_fence_owner';
  SELECT oid INTO STRICT owner_oid
  FROM pg_roles WHERE rolname = 'boardsesh_owner';
  SELECT oid INTO STRICT stats_role_oid
  FROM pg_roles WHERE rolname = 'pg_read_all_stats';
  fence_owner_oid := fence_owner.oid;

  IF fence_owner.rolcanlogin OR fence_owner.rolsuper OR fence_owner.rolcreatedb
      OR fence_owner.rolcreaterole OR NOT fence_owner.rolinherit
      OR fence_owner.rolreplication OR fence_owner.rolbypassrls THEN
    RAISE EXCEPTION 'seeded snapshot fence owner has unsafe role attributes';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_database AS database
    CROSS JOIN LATERAL aclexplode(database.datacl) AS privilege
    WHERE database.datname = current_database()
      AND privilege.grantee = owner_oid
      AND privilege.privilege_type = 'CREATE'
      AND NOT privilege.is_grantable
  ) THEN
    RAISE EXCEPTION 'seeded application owner lacks direct database CREATE';
  END IF;

  SELECT count(*) INTO fence_membership_count
  FROM pg_auth_members AS membership
  WHERE membership.member = fence_owner_oid
    AND membership.roleid = stats_role_oid
    AND NOT membership.admin_option
    AND membership.inherit_option
    AND NOT membership.set_option;
  IF fence_membership_count <> 1 THEN
    RAISE EXCEPTION 'seeded snapshot fence owner lacks exact direct stats membership';
  END IF;

  SELECT count(*) INTO owner_membership_count
  FROM pg_auth_members AS membership
  WHERE membership.member = owner_oid
    AND membership.roleid = fence_owner_oid
    AND NOT membership.admin_option
    AND NOT membership.inherit_option
    AND membership.set_option;
  IF owner_membership_count <> 1 THEN
    RAISE EXCEPTION 'seeded application owner lacks exact direct SET-only fence membership';
  END IF;
  IF (
    SELECT count(*) FROM pg_auth_members AS membership
    WHERE membership.member = fence_owner_oid OR membership.roleid = fence_owner_oid
  ) <> 2 THEN
    RAISE EXCEPTION 'seeded snapshot fence owner has an unexpected direct membership';
  END IF;

  IF EXISTS (
    WITH expected(function_oid) AS (
      VALUES
        ('pg_catalog.pg_control_system()'::regprocedure),
        ('pg_catalog.pg_control_checkpoint()'::regprocedure)
    )
    SELECT 1
    FROM expected
    JOIN pg_proc AS procedure ON procedure.oid = expected.function_oid
    WHERE (
      SELECT count(*) FROM aclexplode(procedure.proacl) AS privilege
      WHERE privilege.grantee = fence_owner_oid
        AND privilege.privilege_type = 'EXECUTE'
    ) <> 1
       OR (
         SELECT count(*) FROM aclexplode(procedure.proacl) AS privilege
         WHERE privilege.grantee = fence_owner_oid
           AND privilege.privilege_type = 'EXECUTE'
           AND NOT privilege.is_grantable
       ) <> 1
       OR EXISTS (
         SELECT 1 FROM aclexplode(
           coalesce(procedure.proacl, acldefault('f', procedure.proowner))
         ) AS privilege
         WHERE privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
       )
  ) THEN
    RAISE EXCEPTION 'seeded snapshot fence owner lacks exact direct control-function ACLs';
  END IF;
  IF EXISTS (
    WITH allowed(function_oid) AS (
      VALUES
        ('pg_catalog.pg_control_system()'::regprocedure),
        ('pg_catalog.pg_control_checkpoint()'::regprocedure),
        (to_regprocedure('ops.board_snapshot_cluster_identity()')),
        (to_regprocedure('ops.acquire_board_snapshot_fence(integer)'))
    ),
    per_function AS (
      SELECT allowed.function_oid,
             count(*) FILTER (
               WHERE privilege.grantee = fence_owner_oid
                 AND privilege.privilege_type = 'EXECUTE'
             ) AS direct_execute_count,
             count(*) FILTER (
               WHERE privilege.grantee = fence_owner_oid
                 AND privilege.privilege_type = 'EXECUTE'
                 AND NOT privilege.is_grantable
             ) AS non_grantable_execute_count,
             count(*) FILTER (
               WHERE privilege.grantee = 0
                 AND privilege.privilege_type = 'EXECUTE'
             ) AS public_execute_count
      FROM allowed
      JOIN pg_proc AS procedure ON procedure.oid = allowed.function_oid
      LEFT JOIN LATERAL aclexplode(
        coalesce(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS privilege ON true
      GROUP BY allowed.function_oid
    )
    SELECT 1 FROM per_function
    WHERE direct_execute_count <> 1 OR non_grantable_execute_count <> 1
       OR public_execute_count <> 0

    UNION ALL

    SELECT 1
    FROM pg_proc AS procedure
    CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
    WHERE privilege.grantee = fence_owner_oid
      AND privilege.privilege_type = 'EXECUTE'
      AND NOT EXISTS (
        SELECT 1 FROM allowed WHERE allowed.function_oid = procedure.oid
      )
  ) THEN
    RAISE EXCEPTION 'seeded snapshot fence owner direct function ACL boundary differs';
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
