-- Spray-wall drafts are shared with everyone who may read the wall. Their
-- climb and stats tombstones must therefore reach every cached reader, like
-- published spray climbs. Catalogue drafts retain setter-scoped tombstones.
-- Both trigger functions keep their pg_restore-safe search_path pins.

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
    CASE WHEN OLD.is_draft IS TRUE AND OLD.board_type <> 'spray' THEN OLD.user_id ELSE NULL END
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
    AND bc.is_draft IS TRUE
    AND bc.board_type <> 'spray';
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
