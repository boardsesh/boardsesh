-- Triggers that populate logbook_changes, the change log behind the
-- public logbook feed. Design and proof: docs/integration-platform.md,
-- "Incremental sync". Nothing reads these rows yet.
--
-- LOCKS ON EXISTING TABLES. Two, both SHARE ROW EXCLUSIVE, taken by CREATE
-- TRIGGER: boardsesh_ticks and board_climb_aliases. That mode blocks writers
-- and leaves readers alone. It is held until the migrator commits, which is
-- the end of the whole pending-migration run, so keep slow migrations out of
-- the release that carries this one. This migration builds no index on either
-- table and rewrites no row, so it holds the lock only for catalog work.
--
-- Both locks are taken up front in one retry-protected step (the deadlock 0144
-- documents). A waiter makes writers queue behind it, so the timeout is 1 s
-- rather than 0144's 3 s: a blocked attempt stalls tick writes for at most 1 s
-- before it backs off and lets them through.
DO $logbook_locks$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '1s';
      LOCK TABLE "boardsesh_ticks", "board_climb_aliases" IN SHARE ROW EXCLUSIVE MODE;
      SET LOCAL lock_timeout = '0';
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempts >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $logbook_locks$;
--> statement-breakpoint

-- The one feed-state row: a random generation and a zero watermark.
INSERT INTO "logbook_change_watermark" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- SECURITY DEFINER because the production deploy commits this DDL before
-- reconcileMigrationRuntimeAcl grants boardsesh_runtime on the new table. Run
-- as the writer, every tick saved in that window would fail with
-- permission_denied. Every relation is schema-qualified and the search_path is
-- pinned, as 0210 requires of a trigger function and a SECURITY DEFINER one
-- needs for its own safety (see 0270).
--
-- No EXCEPTION block: a BEGIN...EXCEPTION here opens a subtransaction per row,
-- which on a bulk logbook import overflows the per-backend subtransaction cache
-- and slows every snapshot in the cluster. Instead the body has nothing that
-- can fail for a valid tick row: the two inserted columns are NOT NULL on
-- boardsesh_ticks, the table has no foreign key or unique key beyond the
-- generated seq, and permissions are the owner's.
--
-- Twins (notAuroraTwinDuplicate): the rows a write can hide or reveal are the
-- real Aurora-pull rows of this climber at the same natural key. A row that is
-- not a real Aurora-pull row cannot hide or be hidden, so native ticks and JSON
-- imports never reach the fan-out and pay only the boolean checks. The fan-out
-- reads boardsesh_ticks_user_climbed_at_idx, the near-unique (user, instant)
-- key. It takes no row lock: the writers that create or change real Aurora-pull
-- rows (pull, updateTick, deleteTick, Kilter apply) already serialize per
-- climber under acquireUserTickMutationLock, so a twin written by one
-- transaction is visible to the next one's fan-out.
CREATE OR REPLACE FUNCTION public.log_logbook_change_from_tick() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $logbook_tick_change$
DECLARE
  old_is_real_aurora_pull boolean := false;
  new_is_real_aurora_pull boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO public.logbook_changes (user_id, tick_uuid) VALUES (OLD.user_id, OLD.uuid);
    old_is_real_aurora_pull := OLD.origin = 'aurora_pull'
      AND OLD.aurora_id IS NOT NULL AND OLD.aurora_id NOT LIKE 'json-import-%';
  END IF;

  IF TG_OP <> 'DELETE' THEN
    -- An update usually keeps the owner and uuid, so the OLD row above already
    -- covers it. A row handed to another climber or re-keyed needs its own.
    IF TG_OP = 'INSERT' OR (OLD.user_id, OLD.uuid) IS DISTINCT FROM (NEW.user_id, NEW.uuid) THEN
      INSERT INTO public.logbook_changes (user_id, tick_uuid) VALUES (NEW.user_id, NEW.uuid);
    END IF;
    new_is_real_aurora_pull := NEW.origin = 'aurora_pull'
      AND NEW.aurora_id IS NOT NULL AND NEW.aurora_id NOT LIKE 'json-import-%';
  END IF;

  IF old_is_real_aurora_pull THEN
    INSERT INTO public.logbook_changes (user_id, tick_uuid)
    SELECT twin.user_id, twin.uuid
      FROM public.boardsesh_ticks AS twin
     WHERE twin.user_id = OLD.user_id
       AND twin.climbed_at = OLD.climbed_at
       AND twin.board_type = OLD.board_type
       AND twin.climb_uuid = OLD.climb_uuid
       AND twin.angle = OLD.angle
       AND twin.origin = 'aurora_pull'
       AND twin.aurora_id IS NOT NULL
       AND twin.aurora_id NOT LIKE 'json-import-%'
       AND twin.uuid <> OLD.uuid;
  END IF;

  -- The NEW key is a separate fan-out when the write moved the row to another
  -- natural key. If the key did not move, the OLD pass above already covered it.
  IF new_is_real_aurora_pull AND (
    NOT old_is_real_aurora_pull
    OR (OLD.user_id, OLD.climbed_at, OLD.board_type, OLD.climb_uuid, OLD.angle)
       IS DISTINCT FROM (NEW.user_id, NEW.climbed_at, NEW.board_type, NEW.climb_uuid, NEW.angle)
  ) THEN
    INSERT INTO public.logbook_changes (user_id, tick_uuid)
    SELECT twin.user_id, twin.uuid
      FROM public.boardsesh_ticks AS twin
     WHERE twin.user_id = NEW.user_id
       AND twin.climbed_at = NEW.climbed_at
       AND twin.board_type = NEW.board_type
       AND twin.climb_uuid = NEW.climb_uuid
       AND twin.angle = NEW.angle
       AND twin.origin = 'aurora_pull'
       AND twin.aurora_id IS NOT NULL
       AND twin.aurora_id NOT LIKE 'json-import-%'
       AND twin.uuid <> NEW.uuid;
  END IF;

  RETURN NULL;
