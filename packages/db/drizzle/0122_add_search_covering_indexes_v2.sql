-- v2 covering indexes: promote climb_uuid from INCLUDE to a trailing KEY column so
-- searchClimbs' stats-driven ORDER BY (<sort> DESC NULLS LAST, climb_uuid DESC) is
-- fully satisfied by index order. The v1 indexes (0068/0121) keep climb_uuid as an
-- INCLUDE-only column, so the planner adds an Incremental Sort AND a parallel Gather
-- Merge on top of the covering scan for the hottest query in the app (verified by
-- EXPLAIN on the dev DB). With climb_uuid as a key column the scan is already in final
-- order — no sort, no parallel DSM allocation (the resource PR #1969 fought over).
--
-- The v1 indexes are dropped in a SEPARATE later migration after a prod soak, never in
-- this deploy: while both exist the planner can fall back to v1 instantly if v2
-- misplans, and an app rollback of the ORDER BY change still has its index.
--
-- Drizzle's Postgres migrator wraps migrations in a transaction, so CREATE INDEX
-- CONCURRENTLY is not valid here. If prod table size makes the write lock too long,
-- run a scheduled concurrent build under the identical name/definition first; the
-- IF NOT EXISTS then makes this migration a no-op.
--
-- DESC NULLS LAST is explicit on purpose: Postgres DESC defaults to NULLS FIRST, which
-- would silently produce an index the ORDER BY can't use for ordering.
CREATE INDEX IF NOT EXISTS board_climb_stats_ascents_covering_v2_idx
  ON board_climb_stats (board_type, angle, ascensionist_count DESC NULLS LAST, climb_uuid DESC)
  INCLUDE (display_difficulty, quality_average, difficulty_average, benchmark_difficulty);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS board_climb_stats_quality_covering_v2_idx
  ON board_climb_stats (board_type, angle, quality_average DESC NULLS LAST, climb_uuid DESC)
  INCLUDE (ascensionist_count, display_difficulty, difficulty_average, benchmark_difficulty);
