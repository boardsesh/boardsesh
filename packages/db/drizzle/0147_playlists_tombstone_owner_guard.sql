-- Parity with 0146's log_deletion_playlist_climbs guard (review follow-up on
-- PR #3500): sync_deletions.user_id = NULL means "reference data, visible to
-- ALL clients", so deleting a playlist whose playlist_ownership row is already
-- gone must skip the tombstone rather than emit a global one. BEFORE DELETE
-- runs while ownership still exists on the normal path; only a genuinely
-- orphaned playlist hits the NULL branch, and with no owner there is no client
-- that needs the tombstone.
CREATE OR REPLACE FUNCTION log_deletion_playlists() RETURNS TRIGGER AS $$
DECLARE
  owner_id text;
BEGIN
  SELECT po.user_id INTO owner_id
  FROM playlist_ownership po
  WHERE po.playlist_id = OLD.id AND po.role = 'owner'
  LIMIT 1;
  IF owner_id IS NULL THEN
    RETURN OLD;
  END IF;
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.uuid, owner_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
