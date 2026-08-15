-- A replica snapshot needs a primary-side cutoff which cannot overtake an
-- older transaction that has not committed yet.  The exporter holds this
-- session advisory lock until its manifest has been published, so scheduled
-- and fallback exporters cannot race one another.
--
-- Deliberately do not grant these functions to an application role here.  The
-- production runbook creates a narrow snapshot coordinator role and grants it
-- USAGE/EXECUTE explicitly.  PUBLIC must never be able to inspect activity or
-- hold the global exporter lock through this SECURITY DEFINER function.
CREATE SCHEMA IF NOT EXISTS ops;
--> statement-breakpoint
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
--> statement-breakpoint

-- Cursor safety must be a database invariant, not a convention in the current
-- writers.  UPDATE was already stamped for climbs/stats; make it explicitly UTC
-- and add INSERT stamps which ignore caller-supplied cursor values.  The custom
-- GUC is a restore/test escape hatch only: it is rejected unless session_user is
-- a real PostgreSQL superuser.  Normal pg_restore creates triggers in post-data,
-- after COPY, so the escape hatch is rarely needed.
CREATE OR REPLACE FUNCTION public.set_board_climbs_sync_fields() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = transaction_timestamp() AT TIME ZONE 'UTC';
  NEW.sync_seq = nextval('public.board_climbs_sync_seq_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.set_board_climb_stats_sync_fields() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = transaction_timestamp() AT TIME ZONE 'UTC';
  NEW.sync_seq = nextval('public.board_climb_stats_sync_seq_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ops.set_board_climbs_insert_sync_fields() RETURNS TRIGGER AS $$
DECLARE
  v_restore_requested boolean := current_setting('boardsesh.snapshot_cursor_restore', true) = 'on';
  v_session_is_superuser boolean;
BEGIN
  IF v_restore_requested THEN
    SELECT role.rolsuper INTO v_session_is_superuser
    FROM pg_roles AS role WHERE role.rolname = session_user;
    IF NOT COALESCE(v_session_is_superuser, false) THEN
      RAISE EXCEPTION 'boardsesh.snapshot_cursor_restore requires a PostgreSQL superuser';
    END IF;
    RETURN NEW;
  END IF;
  NEW.updated_at = transaction_timestamp() AT TIME ZONE 'UTC';
  NEW.sync_seq = nextval('public.board_climbs_sync_seq_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops.set_board_climbs_insert_sync_fields() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_board_climbs_set_insert_sync_fields
  BEFORE INSERT ON public.board_climbs
  FOR EACH ROW EXECUTE FUNCTION ops.set_board_climbs_insert_sync_fields();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ops.set_board_climb_stats_insert_sync_fields() RETURNS TRIGGER AS $$
DECLARE
  v_restore_requested boolean := current_setting('boardsesh.snapshot_cursor_restore', true) = 'on';
  v_session_is_superuser boolean;
BEGIN
  IF v_restore_requested THEN
    SELECT role.rolsuper INTO v_session_is_superuser
    FROM pg_roles AS role WHERE role.rolname = session_user;
    IF NOT COALESCE(v_session_is_superuser, false) THEN
      RAISE EXCEPTION 'boardsesh.snapshot_cursor_restore requires a PostgreSQL superuser';
    END IF;
    RETURN NEW;
  END IF;
  NEW.updated_at = transaction_timestamp() AT TIME ZONE 'UTC';
  NEW.sync_seq = nextval('public.board_climb_stats_sync_seq_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops.set_board_climb_stats_insert_sync_fields() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_board_climb_stats_set_insert_sync_fields
  BEFORE INSERT ON public.board_climb_stats
  FOR EACH ROW EXECUTE FUNCTION ops.set_board_climb_stats_insert_sync_fields();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ops.set_board_climb_grades_sync_fields() RETURNS TRIGGER AS $$
DECLARE
  v_restore_requested boolean := current_setting('boardsesh.snapshot_cursor_restore', true) = 'on';
  v_session_is_superuser boolean;
BEGIN
  IF TG_OP = 'INSERT' AND v_restore_requested THEN
    SELECT role.rolsuper INTO v_session_is_superuser
    FROM pg_roles AS role WHERE role.rolname = session_user;
    IF NOT COALESCE(v_session_is_superuser, false) THEN
      RAISE EXCEPTION 'boardsesh.snapshot_cursor_restore requires a PostgreSQL superuser';
    END IF;
    RETURN NEW;
  END IF;
  NEW.computed_at = transaction_timestamp() AT TIME ZONE 'UTC';
  NEW.sync_seq = nextval('public.board_climb_grades_sync_seq_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops.set_board_climb_grades_sync_fields() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_board_climb_grades_set_sync_fields
  BEFORE INSERT OR UPDATE ON public.board_climb_grades
  FOR EACH ROW EXECUTE FUNCTION ops.set_board_climb_grades_sync_fields();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ops.set_sync_deletion_cursor() RETURNS TRIGGER AS $$
DECLARE
  v_restore_requested boolean := current_setting('boardsesh.snapshot_cursor_restore', true) = 'on';
  v_session_is_superuser boolean;
BEGIN
  IF v_restore_requested THEN
    SELECT role.rolsuper INTO v_session_is_superuser
    FROM pg_roles AS role WHERE role.rolname = session_user;
    IF NOT COALESCE(v_session_is_superuser, false) THEN
      RAISE EXCEPTION 'boardsesh.snapshot_cursor_restore requires a PostgreSQL superuser';
    END IF;
    RETURN NEW;
  END IF;
  NEW.deleted_at = transaction_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops.set_sync_deletion_cursor() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_sync_deletions_set_cursor
  BEFORE INSERT ON public.sync_deletions
  FOR EACH ROW EXECUTE FUNCTION ops.set_sync_deletion_cursor();
--> statement-breakpoint

-- LSNs are meaningful only inside one PostgreSQL system and timeline.  This
-- narrow SECURITY DEFINER helper avoids granting the snapshot reader broad
-- control-file function access while making identity comparison mandatory.
CREATE OR REPLACE FUNCTION ops.board_snapshot_cluster_identity()
RETURNS TABLE (system_identifier text, timeline_id bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT system_control.system_identifier::text,
         checkpoint_control.timeline_id::bigint
  FROM pg_control_system() AS system_control
  CROSS JOIN pg_control_checkpoint() AS checkpoint_control;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops.board_snapshot_cluster_identity() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ops.acquire_board_snapshot_fence(
  p_stability_window_seconds integer DEFAULT 30
)
RETURNS TABLE (
  stable_before timestamp without time zone,
  target_lsn pg_lsn,
  primary_system_identifier text,
  primary_timeline_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_has_activity_visibility boolean;
  v_oldest_xact_start timestamptz;
  v_lock_acquired boolean := false;
BEGIN
  IF p_stability_window_seconds < 0 OR p_stability_window_seconds > 3600 THEN
    RAISE EXCEPTION 'snapshot stability window must be between 0 and 3600 seconds';
  END IF;

  -- The cutoff is only sound when the function owner can see every writer's
  -- xact_start.  Restricted pg_stat_activity rows expose NULL for that field,
  -- which would otherwise make an old transaction invisible.
  SELECT role.rolsuper
      OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
    INTO v_has_activity_visibility
  FROM pg_roles AS role
  WHERE role.rolname = current_user;

  IF NOT COALESCE(v_has_activity_visibility, false) THEN
    RAISE EXCEPTION
      'owner of ops.acquire_board_snapshot_fence must be superuser or have effective USAGE of pg_read_all_stats';
  END IF;

  -- Logical apply deliberately bypasses ordinary triggers and can replay a
  -- source-authored/backdated cursor after the fence. Replica snapshot export
  -- starts only after the one-way major-upgrade subscription is dropped, not
  -- merely disabled. Checking both catalog state and a shutting-down worker
  -- turns that runbook gate into a database invariant.
  IF EXISTS (
    SELECT 1
    FROM pg_subscription AS subscription
    WHERE subscription.subdbid = (
      SELECT oid FROM pg_database WHERE datname = current_database()
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_stat_activity AS activity
    WHERE activity.datid = (
      SELECT oid FROM pg_database WHERE datname = current_database()
    )
      AND activity.backend_type ILIKE '%logical replication%'
  ) THEN
    RAISE EXCEPTION 'logical replication must be removed before acquiring a board snapshot fence';
  END IF;

  SELECT pg_try_advisory_lock(4340, 1) INTO v_lock_acquired;
  IF NOT v_lock_acquired THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'another board snapshot exporter holds the global fence';
  END IF;

  BEGIN
    -- A prepared transaction no longer appears as an active client backend but
    -- can still commit an old write after the boundary.  There are no valid
    -- prepared transactions in Boardsesh, so fail closed rather than guess.
    IF EXISTS (
      SELECT 1
      FROM pg_prepared_xacts
      WHERE database = current_database()
    ) THEN
      RAISE EXCEPTION 'prepared transactions prevent a safe board snapshot fence';
    END IF;

    SELECT min(activity.xact_start)
      INTO v_oldest_xact_start
    FROM pg_stat_activity AS activity
    WHERE activity.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND activity.pid <> pg_backend_pid()
      AND activity.xact_start IS NOT NULL;

    -- Every relevant production writer stamps its cursor from transaction time.
    -- Rows from transactions active during this scan are therefore at or above
    -- oldest_xact_start and are excluded.  A transaction that starts after the
    -- scan is also above this fixed cutoff.
    stable_before := LEAST(
      (clock_timestamp() - make_interval(secs => p_stability_window_seconds)) AT TIME ZONE 'UTC',
      COALESCE(
        (v_oldest_xact_start - interval '1 microsecond') AT TIME ZONE 'UTC',
        'infinity'::timestamp without time zone
      )
    );

    -- This is intentionally sampled in a later statement than the activity
    -- scan.  Any old transaction which commits between the two has its commit
    -- WAL before this insert position; any transaction still open was excluded
    -- by stable_before.  Insert LSN is used instead of flush LSN so the proof
    -- also holds when a writer uses synchronous_commit=off.
    SELECT pg_current_wal_insert_lsn() INTO target_lsn;
    SELECT identity.system_identifier, identity.timeline_id
      INTO primary_system_identifier, primary_timeline_id
    FROM ops.board_snapshot_cluster_identity() AS identity;
    RETURN NEXT;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM pg_advisory_unlock(4340, 1);
      RAISE;
  END;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops.acquire_board_snapshot_fence(integer) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ops.board_snapshot_fence_held()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND pid = pg_backend_pid()
      AND classid = 4340::oid
      AND objid = 1::oid
      AND objsubid = 2
      AND granted
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops.board_snapshot_fence_held() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ops.release_board_snapshot_fence()
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT pg_advisory_unlock(4340, 1);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops.release_board_snapshot_fence() FROM PUBLIC;
