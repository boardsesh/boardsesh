-- Binds every logbook snapshot to its partner connection: deleting an
-- oauth_connections row (its app deleted, or the climber's account) now takes
-- the connection's snapshots and their chunks with it. L3 left the column
-- without a foreign key because oauth_connections was not in its stack yet.
--
-- TWO LOCKS ON EXISTING TABLES: adding the key takes SHARE ROW EXCLUSIVE on
-- oauth_connections and logbook_snapshots until the migrator commits, which is
-- the end of the whole pending-migration run. On oauth_connections that queues
-- every partner writer, including the password-reset trigger
-- (partner_revoke_user), behind the migration. Both are taken up front in one
-- retry-protected step with a 3 s attempt, the guard the partner tables use, so
-- a blocked attempt stalls those writers for at most 3 s before it backs off.
-- Deploy this migration alone. logbook_snapshots is empty until the logbook
-- routes leave PARTNER_OAUTH_MODE=off, so validating the key reads nothing.
DO $logbook_snapshot_connection_locks$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';
      LOCK TABLE "oauth_connections", "logbook_snapshots" IN SHARE ROW EXCLUSIVE MODE;
      SET LOCAL lock_timeout = '0';
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempts >= 40 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $logbook_snapshot_connection_locks$;
--> statement-breakpoint
ALTER TABLE "logbook_snapshots" ADD CONSTRAINT "logbook_snapshots_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE cascade ON UPDATE no action;
