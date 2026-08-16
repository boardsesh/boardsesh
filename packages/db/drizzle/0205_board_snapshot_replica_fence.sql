-- A replica snapshot needs a primary-side cutoff which cannot overtake an
-- older transaction that has not committed yet.  The exporter holds this
-- session advisory lock until its manifest has been published, so scheduled
-- and fallback exporters cannot race one another.
--
-- Deliberately do not grant these functions to an application role here.  The
-- production runbook creates a narrow snapshot coordinator role and grants it
-- USAGE/EXECUTE explicitly.  PUBLIC must never be able to inspect activity or
-- hold the global exporter lock through this SECURITY DEFINER function.
--
-- This migration is intentionally post-cutover-only. The PG18 target admin
-- must pre-provision the dedicated NOLOGIN owner and its narrowly scoped
-- monitoring privileges; Drizzle runs as the restricted application owner and
-- must never create cluster roles or grant itself predefined roles.
DO $$
BEGIN
  IF current_setting('server_version_num')::integer < 180000 THEN
    RAISE EXCEPTION '0201_board_snapshot_replica_fence requires PostgreSQL 18 or newer; complete the PG18 cutover first';
  END IF;
END;
$$;
--> statement-breakpoint

-- Production reaches this migration through the PG18 cutover runbook, which has
-- already moved public, drizzle, and everything in them to boardsesh_owner, so
-- the role switch below lands on objects the owner may replace.  Development and
-- CI have no cutover: the dev-db image and dev-db-up apply the whole journal as
-- the bootstrap superuser, which leaves every pre-0201 object owned by that
-- superuser.  SET ROLE drops the superuser bypass, so without this the CREATE OR
-- REPLACE FUNCTION, CREATE TRIGGER, and drizzle ledger writes below all fail on
-- objects postgres owns.  Mirror the cutover for exactly the objects this
-- transaction replaces, attaches a trigger to, or records itself in — the broad
-- sweep stays in scripts/postgres18-production-role-transition.sh, which is the
-- only thing allowed to move the rest.  The production migrator is verified
-- NOSUPERUSER before it is handed the deploy secret, so this block cannot run
-- there and cannot be used to move ownership behind the runbook's back.
--
-- Every branch below announces itself at NOTICE level.  A deploy log is the
-- only thing that separates "dev or CI, as designed" from "someone pointed the
-- journal at a real PG18 database using the platform superuser credential" —
-- the latter leaves public, drizzle, six tables and two functions on
-- boardsesh_owner while every other table stays on the superuser, and no
-- runbook step looks for that half-cutover state.  NOTICE cannot fail a deploy,
-- so this only ever adds a trace.
DO $$
DECLARE
  v_alter_statement text;
BEGIN
  IF NOT COALESCE(
    (SELECT role.rolsuper FROM pg_roles AS role WHERE role.rolname = session_user),
    false
  ) THEN
    RAISE NOTICE 'migration 0201 superuser preamble: skipped, session_user % is not a superuser', session_user;
    RETURN;
  END IF;

  RAISE NOTICE 'migration 0201 superuser preamble: session_user % is a superuser, re-owning the objects this migration replaces', session_user;

  FOR v_alter_statement IN
    SELECT format('ALTER SCHEMA %I OWNER TO boardsesh_owner', namespace.nspname)
    FROM pg_namespace AS namespace
    WHERE namespace.nspname IN ('public', 'drizzle')
      AND namespace.nspowner <> 'boardsesh_owner'::regrole
    ORDER BY namespace.nspname
  LOOP
    RAISE NOTICE 'migration 0201 superuser preamble: %', v_alter_statement;
    EXECUTE v_alter_statement;
  END LOOP;

  -- Owned indexes and serial sequences follow the table, so the ledger inserts
  -- drizzle appends to this same transaction keep working after the switch.
  FOR v_alter_statement IN
    SELECT format('ALTER TABLE %s OWNER TO boardsesh_owner', relation.oid::regclass)
    FROM pg_class AS relation
    WHERE relation.oid IN (
        to_regclass('public.board_climbs'),
        to_regclass('public.board_climb_stats'),
        to_regclass('public.board_climb_grades'),
        to_regclass('public.sync_deletions'),
        to_regclass('public.__drizzle_migrations'),
        to_regclass('drizzle.__drizzle_migrations')
      )
      AND relation.relowner <> 'boardsesh_owner'::regrole
    ORDER BY relation.oid::regclass::text
  LOOP
    RAISE NOTICE 'migration 0201 superuser preamble: %', v_alter_statement;
    EXECUTE v_alter_statement;
  END LOOP;

  FOR v_alter_statement IN
    SELECT format('ALTER FUNCTION %s OWNER TO boardsesh_owner', procedure.oid::regprocedure)
    FROM pg_proc AS procedure
    WHERE procedure.oid IN (
        to_regprocedure('public.set_board_climbs_sync_fields()'),
        to_regprocedure('public.set_board_climb_stats_sync_fields()')
      )
      AND procedure.proowner <> 'boardsesh_owner'::regrole
    ORDER BY procedure.oid::regprocedure::text
  LOOP
    RAISE NOTICE 'migration 0201 superuser preamble: %', v_alter_statement;
    EXECUTE v_alter_statement;
  END LOOP;
