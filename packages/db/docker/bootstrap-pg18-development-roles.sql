\set ON_ERROR_STOP on

-- Development/test bootstrap only. Production roles are provisioned by the
-- PG18 cutover runbook before the restricted migrator is allowed to connect.
-- Requiring an explicit psql variable makes accidental invocation fail closed.
SELECT pg_catalog.set_config(
  'boardsesh.development_role_bootstrap',
  :'boardsesh_dev_role_bootstrap',
  false
);

BEGIN;

DO $bootstrap$
DECLARE
  current_role_is_superuser boolean;
BEGIN
  IF pg_catalog.current_setting('boardsesh.development_role_bootstrap', true) <> 'true' THEN
    RAISE EXCEPTION 'development role bootstrap requires boardsesh_dev_role_bootstrap=true';
  END IF;
  IF pg_catalog.current_setting('server_version_num')::integer < 180000 THEN
    RAISE EXCEPTION 'development role bootstrap requires PostgreSQL 18 or newer';
  END IF;

  SELECT role.rolsuper
  INTO current_role_is_superuser
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = current_user;
  IF NOT coalesce(current_role_is_superuser, false) THEN
    RAISE EXCEPTION 'development role bootstrap must run as a PostgreSQL superuser';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'boardsesh_owner'
  ) THEN
    EXECUTE 'CREATE ROLE boardsesh_owner';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'boardsesh_snapshot_fence_owner'
  ) THEN
    EXECUTE 'CREATE ROLE boardsesh_snapshot_fence_owner';
  END IF;
END;
$bootstrap$;

ALTER ROLE boardsesh_owner WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE boardsesh_snapshot_fence_owner WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;

SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM boardsesh_owner',
  pg_catalog.current_database()
) \gexec
SELECT pg_catalog.format(
  'GRANT CREATE ON DATABASE %I TO boardsesh_owner',
  pg_catalog.current_database()
) \gexec
SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM boardsesh_snapshot_fence_owner',
  pg_catalog.current_database()
) \gexec

-- Revoke and re-grant the two intended edges so repeat runs repair changed
-- membership options instead of accepting effective access through a chain.
REVOKE pg_read_all_stats FROM boardsesh_snapshot_fence_owner;
GRANT pg_read_all_stats TO boardsesh_snapshot_fence_owner
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
REVOKE boardsesh_snapshot_fence_owner FROM boardsesh_owner;
SELECT pg_catalog.format('REVOKE %I FROM boardsesh_owner', granted_role.rolname)
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = 'boardsesh_owner'
  AND granted_role.rolname <> 'boardsesh_snapshot_fence_owner'
ORDER BY granted_role.rolname
\gexec
GRANT boardsesh_snapshot_fence_owner TO boardsesh_owner
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  pg_catalog.pg_control_checkpoint()
  FROM PUBLIC, boardsesh_snapshot_fence_owner;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  pg_catalog.pg_control_checkpoint()
  TO boardsesh_snapshot_fence_owner;

DO $contract$
DECLARE
  owner_oid oid;
  fence_owner_oid oid;
  stats_role_oid oid;
