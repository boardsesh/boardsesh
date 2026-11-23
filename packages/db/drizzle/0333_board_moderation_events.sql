CREATE TYPE "public"."board_moderation_action" AS ENUM('removed_from_gym', 'deleted', 'edited_by_staff', 'relinked');--> statement-breakpoint
CREATE TYPE "public"."board_moderation_actor_role" AS ENUM('board_owner', 'gym_owner', 'gym_admin', 'gym_editor', 'community_leader', 'community_admin', 'global_admin');--> statement-breakpoint
CREATE TABLE "board_moderation_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" bigint NOT NULL,
	"gym_id" bigint,
	"actor_user_id" text,
	"actor_role" "board_moderation_actor_role" NOT NULL,
	"action" "board_moderation_action" NOT NULL,
	"reason" text,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_moderation_events" ADD CONSTRAINT "board_moderation_events_board_id_user_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."user_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_moderation_events" ADD CONSTRAINT "board_moderation_events_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_moderation_events" ADD CONSTRAINT "board_moderation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_moderation_events_board_gym_created_idx" ON "board_moderation_events" USING btree ("board_id","gym_id","created_at" DESC NULLS LAST);