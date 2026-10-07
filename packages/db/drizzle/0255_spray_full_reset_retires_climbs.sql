ALTER TABLE "board_climbs" ADD COLUMN "retired_by_reset" boolean;--> statement-breakpoint
ALTER TABLE "spray_wall_versions" ADD COLUMN "is_full_reset" boolean DEFAULT false NOT NULL;