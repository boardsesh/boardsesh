-- Temporary snapshots behind the partner logbook bootstrap
-- (docs/integration-platform.md, "Complete bootstrap and transition"). Two new
-- empty tables; nothing reads them yet.
--
-- ONE LOCK ON AN EXISTING TABLE: adding the foreign key to "users" takes SHARE
-- ROW EXCLUSIVE on it until the migrator commits, which is the end of the whole
-- pending-migration run, and a waiter makes every later users write queue behind
-- it. Taken up front in one retry-protected step (the pattern from 0144) with a
-- 1 s attempt, so a blocked attempt stalls user writes for at most 1 s before it
-- backs off and lets them through. Keep slow migrations out of the release that
-- carries this one.
--
-- connection_id deliberately has no foreign key: oauth_connections lands with
-- the partner OAuth schema (#7361), which is not in this stack. That rebase adds
-- connection_id -> oauth_connections(id) ON DELETE CASCADE with the 3 s guard.
DO $logbook_snapshot_locks$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '1s';
      LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE;
      SET LOCAL lock_timeout = '0';
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempts >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $logbook_snapshot_locks$;
--> statement-breakpoint
CREATE TABLE "logbook_snapshot_chunks" (
	"snapshot_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"ticks" jsonb NOT NULL,
	CONSTRAINT "logbook_snapshot_chunks_snapshot_id_chunk_index_pk" PRIMARY KEY("snapshot_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "logbook_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"feed_generation" uuid NOT NULL,
	"horizon_txid" "xid8" NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"tick_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"next_updated_at" timestamp,
	"next_tick_id" bigint,
	"chunk_timeout_streak" integer DEFAULT 0 NOT NULL,
	"retry_not_before" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "logbook_snapshot_chunks" ADD CONSTRAINT "logbook_snapshot_chunks_snapshot_id_logbook_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."logbook_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logbook_snapshots" ADD CONSTRAINT "logbook_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "logbook_snapshots_one_build_per_connection_idx" ON "logbook_snapshots" USING btree ("connection_id") WHERE "status" = 'building';--> statement-breakpoint
CREATE INDEX "logbook_snapshots_connection_id_idx" ON "logbook_snapshots" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "logbook_snapshots_user_id_idx" ON "logbook_snapshots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "logbook_snapshots_expires_at_idx" ON "logbook_snapshots" USING btree ("expires_at");