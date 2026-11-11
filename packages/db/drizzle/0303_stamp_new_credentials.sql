-- BA-04 PR 1 (epic #6975): stamps on newly issued credentials. No reader uses
-- them yet. native_generation moves alone when a climber signs out of the app;
-- the four refresh-token columns record the generations, sign-in time and
-- session a refresh family was issued under. Old rows keep NULLs.
--
-- TWO LOCKS ON HOT TABLES: ADD COLUMN takes ACCESS EXCLUSIVE on both tables
-- until the migrator commits, which is the end of the whole pending-migration
-- run. Every native sign-in and refresh writes mobile_refresh_tokens, and every
-- authenticated HTTP request and WebSocket sweep reads auth_subject_cutoffs
-- under a 1 s admission deadline. Both locks are taken up front in one
-- retry-protected step, the guard 0220 and 0302 use, with a 1 s limit on each
-- lock wait to match that deadline. The limit is per table, and the first lock
-- is held while the second is awaited, so a blocked attempt can stall those
-- requests for about 2 s before it backs off. auth_subject_cutoffs is listed
-- first, the order the issuer reaches the two tables in. Deploy this migration alone, so the locks
-- are held for these statements and the commit only. Every refresh-token
-- column is nullable with no default, and native_generation's constant default
-- is stored in the catalog: no table rewrite. The CHECK reads
-- auth_subject_cutoffs, which has no rows until a staged writer mode is on.
DO $stamp_new_credentials_lock$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '1s';
      LOCK TABLE "auth_subject_cutoffs", "mobile_refresh_tokens" IN ACCESS EXCLUSIVE MODE;
      SET LOCAL lock_timeout = '0';
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempts >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $stamp_new_credentials_lock$;
--> statement-breakpoint
ALTER TABLE "mobile_refresh_tokens" ADD COLUMN "subject_generation" integer;--> statement-breakpoint
ALTER TABLE "mobile_refresh_tokens" ADD COLUMN "native_generation" integer;--> statement-breakpoint
ALTER TABLE "mobile_refresh_tokens" ADD COLUMN "authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mobile_refresh_tokens" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "auth_subject_cutoffs" ADD COLUMN "native_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_subject_cutoffs" ADD CONSTRAINT "auth_subject_cutoffs_native_generation" CHECK ("auth_subject_cutoffs"."native_generation" >= 0);
