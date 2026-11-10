-- The publisher a partner app names at registration, shown to climbers on the
-- consent screen as "Made by". Nullable: apps registered before this column have
-- none, and the screen then shows no "Made by" line at all.
--
-- ONE LOCK ON AN EXISTING TABLE: ADD COLUMN takes ACCESS EXCLUSIVE on
-- oauth_app_policy until the migrator commits, which is the end of the whole
-- pending-migration run. Everything that touches the table queues behind it:
-- partner requests that read an app's policy (the connection caps, registration)
-- and every account deletion, whose cascade from users reaches this table through
-- owner_user_id and oauth_client. The lock is taken up front in one
-- retry-protected step with a 3 s attempt, the guard the partner tables use, so a
-- blocked attempt stalls those writers for at most 3 s before it backs off. Deploy
-- this migration alone, so the lock is held for this statement and the commit
-- only. A nullable column with no default is a catalog change: no table rewrite,
-- no row is read.
DO $oauth_app_publisher_name_lock$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';
      LOCK TABLE "oauth_app_policy" IN ACCESS EXCLUSIVE MODE;
      SET LOCAL lock_timeout = '0';
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempts >= 40 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $oauth_app_publisher_name_lock$;
--> statement-breakpoint
ALTER TABLE "oauth_app_policy" ADD COLUMN "publisher_name" text;