END;
$logbook_tick_change$;
--> statement-breakpoint

-- The boardsesh_ticks and board_climb_aliases tables are dropped and recreated
-- by the backend test schema before this file is applied there, so a re-applied
-- test schema cannot trip over these CREATE TRIGGERs; plain CREATE, because DROP
-- TRIGGER IF EXISTS would take ACCESS EXCLUSIVE on the tick table in production.

CREATE TRIGGER trg_boardsesh_ticks_logbook_insert_delete AFTER INSERT OR DELETE ON "boardsesh_ticks"
  FOR EACH ROW EXECUTE FUNCTION public.log_logbook_change_from_tick();
--> statement-breakpoint

-- The WHEN clause runs in the executor, with no function call, so an update
-- that touches only bookkeeping columns (a Kilter PowerSync redelivery, an
-- aurora_sync_error write) costs a column comparison and writes nothing.
-- Columns: everything the public serializer reads, plus what the twin rule
-- reads. Changing only aurora_sync_error, kilter_type, kilter_synced_at,
-- kilter_sync_error or board_id writes nothing.
--
-- session_id, climb_revision and kilter_detached_at have no comparison here,
-- but changing one still writes a row: trg_boardsesh_ticks_set_updated_at
-- advances updated_at for them, and updated_at is a public field and an input
-- to the twin rule (isLocallyEdited). A tick joining an inferred session
-- therefore writes a second row. That is deliberate: suppressing it would leave
-- an app holding a stale updatedAt and could miss a twin becoming hidden.
CREATE TRIGGER trg_boardsesh_ticks_logbook_update AFTER UPDATE ON "boardsesh_ticks"
  FOR EACH ROW
  WHEN (
    OLD.uuid IS DISTINCT FROM NEW.uuid
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.board_type IS DISTINCT FROM NEW.board_type
    OR OLD.climb_uuid IS DISTINCT FROM NEW.climb_uuid
    OR OLD.angle IS DISTINCT FROM NEW.angle
    OR OLD.is_mirror IS DISTINCT FROM NEW.is_mirror
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.attempt_count IS DISTINCT FROM NEW.attempt_count
    OR OLD.quality IS DISTINCT FROM NEW.quality
    OR OLD.difficulty IS DISTINCT FROM NEW.difficulty
    OR OLD.is_benchmark IS DISTINCT FROM NEW.is_benchmark
    OR OLD.comment IS DISTINCT FROM NEW.comment
    OR OLD.climbed_at IS DISTINCT FROM NEW.climbed_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.updated_at IS DISTINCT FROM NEW.updated_at
    OR OLD.origin IS DISTINCT FROM NEW.origin
    OR OLD.aurora_id IS DISTINCT FROM NEW.aurora_id
    OR OLD.aurora_type IS DISTINCT FROM NEW.aurora_type
    OR OLD.aurora_synced_at IS DISTINCT FROM NEW.aurora_synced_at
    OR OLD.kilter_id IS DISTINCT FROM NEW.kilter_id
  )
  EXECUTE FUNCTION public.log_logbook_change_from_tick();
