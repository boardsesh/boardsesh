ALTER TABLE "gym_activity_stats" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_board_activity" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qa_verdicts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hold_outline_overrides" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "gym_activity_stats" CASCADE;--> statement-breakpoint
DROP TABLE "user_board_activity" CASCADE;--> statement-breakpoint
DROP TABLE "qa_verdicts" CASCADE;--> statement-breakpoint
DROP TABLE "hold_outline_overrides" CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."notification_type";--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('new_follower', 'comment_reply', 'comment_on_tick', 'comment_on_climb', 'vote_on_tick', 'vote_on_comment', 'new_climb', 'new_climb_global', 'proposal_approved', 'proposal_rejected', 'proposal_vote', 'proposal_created', 'new_climbs_synced', 'gym_claim_approved');--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "type" SET DATA TYPE "public"."notification_type" USING "type"::"public"."notification_type";--> statement-breakpoint
ALTER TABLE "climb_proposals" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."proposal_type";--> statement-breakpoint
CREATE TYPE "public"."proposal_type" AS ENUM('grade', 'classic', 'benchmark');--> statement-breakpoint
ALTER TABLE "climb_proposals" ALTER COLUMN "type" SET DATA TYPE "public"."proposal_type" USING "type"::"public"."proposal_type";--> statement-breakpoint
DROP INDEX "board_user_mapping_username_idx";--> statement-breakpoint
DROP INDEX "board_sessions_user_origin_idx";--> statement-breakpoint
DROP INDEX "board_sessions_anchor_tick_idx";--> statement-breakpoint
DROP INDEX "location_sync_gym_sources_crawl_order_idx";--> statement-breakpoint
DROP INDEX "user_boards_unique_owner_serial";--> statement-breakpoint
DROP INDEX "user_board_serials_unique_user_serial";--> statement-breakpoint
ALTER TABLE "board_sessions" ALTER COLUMN "board_path" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_boards" ADD COLUMN "has_leds" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_boards_unique_owner_serial" ON "user_boards" USING btree ("owner_id","serial_number") WHERE "user_boards"."serial_number" IS NOT NULL AND "user_boards"."serial_number" <> '' AND "user_boards"."deleted_at" IS NULL AND "user_boards"."owner_id" != '00000000-0000-0000-0000-000000000000';--> statement-breakpoint
CREATE UNIQUE INDEX "user_board_serials_unique_user_serial" ON "user_board_serials" USING btree ("user_id","serial_number");--> statement-breakpoint
ALTER TABLE "board_climb_stats" DROP COLUMN "tick_graded_at";--> statement-breakpoint
ALTER TABLE "board_climbs" DROP COLUMN "is_hidden";--> statement-breakpoint
ALTER TABLE "board_climbs" DROP COLUMN "hidden_at";--> statement-breakpoint
ALTER TABLE "board_sessions" DROP COLUMN "origin";--> statement-breakpoint
ALTER TABLE "board_sessions" DROP COLUMN "anchor_tick_id";--> statement-breakpoint
ALTER TABLE "board_sessions" DROP COLUMN "user_edited";--> statement-breakpoint
ALTER TABLE "app_feedback" DROP COLUMN "screenshot_keys";--> statement-breakpoint
ALTER TABLE "location_sync_gym_sources" DROP COLUMN "walls_crawled_at";--> statement-breakpoint
DROP TYPE "public"."session_origin";--> statement-breakpoint
DROP TYPE "public"."qa_verdict_kind";--> statement-breakpoint
DROP TYPE "public"."hold_outline_kind";