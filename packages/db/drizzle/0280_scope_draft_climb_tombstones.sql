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
--   - a draft with no Boardsesh owner (an Aurora import). The board sync stopped
--     sending these in #6432, but a phone that downloaded the board before then
--     still holds them, and catalogue revalidation keeps them (they look like
--     manufacturer data; docs/privacy.md). The unscoped tombstone is the only
--     thing that removes that copy, and no account or private wall is involved.
--
-- The draft's board_climb_stats rows leak the same way: saveClimb seeds one
-- when a draft's grade resolves, deleteClimbDependentRows deletes it before the
-- climb, and log_deletion_board_climb_stats (0144) tombstoned it with NULL,
-- record_id '<board_type>:<climb_uuid>:<angle>'. That function now looks up
-- the climb, which still exists when its stats are deleted, and scopes the
-- tombstone the same way. A stats row whose climb is already gone, published
-- or ownerless stays NULL-scoped.
--
-- Only the function bodies change; the triggers (trg_board_climbs_delete,
-- trg_board_climb_stats_delete) stay. CREATE OR REPLACE FUNCTION is
-- catalogue-only and takes no lock on either table. It also resets each
-- function's SET clauses, so 0210's search_path pins are applied again below.
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION log_deletion_board_climb_stats() RETURNS TRIGGER AS $$
DECLARE
  draft_owner text;
BEGIN
  -- Same bulk re-import guard as log_deletion_board_climbs.
  IF current_setting('boardsesh.suppress_sync_tombstones', true) = 'on' THEN
    RETURN OLD;
  END IF;
  -- NULL unless the climb is a draft with an owner (no row: NULL as well).
  -- This relies on the caller deleting stats BEFORE the climb row, which
  -- deleteClimbDependentRows (climb-cleanup.ts) requires of every caller. There
  -- is no FK cascade (0031 dropped it); a stats row deleted after its climb
  -- finds no row here and gets a NULL-scoped tombstone.
  SELECT bc.user_id INTO draft_owner
  FROM board_climbs bc
  WHERE bc.board_type = OLD.board_type
    AND bc.uuid = OLD.climb_uuid
    AND bc.is_draft IS TRUE;
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (
    TG_TABLE_NAME,
    OLD.board_type || ':' || OLD.climb_uuid || ':' || OLD.angle::text,
    draft_owner
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
ALTER FUNCTION log_deletion_board_climb_stats() SET search_path = public, pg_catalog;
