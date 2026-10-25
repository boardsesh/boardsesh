-- Custom SQL migration file, put your code below! --

-- Scope a draft's deletion tombstone to its setter (#6150).
--
-- log_deletion_board_climbs (0144) wrote every board_climbs tombstone with
-- user_id = NULL, and syncDeletions hands a NULL-scoped tombstone to every
-- signed-in device. Since #6432 a draft reaches only its setter
-- (climbDraftVisibilityCondition), so deleting one through deleteDraftClimb,
-- deleteClimb's draft branch or account deletion sent the uuid of a climb
-- nobody else could read to every phone.
--
-- A draft's tombstone now carries OLD.user_id, which every one of the setter's
-- devices still pulls. Two cases keep NULL:
--
--   - a published climb, because anybody who could read it may have it on a
--     phone (gym members, public-wall viewers, grantees: #6196);
--   - a draft with no Boardsesh owner (an Aurora import), which goes to nobody,
--     so there is no account to scope it to and no private wall involved.
--
-- Only the function body changes; the trigger (trg_board_climbs_delete) stays.
-- CREATE OR REPLACE FUNCTION is catalogue-only and takes no lock on
-- board_climbs. It also resets the function's SET clauses, so 0210's
-- search_path pin is applied again below.
CREATE OR REPLACE FUNCTION log_deletion_board_climbs() RETURNS TRIGGER AS $$
BEGIN
  -- Bulk board re-imports (clearBoardData) delete and recreate every row of a
  -- board in one transaction and set this transaction-local GUC to declare
  -- "rows are coming right back" (0144).
  IF current_setting('boardsesh.suppress_sync_tombstones', true) = 'on' THEN
    RETURN OLD;
  END IF;
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (
    TG_TABLE_NAME,
    OLD.uuid,
    CASE WHEN OLD.is_draft IS TRUE THEN OLD.user_id ELSE NULL END
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Pin search_path like every other trigger function in this schema (0210): an
-- unpinned one cannot resolve `sync_deletions` while pg_restore holds
-- search_path at '', which aborts a --data-only restore (#4699).
ALTER FUNCTION log_deletion_board_climbs() SET search_path = public, pg_catalog;
