-- C7 index cleanup (docs/postgres-query-costs.md): drop indexes that production
-- shows as unused or strictly redundant, about 850 MB in all, and adopt
-- board_climbs_layout_filter_idx into the schema.
--
-- Every drop was checked against prod pg_stat_user_indexes (stats window since
-- the 2026-09-20 PG18 cutover) and pg_get_indexdef, and the repo was grepped for
-- a reader that needs it. What replaces each one:
--   board_climb_stats_ascents_covering_idx / _quality_covering_idx (v1, 497 MB):
--     same leading keys as the v2 indexes from 0122, whose key adds climb_uuid
--     and whose INCLUDE list carries every other v1 column.
--   board_climb_neighbors_rank_idx (256 MB): nothing orders by rank; the read
--     and the refresh deletes filter (board_type, climb_uuid), the PK prefix.
--   board_climb_events_board_confirmed_at_idx: strict prefix of
--     board_climb_events_chronological_idx (18 scans).
--   board_climb_events_board_climb_idx: 0 scans, no reader.
--   board_setter_stats_score_idx: 0 scans; the only reader sorts by
--     COALESCE(setter_score, 0), which this index cannot serve.
--   board_climbs_edges_idx: dropped by 0067 but still in prod (3 scans);
--     board_climbs_search_filter_idx carries the edge columns.
--   board_climbs_characteristics_idx (GIN): 0 scans, no query filters the array.
--   board_climbs_board_type_idx: board_climbs_layout_filter_idx has the same
--     leading column at about the same size.
--   boardsesh_ticks_sync_pending_idx (54 MB): the pending-push count filters
--     user_id + board_type + aurora_id IS NULL, served by
--     boardsesh_ticks_user_board_idx; aurora_id lookups use aurora_id_unique.
--
-- The migrator runs in one transaction, so DROP INDEX CONCURRENTLY is not
-- available here. Take every table lock up front in one retry-protected step
-- (the 0144/0220 shape): a bare DROP INDEX queues for ACCESS EXCLUSIVE behind a
-- long reader and then blocks every reader behind itself. The drops themselves
-- are catalogue-only and finish in milliseconds. IF EXISTS everywhere, because
-- the session owner may already have run DROP INDEX CONCURRENTLY by hand, and
-- several of these never existed on dev databases (0067 dropped them there).
--
-- board_climbs_layout_filter_idx already exists in production (0067 dropped it
-- from the schema but not from prod, where it carries ~560k scans a week), so
-- IF NOT EXISTS makes this a no-op there; it builds the 7 MB index on fresh dev,
-- test and CI databases, where a few seconds of blocked writes do not matter.
DO $$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';
      LOCK TABLE
        "board_climbs",
        "board_climb_stats",
        "board_climb_neighbors",
        "board_climb_events",
        "board_setter_stats",
        "boardsesh_ticks"
      IN ACCESS EXCLUSIVE MODE;
      SET LOCAL lock_timeout = '0';
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempts >= 40 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "board_climbs_board_type_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "boardsesh_ticks_sync_pending_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "board_climb_events_board_confirmed_at_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "board_climb_events_board_climb_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "board_setter_stats_score_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "board_climb_neighbors_rank_idx";--> statement-breakpoint
-- Not in the drizzle schema (custom migrations 0068/0121, 0025, 0135), so
-- generate does not emit these.
DROP INDEX IF EXISTS "board_climb_stats_ascents_covering_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "board_climb_stats_quality_covering_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "board_climbs_edges_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "board_climbs_characteristics_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_climbs_layout_filter_idx" ON "board_climbs" USING btree ("board_type","layout_id","is_listed","is_draft","frames_count");
