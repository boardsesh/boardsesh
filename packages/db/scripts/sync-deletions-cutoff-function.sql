-- Installed by bootstrap-sync-deletions-cutoff.ts using an explicit admin URL.
-- Exposes one timestamp, never activity/query/user details, to the runtime role.
CREATE OR REPLACE FUNCTION public.sync_deletions_safe_cutoff(stability_seconds double precision)
RETURNS timestamp without time zone
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $sync_cutoff$
DECLARE
  sampled_at timestamptz;
  oldest_writer_at timestamptz;
  metadata_unknown boolean;
BEGIN
  -- USAGE checks effective inheritance, including a revoked/NOINHERIT grant.
  -- Never interpret privilege-redacted activity fields as "no writer".
  IF NOT pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') THEN
    RETURN NULL;
  END IF;
  IF stability_seconds IS NULL OR stability_seconds < 0
     OR stability_seconds = 'NaN'::double precision
     OR stability_seconds = 'Infinity'::double precision THEN
    RETURN NULL;
  END IF;

  sampled_at := pg_catalog.clock_timestamp();
  PERFORM pg_catalog.pg_stat_clear_snapshot();
  SELECT pg_catalog.min(activity.xact_start),
         coalesce(pg_catalog.bool_or(
           activity.state = 'disabled'
           OR (activity.backend_type = 'client backend' AND activity.state IS NULL)
           OR (activity.backend_xid IS NOT NULL AND activity.xact_start IS NULL)
         ), false)
    INTO oldest_writer_at, metadata_unknown
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.datid = (SELECT database.oid FROM pg_catalog.pg_database AS database
                            WHERE database.datname = pg_catalog.current_database())
      AND activity.pid <> pg_catalog.pg_backend_pid()
      AND (activity.backend_xid IS NOT NULL OR activity.state = 'disabled'
           OR (activity.backend_type = 'client backend' AND activity.state IS NULL));
  IF metadata_unknown THEN
    RETURN NULL;
  END IF;

  -- Check AFTER activity: a writer can disappear from activity by preparing.
  -- prepared is the prepare time, not transaction start, so it is no safe bound.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_prepared_xacts AS prepared
             WHERE prepared.database = pg_catalog.current_database()) THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.timezone('UTC', LEAST(
    sampled_at - pg_catalog.make_interval(secs => stability_seconds),
    coalesce(oldest_writer_at, sampled_at)
  ));
EXCEPTION WHEN OTHERS THEN
  -- Losing stats access or unavailable metadata pauses delivery, never skips it.
  RETURN NULL;
END
$sync_cutoff$;
REVOKE ALL ON FUNCTION public.sync_deletions_safe_cutoff(double precision) FROM PUBLIC;
