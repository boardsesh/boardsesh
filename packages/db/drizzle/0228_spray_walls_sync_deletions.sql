-- Deletion tombstone for spray_walls (SW-04, issue #5437), following the
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
-- cannot be resolved the trigger emits nothing rather than fall back to the
-- global scope. That happens in one case only — the cascade from deleting the
-- user_boards row itself, where the parent is already gone by the time this
-- fires — and in that case the client is tearing down the whole board anyway.
CREATE OR REPLACE FUNCTION log_deletion_spray_walls() RETURNS TRIGGER AS $$
DECLARE
  owner_id text;
BEGIN
  SELECT ub.owner_id INTO owner_id
  FROM user_boards ub
  WHERE ub.uuid = OLD.board_uuid
  LIMIT 1;
  IF owner_id IS NULL THEN
    RETURN OLD;
  END IF;

  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.layout_id::text, owner_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_spray_walls_delete ON "spray_walls";
--> statement-breakpoint
CREATE TRIGGER trg_spray_walls_delete BEFORE DELETE ON "spray_walls"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_spray_walls();