--> statement-breakpoint

-- TRUNCATE fires no row trigger, so it would silently bypass the log. Nothing
-- in production truncates boardsesh_ticks; the backend test schema disables
-- this one trigger because its fixtures do.
CREATE OR REPLACE FUNCTION public.forbid_boardsesh_ticks_truncate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $logbook_truncate_guard$
BEGIN
  RAISE EXCEPTION 'TRUNCATE on boardsesh_ticks is not allowed: it would silently bypass logbook_changes';
END;
$logbook_truncate_guard$;
--> statement-breakpoint

CREATE TRIGGER trg_boardsesh_ticks_logbook_truncate BEFORE TRUNCATE ON "boardsesh_ticks"
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_boardsesh_ticks_truncate();
--> statement-breakpoint

-- A catalog merge changes climb.id on every tick of the merged climb, so each
-- one comes through the feed again. Deferred to commit so the fan-out reads the
-- ticks at commit rather than at the alias write: Kilter catalog sync writes
-- aliases inside a long transaction, and an immediate fan-out would miss any
-- tick on that climb committed in the rest of that transaction. Those ticks
-- reach their own change row before the merge commits and are served with the
-- old id unless the fan-out comes after them. The window that remains is the
-- gap between the trigger's snapshot and the commit, which is microseconds.
CREATE OR REPLACE FUNCTION public.log_logbook_change_from_alias() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $logbook_alias_change$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO public.logbook_changes (user_id, tick_uuid)
    SELECT tick.user_id, tick.uuid
      FROM public.boardsesh_ticks AS tick
     WHERE tick.board_type = OLD.board_type AND tick.climb_uuid = OLD.alias_uuid;
  END IF;

  IF TG_OP = 'INSERT' OR (
    TG_OP = 'UPDATE'
    AND (OLD.board_type, OLD.alias_uuid) IS DISTINCT FROM (NEW.board_type, NEW.alias_uuid)
  ) THEN
    INSERT INTO public.logbook_changes (user_id, tick_uuid)
    SELECT tick.user_id, tick.uuid
      FROM public.boardsesh_ticks AS tick
     WHERE tick.board_type = NEW.board_type AND tick.climb_uuid = NEW.alias_uuid;
  END IF;

  RETURN NULL;
END;
$logbook_alias_change$;
--> statement-breakpoint

-- The guards keep Kilter's daily self-alias upsert out of the log: it would
-- otherwise write a row a day for every tick on every climb. A self-alias
-- never changes climb.id (the canonical id is the climb's own), so inserting
-- or deleting one is not a change.
CREATE CONSTRAINT TRIGGER trg_board_climb_aliases_logbook_insert
  AFTER INSERT ON "board_climb_aliases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.alias_uuid <> NEW.canonical_uuid)
  EXECUTE FUNCTION public.log_logbook_change_from_alias();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER trg_board_climb_aliases_logbook_update
  AFTER UPDATE ON "board_climb_aliases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    OLD.canonical_uuid IS DISTINCT FROM NEW.canonical_uuid
    OR OLD.alias_uuid IS DISTINCT FROM NEW.alias_uuid
    OR OLD.board_type IS DISTINCT FROM NEW.board_type
  )
  EXECUTE FUNCTION public.log_logbook_change_from_alias();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER trg_board_climb_aliases_logbook_delete
  AFTER DELETE ON "board_climb_aliases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.alias_uuid <> OLD.canonical_uuid)
  EXECUTE FUNCTION public.log_logbook_change_from_alias();
