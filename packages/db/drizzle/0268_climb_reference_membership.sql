-- Tell devices when a climb changes side of the publication rule (#6306).
--
-- A climb that is published and listed is public: the snapshot artifact and the
-- REFERENCE sync stream carry it to every device. A draft or an unlisted climb
-- goes to its owner alone. The membership test is one expression,
-- `is_draft IS NOT TRUE AND is_listed IS TRUE`, the text of
-- publicReferenceClimbSql in packages/db/src/queries/privacy.ts. Change one and
-- change the other.
--
-- When an UPDATE moves a climb across that line or changes a protected owner,
-- the row itself is bumped by
-- trg_board_climbs_set_sync_fields, and the stream that now holds it delivers
-- it. Two things that bump cannot do are done here.
--
-- 1. LEAVING the set (published and listed becomes a draft or unlisted). No
--    stream delivers the new row to anyone but its owner, so every other device
--    would keep its copy of the published climb. A deletion marker makes each
--    device drop it, the way a hard delete does (log_deletion_board_climbs,
--    0144). Dropping the climb's stats and grades rows with it is the device's
--    part: neither table gets a marker of its own here (see below).
--
--    The marker is stamped ONE SECOND BEFORE the row's new updated_at. A
--    device deletes a row when `updated_at <= deletedAt`, a tie included, and
--    it may meet the marker after it has stored the owner's re-delivered row: a
--    cycle that straddles the stability window, or a replay of the deletion
--    stream. Stamped at the same instant, the marker would then delete the
--    owner's own row for good, because the cursor never fetches it again. One
--    second earlier it can only ever match an older copy. Every older copy is
--    at least a stability window older than the new row (a device can only
--    have pulled a version once it was that old), so none is missed while
--    SYNC_STABILITY_WINDOW_SECONDS stays above one second. It defaults to 30.
--
-- 2. EITHER direction, or a protected owner change. The climb's stats and grades
--    rows change stream or viewer with it
--    and did not change themselves, so they sit behind every device's cursor
--    for the stream they are now in: behind the owner's cursor when the climb
--    leaves (and the owner's device drops them with the climb when it applies
--    the marker), behind everyone's reference cursor when the climb is
--    published or listed again. Moving their cursor position to the climb's
--    delivers them. Nobody who may not see the climb is sent them, because
--    every stream scopes stats and grades through the climb.
--
-- No deletion marker is written for the stats or grades rows themselves.
-- board_climb_grades has none anywhere, and a device applies one with no
-- newer-row guard (the table has no updated_at), so a late marker would delete
-- the owner's re-delivered grade.
--
-- Bulk catalogue imports that delete and recreate a board set
-- boardsesh.suppress_sync_tombstones for their transaction. The marker honours
-- it, like the delete triggers.
--
-- SECURITY DEFINER: the function writes sync_deletions, board_climb_stats and
-- board_climb_grades on behalf of whichever role updated the climb. The import
-- workers update climbs and hold no write privilege on board_climb_grades, and
-- an import must not fail because a climb it unlisted has a grade. The body
-- names its three tables with their schema, takes its values from the row, and
-- the search_path is pinned below.
CREATE OR REPLACE FUNCTION sync_board_climb_reference_membership() RETURNS TRIGGER AS $$
DECLARE
  was_reference boolean := (OLD.is_draft IS NOT TRUE AND OLD.is_listed IS TRUE);
  is_reference boolean := (NEW.is_draft IS NOT TRUE AND NEW.is_listed IS TRUE);
  marker_at timestamp := NEW.updated_at - interval '1 second';
BEGIN
  IF current_setting('boardsesh.suppress_sync_tombstones', true) IS DISTINCT FROM 'on' THEN
    IF was_reference AND NOT is_reference THEN
      INSERT INTO public.sync_deletions (table_name, record_id, user_id, deleted_at)
      VALUES ('board_climbs', NEW.uuid, NULL, marker_at);
    ELSIF NOT was_reference AND NOT is_reference
          AND OLD.user_id IS NOT NULL AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
      -- A protected row stops belonging to its former owner. Their cursor will
      -- not deliver the replacement, so withdraw that account's cached copy.
      INSERT INTO public.sync_deletions (table_name, record_id, user_id, deleted_at)
      VALUES ('board_climbs', NEW.uuid, OLD.user_id, marker_at);
    END IF;
  END IF;

  -- trg_board_climb_stats_set_sync_fields fires only when a shipped column
  -- changes (0195), so the cursor fields are written here.
  UPDATE public.board_climb_stats
     SET updated_at = NEW.updated_at, sync_seq = DEFAULT
   WHERE board_type = NEW.board_type AND climb_uuid = NEW.uuid;

  UPDATE public.board_climb_grades
     SET computed_at = NEW.updated_at, sync_seq = DEFAULT
   WHERE board_type = NEW.board_type AND climb_uuid = NEW.uuid;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
--> statement-breakpoint
-- Pinned like every other trigger function in this schema (0210), and required
-- for a SECURITY DEFINER function: its names must not resolve through the
-- caller's path.
ALTER FUNCTION sync_board_climb_reference_membership() SET search_path = public, pg_catalog;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_board_climbs_reference_membership ON "board_climbs";
--> statement-breakpoint
-- AFTER, so NEW.updated_at is the value trg_board_climbs_set_sync_fields wrote.
-- The WHEN clause is the membership test on both sides: an edit that leaves a
-- climb on the side it was on calls nothing unless its protected owner changes.
-- Owner backfills and draft imports must deliver old stats and grades past the
-- new owner's existing cursor, just like a change of reference membership.
CREATE TRIGGER trg_board_climbs_reference_membership AFTER UPDATE ON "board_climbs"
  FOR EACH ROW
  WHEN ((OLD.is_draft IS NOT TRUE AND OLD.is_listed IS TRUE)
        IS DISTINCT FROM
        (NEW.is_draft IS NOT TRUE AND NEW.is_listed IS TRUE)
        OR ((NEW.is_draft IS TRUE OR NEW.is_listed IS NOT TRUE)
            AND OLD.user_id IS DISTINCT FROM NEW.user_id))
  EXECUTE FUNCTION sync_board_climb_reference_membership();
