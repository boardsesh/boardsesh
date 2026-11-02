-- Contract step of #6376. A published climb is public to everyone, so a climb
-- has no audience. Migration 0276 deleted every stored climb policy and kept
-- 'climb' in content_privacy_type_check for one release (expand/contract),
-- because migrations run before the backend deploys and a rollback keeps the
-- schema. The backend now in production writes no climb policy, so that window
-- is over. This re-stamps the sync position of the climbs those rows withheld,
-- then deletes any climb row a rolled-back backend wrote during the window, so
-- the CHECK in the next migration (0281) can drop 'climb' without failing.
--
-- One way: no code reads a climb policy any more, so nothing depends on the
-- deleted rows, but they cannot be restored. Dry run: the owner runs
-- this count on the read-only standby before merge; it is the number of rows
-- the DELETE below removes (expected 0).
--   SELECT count(*) FROM content_privacy WHERE entity_type = 'climb';
--
-- Locks. The next migration (0281) drops and re-adds the CHECK, which takes
-- ACCESS EXCLUSIVE on content_privacy. The snapshot exporter holds long
-- REPEATABLE READ transactions that read it, and a bare ALTER would queue
-- behind one and then block every privacy read behind itself. Take the lock up
-- front in one retry-protected step, the 0144/0220/0250 shape: each attempt
-- waits up to 3 s, at most 40 attempts one second apart, then the deploy fails
-- and rolls back. The deploy runs every pending migration in one transaction,
-- so the lock is held through 0281 and released at its commit.
DO $$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';
      LOCK TABLE "content_privacy" IN ACCESS EXCLUSIVE MODE;
      SET LOCAL lock_timeout = '0';
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempts >= 40 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
--> statement-breakpoint
-- Re-send first, then delete, as 0276 did. A backend rolled back to before
-- #6355 withheld any climb with a policy row from other climbers' board sync,
-- with its stats and grades, so a phone may have moved its cursor past them.
-- Deleting the policy alone would leave those climbs missing from that phone's
-- incremental sync. This re-stamps only the sync cursor columns of the
-- published climbs that have a stray policy row, with their stats and grades,
-- while the rows still exist to find them (drafts stay with their owner). It
-- changes server-side positions only, so phones receive the rows again; it
-- deletes nothing on a device. `updated_at` and `sync_seq` are set explicitly
-- because the sync-field triggers (0146, 0195) fire only when a column the
-- device stores changes; `DEFAULT` takes each table's sync_seq sequence.
-- clock_timestamp() is the write time, so the stamp lands inside the 30 s sync
-- stability window; the rows are found through the content_privacy and
-- board_climbs primary keys.
-- Climbs it re-sends:
--   SELECT count(*) FROM content_privacy cp JOIN board_climbs bc ON bc.uuid = cp.entity_id
--   WHERE cp.entity_type = 'climb' AND bc.is_draft IS NOT TRUE;
WITH withheld_climbs AS (
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
DELETE FROM content_privacy WHERE entity_type = 'climb';
