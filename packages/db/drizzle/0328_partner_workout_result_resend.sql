-- Plain (not CONCURRENTLY) index builds, decided on purpose (docs/db-migrations.md):
-- partner_webhook_outbox is tiny (partner webhooks launched in allowlist mode on
-- 2026-11-17, and relayed rows are pruned after 7 days), and app_workouts holds a
-- few rows. Each build takes milliseconds under its SHARE lock.
--
-- Rollback: revert the code but keep this migration. Once a workout has a second
-- workout.completed row, the old one-per-workout unique index cannot be rebuilt.
CREATE TABLE "partner_workout_result_debounce" (
	"workout_id" text PRIMARY KEY NOT NULL,
	"last_enqueued_at" timestamp with time zone NOT NULL,
	"pending" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
DROP INDEX "partner_webhook_workout_completion_idx";--> statement-breakpoint
ALTER TABLE "partner_workout_result_debounce" ADD CONSTRAINT "partner_workout_result_debounce_workout_id_app_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."app_workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_workouts_finished_user_idx" ON "app_workouts" USING btree ("user_id","completed_at") WHERE "app_workouts"."status" IN ('completed', 'auto_closed');--> statement-breakpoint
CREATE UNIQUE INDEX "partner_webhook_workout_completion_pending_idx" ON "partner_webhook_outbox" USING btree ("workout_id") WHERE "partner_webhook_outbox"."type" = 'workout.completed' AND "partner_webhook_outbox"."relayed_at" IS NULL;