-- NOTE: drizzle-kit 0.31 does not parse the object-form check() in
-- ascents.ts, so its diff tried to DROP boardsesh_ticks_quality_range
-- (added in 0153). Statement stripped and the snapshot hand-patched to
-- retain the constraint — same manually-managed pattern as the
-- board_beta_links FKs. Review this on every future generate.
CREATE TYPE "public"."tick_origin" AS ENUM('native', 'aurora_pull', 'kilter_pull', 'json_import');--> statement-breakpoint
ALTER TABLE "board_climb_stats" ADD COLUMN "upstream_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" ADD COLUMN "origin" "tick_origin" DEFAULT 'native' NOT NULL;