-- Index for the wall-kiosk "recent senders" byline (boardClimbRecentSenders),
-- which pins board_id + climb_uuid + angle + status on every kiosk stats
-- refresh. Without it those predicates fall to a heap filter over every tick
-- ever logged on the board.
--
-- Drizzle's Postgres migrator wraps migrations in a transaction, so
-- CREATE INDEX CONCURRENTLY is not valid here (same constraint as
-- 0121_add_quality_search_covering_index). boardsesh_ticks is large and
-- write-hot in production: build the index concurrently out-of-band there
-- first, and this migration is then the idempotent dev/test parity no-op.
-- Full pattern: docs/db-migrations.md, "Indexes on a large, write-hot table".
CREATE INDEX IF NOT EXISTS "boardsesh_ticks_board_climb_senders_idx"
  ON "boardsesh_ticks" USING btree ("board_id","climb_uuid","angle","status");
