-- NOTE: drizzle-kit 0.31 does not parse the object-form check() in
-- ascents.ts (boardsesh_ticks_quality_range, added in 0153). On this generate
-- it mis-parsed the boardsesh_ticks table and cascaded, emitting spurious
-- DROPs of the columns/enum that 0155 added (board_climb_stats.upstream_synced_at,
-- boardsesh_ticks.origin, type tick_origin). Those DROPs were stripped and the
-- 0158 snapshot was rebuilt from 0157 + this table's delta — same manually-managed
-- pattern as 0155. This migration only adds the board_climb_grades sync cursor.
-- Review on every future generate.
ALTER TABLE "board_climb_grades" ADD COLUMN "sync_seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "board_climb_grades_sync_cursor_idx" ON "board_climb_grades" USING btree ("board_type","computed_at","sync_seq");
