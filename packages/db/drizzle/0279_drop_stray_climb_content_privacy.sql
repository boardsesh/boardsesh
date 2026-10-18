-- Contract step of #6376. A published climb is public to everyone, so a climb
-- has no audience. Migration 0276 deleted every stored climb policy and kept
-- 'climb' in content_privacy_type_check for one release (expand/contract),
-- because migrations run before the backend deploys and a rollback keeps the
-- schema. The backend now in production writes no climb policy, so that window
-- is over. This deletes any climb row a rolled-back backend wrote during it, so
-- the CHECK in the next migration (0280) can drop 'climb' without failing.
--
-- One way: no code reads a climb policy any more, so nothing depends on the
-- deleted rows, but they cannot be restored. Dry run: the owner runs
-- this count on the read-only standby before merge; it is the number of rows
-- the DELETE below removes (expected 0).
--   SELECT count(*) FROM content_privacy WHERE entity_type = 'climb';
--
-- Locks. The next migration (0280) drops and re-adds the CHECK, which takes
-- ACCESS EXCLUSIVE on content_privacy. The snapshot exporter holds long
-- REPEATABLE READ transactions that read it, and a bare ALTER would queue
-- behind one and then block every privacy read behind itself. Take the lock up
-- front in one retry-protected step, the 0144/0220/0250 shape: each attempt
-- waits up to 3 s, at most 40 attempts one second apart, then the deploy fails
-- and rolls back. The deploy runs every pending migration in one transaction,
-- so the lock is held through 0280 and released at its commit.
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
DELETE FROM content_privacy WHERE entity_type = 'climb';
