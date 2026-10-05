-- Tick climb revisions (#6023): each tick records which revision of the climb
-- it was logged against, and board_climbs carries its current revision and the
-- revision at which its holds last changed.
--
-- board_climbs and boardsesh_ticks are both large and write-hot. All three
-- statements are metadata-only on PG18: a nullable column, and two NOT NULL
-- columns whose default is a constant, so no row is rewritten. No backfill:
-- board_climb_revisions has no rows in production yet (0251 created it), so 1
-- is already right for every climb, and NULL (unknown) for every existing tick.
ALTER TABLE "board_climbs" ADD COLUMN "revision_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "holds_revision_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" ADD COLUMN "climb_revision" integer;