BEGIN
  SELECT oid INTO STRICT owner_oid
  FROM pg_catalog.pg_roles WHERE rolname = 'boardsesh_owner';
  SELECT oid INTO STRICT fence_owner_oid
  FROM pg_catalog.pg_roles WHERE rolname = 'boardsesh_snapshot_fence_owner';
  SELECT oid INTO STRICT stats_role_oid
  FROM pg_catalog.pg_roles WHERE rolname = 'pg_read_all_stats';

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE oid IN (owner_oid, fence_owner_oid)
      AND (
        rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR
        NOT rolinherit OR rolreplication OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'development owner roles do not match the restricted role attributes';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member = fence_owner_oid
      AND membership.roleid = stats_role_oid
      AND NOT membership.admin_option
      AND membership.inherit_option
      AND NOT membership.set_option
  ) <> 1 THEN
    RAISE EXCEPTION 'snapshot fence owner needs one exact direct pg_read_all_stats membership';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member = owner_oid
      AND membership.roleid = fence_owner_oid
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) <> 1 THEN
    RAISE EXCEPTION 'application owner needs one exact direct SET-only fence-owner membership';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member = owner_oid
  ) <> 1 THEN
    RAISE EXCEPTION 'application owner has an unexpected direct role membership';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member = fence_owner_oid OR membership.roleid = fence_owner_oid
  ) <> 2 THEN
    RAISE EXCEPTION 'snapshot fence owner has an unexpected direct role membership';
  END IF;

  IF EXISTS (
    WITH expected(function_oid) AS (
      VALUES
        ('pg_catalog.pg_control_system()'::pg_catalog.regprocedure),
        ('pg_catalog.pg_control_checkpoint()'::pg_catalog.regprocedure)
    )
    SELECT 1
    FROM expected
    JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = expected.function_oid
    WHERE (
      SELECT count(*)
      FROM pg_catalog.aclexplode(procedure.proacl) AS privilege
      WHERE privilege.grantee = fence_owner_oid
        AND privilege.privilege_type = 'EXECUTE'
    ) <> 1
       OR (
         SELECT count(*)
         FROM pg_catalog.aclexplode(procedure.proacl) AS privilege
         WHERE privilege.grantee = fence_owner_oid
           AND privilege.privilege_type = 'EXECUTE'
           AND NOT privilege.is_grantable
       ) <> 1
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(
           coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
         ) AS privilege
         WHERE privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
       )
  ) THEN
    RAISE EXCEPTION 'snapshot fence owner needs exact direct non-grantable control-function ACLs';
  END IF;

  -- Before the board snapshot replica fence migration there are two direct
  -- ACLs. Afterwards revoking PUBLIC EXECUTE leaves one explicit owner ACL
  -- on each of the two ops functions, so repeat bootstrap runs accept
  -- exactly those four and no more.
  IF EXISTS (
    WITH allowed(function_oid) AS (
      VALUES
        ('pg_catalog.pg_control_system()'::pg_catalog.regprocedure),
        ('pg_catalog.pg_control_checkpoint()'::pg_catalog.regprocedure),
        (pg_catalog.to_regprocedure('ops.board_snapshot_cluster_identity()')),
        (pg_catalog.to_regprocedure('ops.acquire_board_snapshot_fence(integer)'))
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
      JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = allowed.function_oid
      LEFT JOIN LATERAL pg_catalog.aclexplode(
        coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      ) AS privilege ON true
      GROUP BY allowed.function_oid
    )
    SELECT 1 FROM per_function
    WHERE direct_execute_count <> 1 OR non_grantable_execute_count <> 1
       OR public_execute_count <> 0

    UNION ALL

    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
    WHERE privilege.grantee = fence_owner_oid
      AND privilege.privilege_type = 'EXECUTE'
      AND NOT EXISTS (
        SELECT 1 FROM allowed WHERE allowed.function_oid = procedure.oid
      )
  ) THEN
    RAISE EXCEPTION 'snapshot fence owner direct function EXECUTE ACL boundary differs';
  END IF;

  IF pg_catalog.has_database_privilege(
       fence_owner_oid, pg_catalog.current_database(), 'CREATE'
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_namespace AS namespace
       WHERE namespace.nspname <> 'ops'
         AND namespace.nspname <> 'information_schema'
         AND namespace.nspname !~ '^pg_'
         AND pg_catalog.has_schema_privilege(fence_owner_oid, namespace.oid, 'CREATE')
     ) THEN
    RAISE EXCEPTION 'snapshot fence owner has effective CREATE outside ops';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS database
    CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
    WHERE privilege.grantee = fence_owner_oid
  ) THEN
    RAISE EXCEPTION 'snapshot fence owner has an unexpected database ACL';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
    WHERE privilege.grantee = fence_owner_oid
      AND NOT (
        namespace.nspname = 'ops'
        AND privilege.privilege_type IN ('USAGE', 'CREATE')
        AND NOT privilege.is_grantable
      )
  ) OR NOT (
    SELECT count(*) = CASE
             WHEN pg_catalog.to_regnamespace('ops') IS NULL THEN 0 ELSE 2
           END
           AND coalesce(pg_catalog.bool_and(
             privilege.privilege_type IN ('USAGE', 'CREATE')
             AND NOT privilege.is_grantable
           ), true)
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
    WHERE namespace.nspname = 'ops'
      AND privilege.grantee = fence_owner_oid
  ) THEN
    RAISE EXCEPTION 'snapshot fence owner schema ACL boundary differs';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.refobjid = fence_owner_oid
      AND dependency.deptype = 'o'
      AND NOT (
        dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND dependency.objid IN (
          coalesce(pg_catalog.to_regprocedure('ops.board_snapshot_cluster_identity()'), 0::pg_catalog.oid),
          coalesce(pg_catalog.to_regprocedure('ops.acquire_board_snapshot_fence(integer)'), 0::pg_catalog.oid)
        )
      )
  ) THEN
    RAISE EXCEPTION 'snapshot fence owner owns an object outside the ops function allowlist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
    WHERE privilege.grantee = fence_owner_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_type AS type_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(type_row.typacl) AS privilege
    WHERE privilege.grantee = fence_owner_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    WHERE attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege.grantee = fence_owner_oid
  ) THEN
    RAISE EXCEPTION 'snapshot fence owner has an unexpected relation, type, or column ACL';
  END IF;

  IF NOT (
    SELECT count(*) = 1
      AND pg_catalog.bool_and(
        privilege.privilege_type = 'CREATE'
        AND NOT privilege.is_grantable
      )
    FROM pg_catalog.pg_database AS database
    CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
    WHERE database.datname = pg_catalog.current_database()
      AND privilege.grantee = owner_oid
  ) THEN
    RAISE EXCEPTION 'application owner needs exactly one direct non-grantable CREATE database ACL';
  END IF;
END;
$contract$;

COMMIT;
