-- Deletion tombstones for spray_walls (SW-04, issue #5437), following the
-- log_deletion_* pattern of migrations 0144 / 0146 / 0147.
--
-- record_id is the mobile natural key, and for a wall that is its LAYOUT ID, not
-- the server bigserial: the offline mirror keys everything about a board by
-- `(board_type, layout_id)`, so that is the only id a phone can match a local
-- wall row against. It is written as text, like every other record_id.
--
-- user_id scopes the tombstone to the wall's owner. A wall is one climber's
-- private property; a NULL-scoped tombstone means "reference data, visible to
-- every client", which is exactly what a wall must never be. When the owner
-- cannot be resolved the function emits nothing rather than fall back to the
-- global scope.
CREATE OR REPLACE FUNCTION log_deletion_spray_walls() RETURNS TRIGGER AS $$
DECLARE
  owner_id text;
BEGIN
  SELECT ub.owner_id INTO owner_id
  FROM user_boards ub
  WHERE ub.uuid = OLD.board_uuid
  LIMIT 1;
  IF owner_id IS NULL THEN
    -- Loud, not silent: the only way here is a wall whose user_boards row is
    -- already gone, which nothing is supposed to be able to do (board_uuid is
    -- ON DELETE RESTRICT). Skipping the tombstone is still the right call — a
    -- NULL-scoped one would publish a private wall's id to every client — but it
    -- means a phone keeps a wall that no longer exists, so say so in the log.
    RAISE WARNING 'spray_walls tombstone skipped: no owner for board %', OLD.board_uuid;
    RETURN OLD;
  END IF;

  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES ('spray_walls', OLD.layout_id::text, owner_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Pin search_path like every other trigger function in this schema (0210): an
-- unpinned one cannot resolve `sync_deletions` while pg_restore holds
-- search_path at '', which aborts a --data-only restore (#4699).
ALTER FUNCTION log_deletion_spray_walls() SET search_path = public, pg_catalog;--> statement-breakpoint

-- THE path that actually fires. A wall is only ever SOFT-deleted: deleting the
-- row would strand every climb ever set on it, so `spray_walls.deleted_at` is
-- what a delete writes. Without this trigger the tombstone would never be
-- emitted at all and an offline client (SW-15) would keep showing a wall its
-- owner deleted, forever.
--
-- The WHEN clause fires only on the NULL -> NOT NULL transition, so re-stamping
-- an already-deleted wall (an idempotent retry) writes no second tombstone, and
-- an ordinary edit writes none.
DROP TRIGGER IF EXISTS trg_spray_walls_soft_delete ON "spray_walls";
--> statement-breakpoint
CREATE TRIGGER trg_spray_walls_soft_delete AFTER UPDATE OF deleted_at ON "spray_walls"
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION log_deletion_spray_walls();
--> statement-breakpoint

-- The hard-delete path, which should never run: no application code deletes a
-- wall row. It is wired anyway so that a wall removed by hand in psql, or by a
-- future cleanup job, still reaches the phones that have it. The one case it
-- cannot serve is a cascade from deleting the user_boards row itself — the
-- parent is gone by the time this fires, so the owner does not resolve and
-- nothing is emitted — and that path is closed anyway: spray_walls.board_uuid
-- is ON DELETE RESTRICT.
DROP TRIGGER IF EXISTS trg_spray_walls_delete ON "spray_walls";
--> statement-breakpoint
CREATE TRIGGER trg_spray_walls_delete BEFORE DELETE ON "spray_walls"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_spray_walls();
