ALTER TYPE "public"."board_moderation_action" ADD VALUE 'setup_changed_by_climber';--> statement-breakpoint
ALTER TYPE "public"."board_moderation_action" ADD VALUE 'setup_change_undone';--> statement-breakpoint
ALTER TYPE "public"."board_moderation_actor_role" ADD VALUE 'climber';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'board_setup_changed_by_climber';--> statement-breakpoint
ALTER TYPE "public"."directory_report_resolver_role" ADD VALUE 'climber';--> statement-breakpoint
ALTER TABLE "directory_notification_context" ADD COLUMN "board_moderation_event_id" bigint;--> statement-breakpoint
ALTER TABLE "directory_report_reporters" ADD COLUMN "suggested_setup" jsonb;--> statement-breakpoint
ALTER TABLE "directory_notification_context" ADD CONSTRAINT "directory_notification_context_board_moderation_event_id_board_moderation_events_id_fk" FOREIGN KEY ("board_moderation_event_id") REFERENCES "public"."board_moderation_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_moderation_events_actor_created_idx" ON "board_moderation_events" USING btree ("actor_user_id","created_at");