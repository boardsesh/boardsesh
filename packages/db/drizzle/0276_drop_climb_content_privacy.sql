-- A published climb is public to everyone, so a climb has no audience. Remove
-- every stored climb policy, including deleted-account tombstones. Nothing
-- reads them after this release.
--
-- Expand/contract: content_privacy_type_check still allows 'climb' for one
-- release, because migrations run before the backend deploys and a rollback
-- keeps the schema, so the previous backend may still write a climb policy in
-- that window. The follow-up (#6376) deletes any such row and drops 'climb'
-- from the CHECK.
--
-- One way: once this runs, the per-climb audiences are gone, and reverting the
-- code cannot bring them back. Dry run: the owner runs this count on the
-- read-only standby before merge and pastes the result into the PR. It is the
-- number of rows the DELETE below removes.
--   SELECT count(*) FROM content_privacy WHERE entity_type = 'climb';
-- The same rows, by audience and by whether the owner deleted their account:
--   SELECT audience, (owner_id IS NULL) AS ownerless, count(*)
--   FROM content_privacy WHERE entity_type = 'climb' GROUP BY 1, 2 ORDER BY 1, 2;
--
-- Re-send first, then delete. The board sync used to leave a private
-- account's published climbs, and any climb with a policy row, out of other
-- climbers' pulls, with their stats and grades. A phone that already pulled
-- past those rows would never get them, because nothing moves their cursor,
-- and a downloaded board reads search, climbs, stats and grades from the
-- phone. So the first statement re-stamps them (the sync cursor columns only),
-- while the policy rows still exist to find them. Drafts are left alone: they
-- stay with their owner. `updated_at` and `sync_seq` are set explicitly
-- because the sync-field triggers (0146, 0195) fire only when a column the
-- device stores changes; `DEFAULT` takes each table's sync_seq sequence, as
-- `updateClimb` does on publish. Plain row updates, ROW EXCLUSIVE locks only.
--
-- The stamp has to land inside the 30 s sync stability window: a device skips
-- rows newer than 30 s and pages on (updated_at, sync_seq), so a row stamped
-- more than 30 s before its transaction commits can fall behind a cursor that
-- moved on in the meantime. So the rows are found through indexes, not a scan
-- of board_climbs: the private accounts' climbs through
-- board_climbs_user_export_idx (user_id, board_type), the policy rows through
-- the content_privacy and board_climbs primary keys. And the stamp is
-- clock_timestamp(), the time the row is written, not now(), which is the
-- start of the migrate transaction and so also counts every migration that
-- ran before this one in the same batch. Either stamp is compared with the
-- reader's now() minus the window the same way; clock_timestamp() only moves
-- it closer to the commit.
-- Climbs it re-sends, on the standby (stats and grades rows follow them):
--   SELECT count(*) FROM board_climbs bc JOIN user_profiles p ON p.user_id = bc.user_id
--   WHERE p.is_private AND bc.is_draft IS NOT TRUE;
WITH withheld_climbs AS (
  SELECT bc.board_type, bc.uuid FROM user_profiles p
  JOIN board_climbs bc ON bc.user_id = p.user_id
  WHERE p.is_private AND bc.is_draft IS NOT TRUE
  UNION
  SELECT bc.board_type, bc.uuid FROM content_privacy cp
  JOIN board_climbs bc ON bc.uuid = cp.entity_id
  WHERE cp.entity_type = 'climb' AND bc.is_draft IS NOT TRUE
), restamped_climbs AS (
  UPDATE board_climbs bc SET updated_at = clock_timestamp(), sync_seq = DEFAULT
  FROM withheld_climbs w WHERE bc.board_type = w.board_type AND bc.uuid = w.uuid
  RETURNING 1
), restamped_stats AS (
  UPDATE board_climb_stats s SET updated_at = clock_timestamp(), sync_seq = DEFAULT
  FROM withheld_climbs w WHERE s.board_type = w.board_type AND s.climb_uuid = w.uuid
  RETURNING 1
)
UPDATE board_climb_grades g SET computed_at = clock_timestamp(), sync_seq = DEFAULT
FROM withheld_climbs w WHERE g.board_type = w.board_type AND g.climb_uuid = w.uuid;
--> statement-breakpoint
DELETE FROM "content_privacy" WHERE "entity_type" = 'climb';
