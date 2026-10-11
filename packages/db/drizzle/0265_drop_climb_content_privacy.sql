-- A published climb is public to everyone, so a climb has no audience. Remove
-- every stored climb policy, including deleted-account tombstones, before the
-- next migration narrows content_privacy_type_check to exclude 'climb'.
--
-- One way: once this runs, the per-climb audiences are gone, and reverting the
-- code cannot bring them back. Nothing reads them after this change. Count them
-- on the read-only standby before merging, and keep the number with the PR:
--   SELECT audience, (owner_id IS NULL) AS ownerless, count(*)
--   FROM content_privacy WHERE entity_type = 'climb' GROUP BY 1, 2 ORDER BY 1, 2;
DELETE FROM "content_privacy" WHERE "entity_type" = 'climb';
