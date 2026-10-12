-- Custom migration generated with drizzle-kit. Admin bootstrap is a prerequisite;
-- the migrator cannot grant pg_read_all_stats or replace this separate owner's helper.
DO $sync_cutoff_prerequisite$
DECLARE
  helper_oid oid := pg_catalog.to_regprocedure('public.sync_deletions_safe_cutoff(double precision)');
  owner_oid oid;
BEGIN
  SELECT role.oid INTO owner_oid FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = 'boardsesh_sync_cutoff_owner'
      AND NOT role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreatedb
      AND NOT role.rolcreaterole AND role.rolinherit AND NOT role.rolreplication
      AND NOT role.rolbypassrls;
  IF owner_oid IS NULL OR helper_oid IS NULL
     OR NOT pg_catalog.pg_has_role(owner_oid, 'pg_read_all_stats', 'USAGE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = owner_oid)
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc AS helper
       WHERE helper.oid = helper_oid AND helper.proowner = owner_oid
         AND helper.prosecdef AND helper.provolatile = 'v'
         AND helper.prorettype = 'timestamp without time zone'::pg_catalog.regtype
         AND helper.proconfig = ARRAY['search_path=pg_catalog']::text[]
         AND pg_catalog.md5(helper.prosrc) = '7485e158858f85717c5c7a83ee259fa7'
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc AS helper
       CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(helper.proacl, pg_catalog.acldefault('f', helper.proowner))) AS privilege
       WHERE helper.oid = helper_oid
         AND (privilege.grantee = 0 OR (privilege.grantee <> owner_oid AND privilege.is_grantable))
     ) THEN
    RAISE EXCEPTION 'Deletion sync cutoff prerequisite missing/unsafe: run the reviewed admin bootstrap first';
  END IF;
END
$sync_cutoff_prerequisite$;
--> statement-breakpoint
-- Historical NULL stream_at rows retain their old cursor. Only future inserts
-- are stamped, even when a writer supplies a backdated stream_at explicitly.
CREATE FUNCTION public.stamp_sync_deletion_stream_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $sync_stream_stamp$
BEGIN
  NEW.stream_at := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  RETURN NEW;
END
$sync_stream_stamp$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stamp_sync_deletion_stream_at() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_sync_deletion_stream_at
BEFORE INSERT ON public.sync_deletions
FOR EACH ROW EXECUTE FUNCTION public.stamp_sync_deletion_stream_at();
