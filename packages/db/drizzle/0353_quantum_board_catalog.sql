-- Production prerequisite: board_climbs is write-hot. Outside the migrator's
-- transaction, add the nullable column and build the unique index concurrently:
-- ALTER TABLE "board_climbs" ADD COLUMN IF NOT EXISTS "controller_route_uuid" text;
-- CREATE UNIQUE INDEX CONCURRENTLY "board_climbs_controller_route_uuid_idx"
--   ON "board_climbs" USING btree ("board_type", "layout_id", "controller_route_uuid")
--   WHERE "controller_route_uuid" IS NOT NULL;
-- Verify pg_index.indisvalid before deployment; an INVALID index must be dropped
-- concurrently and rebuilt before proceeding. IF NOT EXISTS below makes the
-- migrator skip the completed production build while fresh test/dev DBs build it.
-- See docs/operations/db-migrations.md, "Indexes on a large, write-hot table".
ALTER TABLE "board_climbs" ADD COLUMN IF NOT EXISTS "controller_route_uuid" text;--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "source_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "board_shared_syncs" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "board_climbs_controller_route_uuid_idx" ON "board_climbs" USING btree ("board_type","layout_id","controller_route_uuid") WHERE "board_climbs"."controller_route_uuid" IS NOT NULL;
