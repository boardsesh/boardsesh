CREATE TABLE "sync_deletions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"user_id" text,
	"deleted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_climb_stats" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "board_climb_stats" ADD COLUMN "sync_seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "sync_seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist_climbs" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_playlist_pins" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist_follows" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "setter_follows" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_follows" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "sync_deletions_user_since_idx" ON "sync_deletions" USING btree ("user_id","deleted_at","id");--> statement-breakpoint
CREATE INDEX "board_climb_stats_sync_cursor_idx" ON "board_climb_stats" USING btree ("updated_at","sync_seq");--> statement-breakpoint
CREATE INDEX "board_climbs_sync_cursor_idx" ON "board_climbs" USING btree ("updated_at","sync_seq");