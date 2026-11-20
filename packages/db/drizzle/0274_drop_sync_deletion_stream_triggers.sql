-- Custom migration generated with drizzle-kit (generate --custom).
-- Contract half of reverting #6339 (#6431 reverted its code, this drops what
-- its migrations left behind). Nothing has read these since #6431's backend
-- went live. This migration drops the two triggers and their functions; the
-- next one (generated from the Drizzle schema) drops the indexes and columns.
--
-- Dropped here, and nothing else:
--   trg_board_climbs_reference_membership ON board_climbs  (0270)
--   sync_board_climb_reference_membership()                (0270)
--   trg_sync_deletion_stream_at ON sync_deletions          (0272)
--   public.stamp_sync_deletion_stream_at()                 (0272)
-- The triggers go first: a function cannot be dropped while a trigger calls
-- it, and stamp_sync_deletion_stream_at() writes the stream_at column the next
-- migration drops. No IF EXISTS and no CASCADE, so a missing object or an
-- unexpected dependant fails the deploy instead of passing quietly.
--
-- Not dropped: public.sync_deletions_safe_cutoff(double precision) and the role
-- boardsesh_sync_cutoff_owner. An administrator installed both outside any
-- migration, the migration login cannot drop them, and 0272 still needs them
-- to replay on a fresh database. packages/db/scripts/teardown-sync-deletions-cutoff.ts
-- removes them from production after this lands (docs/sync-deletions-cutoff.md).
--
-- Locks. DROP TRIGGER takes ACCESS EXCLUSIVE on its table, and the next
-- migration's DROP INDEX and DROP COLUMN take it on sync_deletions. Every climb
-- page and sync pull reads board_climbs, and every delete on a synced table
-- writes sync_deletions, so a bare DROP TRIGGER would queue behind one long
-- reader and then block everything behind itself. Take both locks up front in
-- one retry-protected step, the 0144/0220/0250 shape, with one change: only
-- board_climbs is waited for. Each attempt waits up to 3 s for it, and climb
-- reads queue behind that wait. It then asks for sync_deletions with NOWAIT. If
-- a transaction is still writing a deletion marker, the attempt fails, and
-- rolling back this block releases board_climbs at once instead of holding it
-- for a second 3 s wait. So climb reads stall for at most 3 s per attempt, at
-- most 40 attempts one second apart (about 160 s), and then the deploy fails
-- and rolls back. The drops themselves are catalogue-only and finish in
-- milliseconds, and the deploy runs every pending migration in one
-- transaction, so the locks are released at its commit.
DO $$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';
      LOCK TABLE "board_climbs" IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE "sync_deletions" IN ACCESS EXCLUSIVE MODE NOWAIT;
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
DROP TRIGGER trg_board_climbs_reference_membership ON "board_climbs";
--> statement-breakpoint
-- Unqualified, the way 0270 created it, so it resolves through the same path.
DROP FUNCTION sync_board_climb_reference_membership();
--> statement-breakpoint
DROP TRIGGER trg_sync_deletion_stream_at ON public.sync_deletions;
--> statement-breakpoint
DROP FUNCTION public.stamp_sync_deletion_stream_at();
