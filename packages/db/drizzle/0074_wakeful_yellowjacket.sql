ALTER TABLE "board_climbs" ADD COLUMN "required_set_ids" integer[];--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "compatible_size_ids" integer[];--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;