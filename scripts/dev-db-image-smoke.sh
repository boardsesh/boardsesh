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
  board_type_name text;
  catalog_table text;
  catalog_count bigint;
  climb_count bigint;
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
  -- Catalogue coverage. The image is seeded from the published board snapshots
  -- (docs/board-snapshots.md), so "board_climbs is not empty" no longer says
  -- much: a load that stopped after the first layout would still pass it. Assert
  -- the shape a developer actually needs instead.
  SELECT count(*) INTO climb_count FROM board_climbs;
  IF climb_count < 800000 THEN
    RAISE EXCEPTION 'seeded board_climbs has only % rows; expected at least 800000', climb_count;
  END IF;

  FOREACH board_type_name IN ARRAY ARRAY[
    'kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper', 'soill', 'woods'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM board_climbs WHERE board_type = board_type_name) THEN
      RAISE EXCEPTION 'seeded board_climbs has no % climbs', board_type_name;
    END IF;
  END LOOP;

  -- Hardware geometry, which only the Aurora boards keep in Postgres (MoonBoard
  -- and Woods geometry lives in @boardsesh/board-constants). Without these no
  -- board renders and no grade resolves.
  FOREACH board_type_name IN ARRAY ARRAY[
    'kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill'
  ] LOOP
    FOREACH catalog_table IN ARRAY ARRAY[
      'board_products', 'board_layouts', 'board_product_sizes', 'board_sets',
      'board_placement_roles', 'board_holes', 'board_placements', 'board_leds',
      'board_product_sizes_layouts_sets', 'board_difficulty_grades'
    ] LOOP
      EXECUTE format('SELECT count(*) FROM %I WHERE board_type = $1', catalog_table)
        INTO catalog_count USING board_type_name;
      IF catalog_count = 0 THEN
        RAISE EXCEPTION 'seeded % has no % rows', catalog_table, board_type_name;
      END IF;
    END LOOP;
  END LOOP;

  -- Derived and secondary tables the load is responsible for.
  IF NOT EXISTS (SELECT 1 FROM board_climb_holds) THEN
    RAISE EXCEPTION 'seeded board_climb_holds data is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM board_climb_stats) THEN
    RAISE EXCEPTION 'seeded board_climb_stats data is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM board_climb_grades) THEN
    RAISE EXCEPTION 'seeded board_climb_grades data is missing';
  END IF;

  -- recomputeClimbStatsBulk derives ascensionist_count as upstream + boardsesh,
  -- so a NULL upstream term would turn every seeded tick into a NULL count.
  IF EXISTS (SELECT 1 FROM board_climb_stats WHERE upstream_ascensionist_count IS NULL) THEN
    RAISE EXCEPTION 'seeded board_climb_stats has NULL upstream_ascensionist_count rows';
  END IF;

  -- The legacy Aurora tables exist only as empty stubs during the build, so the
  -- journal can apply to a bare cluster; 0038 must have dropped every one.
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public'
      AND (tablename LIKE 'kilter\_%' OR tablename LIKE 'tension\_%')
  ) THEN
    RAISE EXCEPTION 'legacy kilter_*/tension_* tables survived into the image';
  END IF;

  -- #4699. pg_restore opens every restore with
  -- set_config('search_path', '', false), so a trigger function that names a
  -- type, table or sequence without a schema cannot resolve it while the
  -- trigger fires during COPY. update_vote_counts fails even earlier, at
  -- plpgsql compilation of its DECLARE, so its skip guard cannot rescue it.
  -- Either one aborts a --data-only restore with zero rows loaded.
  --
  -- This is the catalog half of the guard, and the only one that can see a
  -- hand-mutation on a real database. The textual half lives in
  -- scripts/__tests__/db-trigger-search-path.test.ts, which runs in the
  -- db-migrations job whose stock postgres:17 service has no PostGIS and never
  -- executes the migration SQL. This image has applied every migration to
  -- PG18.4 + PostGIS 3.6.4, so it can ask pg_proc directly.
  --
  -- PostGIS installs its own RETURNS trigger function, postgis_cache_bbox(),
  -- into public. It is extension-owned, will never carry a search_path, and is
  -- not ours to ALTER — exclude it the way
  -- scripts/postgres18-production-role-transition.sh already does, by
  -- pg_depend.deptype = 'e', rather than by name.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(coalesce(procedure.proconfig, '{}'::text[])) AS configured(setting)
        WHERE pg_catalog.regexp_replace(configured.setting, '[[:space:]]+', '', 'g') =
          'search_path=public,pg_catalog'
      )
  ) THEN
    RAISE EXCEPTION 'trigger function(s) in public do not pin search_path to public, pg_catalog: % (#4699)',
      (SELECT string_agg(procedure.proname, ', ' ORDER BY procedure.proname)
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_depend AS dependency
           WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
             AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.unnest(coalesce(procedure.proconfig, '{}'::text[])) AS configured(setting)
           WHERE pg_catalog.regexp_replace(configured.setting, '[[:space:]]+', '', 'g') =
             'search_path=public,pg_catalog'
         ));
  END IF;
  -- Fail closed: an empty inventory would satisfy the assertion above without
  -- proving anything, and would mean the predicate or the migrations broke.
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
      )
  ) < 14 THEN
    RAISE EXCEPTION 'expected at least 14 non-extension trigger functions in public, got %',
      (SELECT count(*)
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_depend AS dependency
           WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
             AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
         ));
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
