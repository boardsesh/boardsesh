CREATE TYPE "public"."session_origin" AS ENUM('explicit', 'inferred');--> statement-breakpoint
ALTER TABLE "board_sessions" ALTER COLUMN "board_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "board_sessions" ADD COLUMN "origin" "session_origin" DEFAULT 'explicit' NOT NULL;--> statement-breakpoint
ALTER TABLE "board_sessions" ADD COLUMN "anchor_tick_id" bigint;--> statement-breakpoint
ALTER TABLE "board_sessions" ADD COLUMN "user_edited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "board_sessions_user_origin_idx" ON "board_sessions" USING btree ("created_by_user_id","origin");--> statement-breakpoint
CREATE INDEX "board_sessions_anchor_tick_idx" ON "board_sessions" USING btree ("anchor_tick_id");