ALTER TABLE "app_workouts" DROP CONSTRAINT "app_workouts_session_id_board_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "partner_webhook_outbox" ADD COLUMN "endpoint_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_workouts" ADD CONSTRAINT "app_workouts_session_id_board_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."board_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- On an existing deployment, prebuild this index CONCURRENTLY before deploying
-- this migration (docs/integration-platform.md). Fresh databases build it here.
CREATE INDEX IF NOT EXISTS "logbook_changes_global_position_idx" ON "logbook_changes" USING btree ("txid","seq");
