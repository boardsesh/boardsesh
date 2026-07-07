-- Offline sync follow-ups (issue #3475): board_type-leading sync cursor
-- indexes, a prune index for sync_deletions, WHEN guards so internal-only and
-- no-op writes stop bumping sync cursors, an updated_at safety net on
-- boardsesh_ticks, and an owner guard on the playlist_climbs tombstone.

-- Take every table lock this migration needs up front, before any slow work,
-- in one retry-protected step (see 0144 for the deadlock this pattern avoids).
-- board_climbs / board_climb_stats get ACCESS EXCLUSIVE (index drop/create +
-- trigger swap); boardsesh_ticks and sync_deletions only gain a trigger/index,
-- so SHARE ROW EXCLUSIVE keeps reads flowing. playlist_climbs isn't locked:
-- CREATE OR REPLACE FUNCTION takes no table lock.
DO $$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';
      LOCK TABLE "board_climb_stats", "board_climbs" IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE "boardsesh_ticks", "sync_deletions" IN SHARE ROW EXCLUSIVE MODE;
      SET LOCAL lock_timeout = '0';
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempts >= 40 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
--> statement-breakpoint
DROP INDEX "board_climb_stats_sync_cursor_idx";--> statement-breakpoint
DROP INDEX "board_climbs_sync_cursor_idx";--> statement-breakpoint
CREATE INDEX "sync_deletions_deleted_at_idx" ON "sync_deletions" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "board_climb_stats_sync_cursor_idx" ON "board_climb_stats" USING btree ("board_type","updated_at","sync_seq");--> statement-breakpoint
CREATE INDEX "board_climbs_sync_cursor_idx" ON "board_climbs" USING btree ("board_type","updated_at","sync_seq");--> statement-breakpoint

-- Bump sync fields only when a client-visible column changed. syncClimbs ships
-- every column except synced/sync_error (kilter-sync bookkeeping), so
-- subtracting the internal set fails CLOSED: a column added later still fires
-- the trigger (worst case an unnecessary re-ship, never a skipped one).
-- board_climbs UPDATE volume is low, so the per-row jsonb cost is fine.
DROP TRIGGER IF EXISTS trg_board_climbs_set_sync_fields ON "board_climbs";
--> statement-breakpoint
CREATE TRIGGER trg_board_climbs_set_sync_fields BEFORE UPDATE ON "board_climbs"
  FOR EACH ROW
  WHEN ((to_jsonb(OLD) - ARRAY['synced','sync_error','updated_at','sync_seq'])
        IS DISTINCT FROM
        (to_jsonb(NEW) - ARRAY['synced','sync_error','updated_at','sync_seq']))
  EXECUTE FUNCTION set_board_climbs_sync_fields();
--> statement-breakpoint

-- The kilter catalog sync rewrites EVERY stats row per run with mostly
-- identical values (GREATEST/COALESCE upsert), which today re-ships ~the whole
-- stats table to every offline client after each cron. Row equality catches
-- exactly that at near-zero cost on the bulk path; the few non-shipped stats
-- columns can't change without a shipped one changing in the same statement.
DROP TRIGGER IF EXISTS trg_board_climb_stats_set_sync_fields ON "board_climb_stats";
--> statement-breakpoint
CREATE TRIGGER trg_board_climb_stats_set_sync_fields BEFORE UPDATE ON "board_climb_stats"
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_board_climb_stats_sync_fields();
--> statement-breakpoint

-- updated_at safety net for boardsesh_ticks: every current writer sets
-- updated_at explicitly, but a future writer that forgets would produce rows
-- the sync cursor skips forever. Guarded so a bookkeeping-only stamper
-- (aurora_*/kilter_* columns — none of which syncTicks ships) never re-ships
-- a user's whole logbook after an external sync pass.
CREATE TRIGGER trg_boardsesh_ticks_set_updated_at BEFORE UPDATE ON "boardsesh_ticks"
  FOR EACH ROW
  WHEN ((to_jsonb(OLD) - ARRAY['id','board_id','updated_at',
          'aurora_type','aurora_id','aurora_synced_at','aurora_sync_error',
          'kilter_type','kilter_id','kilter_synced_at','kilter_sync_error'])
        IS DISTINCT FROM
        (to_jsonb(NEW) - ARRAY['id','board_id','updated_at',
          'aurora_type','aurora_id','aurora_synced_at','aurora_sync_error',
          'kilter_type','kilter_id','kilter_synced_at','kilter_sync_error']))
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- Owner guard for the playlist_climbs tombstone: sync_deletions.user_id = NULL
-- means "reference data, visible to ALL clients", so an orphaned
-- playlist_ownership row must skip the tombstone rather than emit a global one.
-- (The parent-uuid early return already covers the playlist-delete cascade.)
CREATE OR REPLACE FUNCTION log_deletion_playlist_climbs() RETURNS TRIGGER AS $$
DECLARE
  v_playlist_uuid text;
  owner_id text;
BEGIN
  SELECT p.uuid INTO v_playlist_uuid
  FROM playlists p
  WHERE p.id = OLD.playlist_id
  LIMIT 1;
  IF v_playlist_uuid IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT po.user_id INTO owner_id
  FROM playlist_ownership po
  WHERE po.playlist_id = OLD.playlist_id AND po.role = 'owner'
  LIMIT 1;
  IF owner_id IS NULL THEN
    RETURN OLD;
  END IF;

  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, v_playlist_uuid || ':' || OLD.climb_uuid, owner_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
