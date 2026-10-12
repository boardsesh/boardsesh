-- __SYNC_RUNTIME_ROLE__ is replaced only after validating a simple identifier.
WITH helper AS (
  SELECT * FROM pg_catalog.pg_proc
  WHERE oid = pg_catalog.to_regprocedure('public.sync_deletions_safe_cutoff(double precision)')
), cutoff_owner AS (
  SELECT * FROM pg_catalog.pg_roles WHERE rolname = 'boardsesh_sync_cutoff_owner'
), runtime AS (
  SELECT * FROM pg_catalog.pg_roles WHERE rolname = '__SYNC_RUNTIME_ROLE__'
)
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM helper) THEN
  -- An older source predating this migration needs no helper yet.
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = pg_catalog.to_regclass('public.sync_deletions')
                AND attname = 'stream_at' AND NOT attisdropped)
ELSE EXISTS (
  SELECT 1 FROM helper, cutoff_owner, runtime
  WHERE helper.proowner = cutoff_owner.oid AND helper.prosecdef AND helper.provolatile = 'v'
    AND helper.prorettype = 'timestamp without time zone'::pg_catalog.regtype
    AND helper.proconfig = ARRAY['search_path=pg_catalog']::text[]
    AND pg_catalog.md5(helper.prosrc) = '7485e158858f85717c5c7a83ee259fa7'
    AND NOT cutoff_owner.rolcanlogin AND NOT cutoff_owner.rolsuper
    AND NOT cutoff_owner.rolcreatedb AND NOT cutoff_owner.rolcreaterole
    AND cutoff_owner.rolinherit AND NOT cutoff_owner.rolreplication AND NOT cutoff_owner.rolbypassrls
    AND pg_catalog.pg_has_role(cutoff_owner.oid, 'pg_read_all_stats', 'USAGE')
    AND NOT pg_catalog.pg_has_role(runtime.oid, 'pg_read_all_stats', 'USAGE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
      WHERE membership.roleid = cutoff_owner.oid
         OR (membership.member = cutoff_owner.oid AND (
           granted.rolname <> 'pg_read_all_stats' OR membership.admin_option
           OR coalesce((pg_catalog.to_jsonb(membership)->>'inherit_option')::boolean, true) = false
           OR coalesce((pg_catalog.to_jsonb(membership)->>'set_option')::boolean, false) = true
         ))
    )
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS other
                    WHERE other.proowner = cutoff_owner.oid AND other.oid <> helper.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = cutoff_owner.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = cutoff_owner.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba = cutoff_owner.oid)
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(coalesce(helper.proacl, pg_catalog.acldefault('f', helper.proowner))) AS privilege
      WHERE privilege.grantee NOT IN (cutoff_owner.oid, runtime.oid)
         OR privilege.privilege_type <> 'EXECUTE'
         OR (privilege.grantee <> cutoff_owner.oid AND privilege.is_grantable)
    )
    AND EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(helper.proacl) AS privilege
      WHERE privilege.grantee = runtime.oid AND privilege.privilege_type = 'EXECUTE'
        AND NOT privilege.is_grantable
    )
) END AS matches;
