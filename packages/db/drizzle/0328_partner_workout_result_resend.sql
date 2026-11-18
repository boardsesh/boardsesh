CREATE TABLE "partner_workout_result_debounce" (
	"workout_id" text PRIMARY KEY NOT NULL,
	"last_enqueued_at" timestamp with time zone NOT NULL,
	"pending" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
DROP INDEX "partner_webhook_workout_completion_idx";--> statement-breakpoint
ALTER TABLE "partner_workout_result_debounce" ADD CONSTRAINT "partner_workout_result_debounce_workout_id_app_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."app_workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_webhook_workout_completion_pending_idx" ON "partner_webhook_outbox" USING btree ("workout_id") WHERE "partner_webhook_outbox"."type" = 'workout.completed' AND "partner_webhook_outbox"."relayed_at" IS NULL;