END;
$$;
--> statement-breakpoint

-- The production credential is boardsesh_migrator: LOGIN, no direct DDL, and
-- only SET membership in the NOLOGIN application owner. Drizzle wraps each
-- migration run in a transaction, so SET LOCAL both enables this migration and
-- resets automatically on success or rollback.
SET LOCAL ROLE boardsesh_owner;
--> statement-breakpoint

DO $$
DECLARE
  v_fence_owner pg_roles%ROWTYPE;
  v_application_owner_oid oid;
  v_stats_role_oid oid;
BEGIN
  IF current_user <> 'boardsesh_owner' THEN
    RAISE EXCEPTION 'migration 0201 must run as the NOLOGIN boardsesh_owner role';
  END IF;
  SELECT * INTO v_fence_owner
  FROM pg_roles
  WHERE rolname = 'boardsesh_snapshot_fence_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pre-provision NOLOGIN role boardsesh_snapshot_fence_owner before migration 0201';
  END IF;
  IF v_fence_owner.rolcanlogin
      OR v_fence_owner.rolsuper
      OR v_fence_owner.rolcreatedb
      OR v_fence_owner.rolcreaterole
      OR NOT v_fence_owner.rolinherit
      OR v_fence_owner.rolreplication
      OR v_fence_owner.rolbypassrls THEN
    RAISE EXCEPTION 'boardsesh_snapshot_fence_owner must be NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, NOREPLICATION, and NOBYPASSRLS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc AS procedure
    WHERE procedure.proowner = v_fence_owner.oid
  ) THEN
    RAISE EXCEPTION 'boardsesh_snapshot_fence_owner must not own functions before migration 0201';
  END IF;

  SELECT oid INTO STRICT v_application_owner_oid
  FROM pg_roles WHERE rolname = current_user;
  SELECT oid INTO STRICT v_stats_role_oid
  FROM pg_roles WHERE rolname = 'pg_read_all_stats';

  IF (
    SELECT count(*)
    FROM pg_auth_members AS membership
    WHERE membership.member = v_fence_owner.oid
      AND membership.roleid = v_stats_role_oid
      AND NOT membership.admin_option
      AND membership.inherit_option
      AND NOT membership.set_option
  ) <> 1 THEN
    RAISE EXCEPTION 'boardsesh_snapshot_fence_owner needs one exact direct inherited pg_read_all_stats membership without ADMIN or SET OPTION';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_auth_members AS membership
    WHERE membership.member = v_application_owner_oid
      AND membership.roleid = v_fence_owner.oid
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) <> 1 THEN
    RAISE EXCEPTION 'boardsesh_owner needs one exact direct SET-only membership in boardsesh_snapshot_fence_owner';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_auth_members AS membership
    WHERE membership.member = v_fence_owner.oid
       OR membership.roleid = v_fence_owner.oid
  ) <> 2 THEN
    RAISE EXCEPTION 'boardsesh_snapshot_fence_owner has an unexpected direct role membership';
  END IF;
  IF (
    SELECT count(*) = 2
    FROM (
      VALUES
        ('pg_catalog.pg_control_system()'::regprocedure),
        ('pg_catalog.pg_control_checkpoint()'::regprocedure)
    ) AS expected(function_oid)
    WHERE (
      SELECT count(*) = 1 AND bool_and(NOT privilege.is_grantable)
      FROM pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
      WHERE procedure.oid = expected.function_oid
        AND privilege.grantee = v_fence_owner.oid
        AND privilege.privilege_type = 'EXECUTE'
    ) IS true
  ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'boardsesh_snapshot_fence_owner needs exact direct non-grantable EXECUTE ACLs on the two pg_control identity functions';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_proc AS procedure
    CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
    WHERE privilege.grantee = v_fence_owner.oid
      AND privilege.privilege_type = 'EXECUTE'
  ) <> 2 THEN
    RAISE EXCEPTION 'boardsesh_snapshot_fence_owner has an unexpected direct function EXECUTE ACL';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS ops;
--> statement-breakpoint
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA ops TO boardsesh_snapshot_fence_owner;
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
ALTER FUNCTION ops.board_snapshot_cluster_identity() OWNER TO boardsesh_snapshot_fence_owner;
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

  -- An advisory lock is local to one PostgreSQL cluster. Taking it on a
  -- standby would not fence writers on the real primary, so reject recovery
  -- connections before acquiring any lock or sampling a WAL boundary.
  IF pg_is_in_recovery() THEN
    RAISE EXCEPTION 'board snapshot fence must be acquired on the writable primary';
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
ALTER FUNCTION ops.acquire_board_snapshot_fence(integer) OWNER TO boardsesh_snapshot_fence_owner;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ops.board_snapshot_fence_held()
RETURNS boolean
LANGUAGE sql
VOLATILE
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
