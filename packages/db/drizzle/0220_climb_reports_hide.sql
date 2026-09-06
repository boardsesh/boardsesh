ALTER TYPE "public"."notification_type" ADD VALUE 'proposal_on_your_climb';--> statement-breakpoint
ALTER TYPE "public"."proposal_type" ADD VALUE 'hide';--> statement-breakpoint
-- Take the board_climbs lock up front in one retry-protected step, the same
-- shape 0144/0146 use. Neither column below rewrites the table (Postgres stores
-- the `false` default in the catalog), but both still take ACCESS EXCLUSIVE on a
-- table every climb page reads: a bare ALTER queues behind one long-running
-- select and then blocks every reader behind itself. Bounded wait, retry.
DO $$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';
      LOCK TABLE "board_climbs" IN ACCESS EXCLUSIVE MODE;
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
ALTER TABLE "board_climbs" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "hidden_at" timestamp;