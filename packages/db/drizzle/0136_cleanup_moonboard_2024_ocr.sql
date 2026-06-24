-- Remove the OCR-imported MoonBoard 2024 problems.
--
-- Until the authoritative MoonBoard 2024 export landed (import-moonboard-2024.ts),
-- every MoonBoard 2024 climb in the DB came from the web OCR flow
-- (saveMoonBoardClimb), which writes synced=false / user_id IS NOT NULL and a
-- random UUID. The authoritative import writes synced=true / user_id=NULL, so
-- this delete never touches it regardless of import/migration order.
--
-- Deleting board_climbs cascades to board_climb_holds, board_circuits_climbs,
-- and board_climb_aliases (the only three FKs to board_climbs.uuid). Every other
-- climb-scoped table has no FK, so we delete their rows for these UUIDs first to
-- avoid leaving orphans that point at non-existent climbs. proposal_votes
-- cascades from climb_proposals.

-- Capture the target UUIDs up front so every delete below uses the same set
-- even though board_climbs is emptied last.
CREATE TEMP TABLE moonboard_2024_ocr_targets ON COMMIT DROP AS
SELECT uuid
  FROM board_climbs
 WHERE board_type = 'moonboard'
   AND layout_id = 3
   AND synced = false
   AND user_id IS NOT NULL;

-- Record the blast radius in the deploy log (this hard-deletes real user data).
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM moonboard_2024_ocr_targets;
  RAISE NOTICE 'moonboard 2024 OCR cleanup: deleting % climb(s) and their ticks/favorites/playlist entries', n;
END $$;

DELETE FROM boardsesh_ticks
 WHERE board_type = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

DELETE FROM user_favorites
 WHERE board_name = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

-- playlist_climbs has no board_type column; the target UUIDs are unique, so match on uuid alone.
DELETE FROM playlist_climbs
 WHERE climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

DELETE FROM board_climb_stats
 WHERE board_type = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

DELETE FROM board_climb_ratings
 WHERE board_type = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

DELETE FROM climb_proposals
 WHERE board_type = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

DELETE FROM climb_community_status
 WHERE board_type = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

DELETE FROM climb_classic_status
 WHERE board_type = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

DELETE FROM board_climb_events
 WHERE board_type = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

DELETE FROM board_climb_send_stats
 WHERE board_type = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

DELETE FROM board_climb_stats_history
 WHERE board_type = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

-- board_beta_links has no FK to board_climbs (it isn't cascaded), so delete explicitly.
DELETE FROM board_beta_links
 WHERE board_type = 'moonboard'
   AND climb_uuid IN (SELECT uuid FROM moonboard_2024_ocr_targets);

-- Cascades: board_climb_holds, board_circuits_climbs, board_climb_aliases.
DELETE FROM board_climbs
 WHERE board_type = 'moonboard'
   AND layout_id = 3
   AND synced = false
   AND user_id IS NOT NULL;
