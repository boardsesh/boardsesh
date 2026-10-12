-- Membership withdrawals must cover a prior version observed through MVCC
-- while the hiding transaction stays open. A one-second backdate can miss it.
-- The next whole second above both OLD.updated_at and the actual UTC write
-- clock covers every old timestamp, including installed SQLite TEXT values
-- with variable fractional precision. NEW.updated_at is deliberately unchanged.
--
-- Only these markers carry is_membership_withdrawal=true. syncDeletions omits
-- them for a viewer entitled to the current climb in that statement snapshot,
-- so owner/redelivery and republication cannot erase an authorized replacement.
-- A later hide generates another ordered marker. Hard deletes and historical
-- rows retain false and their existing resurrection-guard behavior.
--
-- The definer, pinned path, suppression GUC and dependent cursor bumps retain
-- the contract established by migration 0265; no document/wire timestamp changes.
CREATE OR REPLACE FUNCTION sync_board_climb_reference_membership() RETURNS TRIGGER AS $$
DECLARE
  was_reference boolean := (OLD.is_draft IS NOT TRUE AND OLD.is_listed IS TRUE);
  is_reference boolean := (NEW.is_draft IS NOT TRUE AND NEW.is_listed IS TRUE);
  marker_at timestamp := pg_catalog.date_trunc('second', GREATEST(OLD.updated_at, pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')) + interval '1 second';
BEGIN
  IF pg_catalog.current_setting('boardsesh.suppress_sync_tombstones', true) IS DISTINCT FROM 'on' THEN
    IF was_reference AND NOT is_reference THEN
      INSERT INTO public.sync_deletions (table_name, record_id, user_id, deleted_at, is_membership_withdrawal)
      VALUES ('board_climbs', NEW.uuid, NULL, marker_at, true);
    ELSIF NOT was_reference AND NOT is_reference
          AND OLD.user_id IS NOT NULL AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
      -- A protected row stops belonging to its former owner. Their cursor will
      -- not deliver the replacement, so withdraw that account's cached copy.
      INSERT INTO public.sync_deletions (table_name, record_id, user_id, deleted_at, is_membership_withdrawal)
      VALUES ('board_climbs', NEW.uuid, OLD.user_id, marker_at, true);
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
