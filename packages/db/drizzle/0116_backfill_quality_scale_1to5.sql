-- Custom SQL migration file, put your code below! --
--
-- One-time backfill: convert board_climb_stats.quality_average from Aurora's
-- 1-3 scale to the canonical 1-5 scale (×5/3), and stamp quality_normalized so
-- it can never double-apply.
--
-- Context: Aurora (kilterboardapp.com / tensionboardapp etc.) reports user
-- quality on 1-3; Kilter Grips, MoonBoard, and Boardsesh ticks are already 1-5.
-- aurora-sync now normalises on write (normalizeQualityTo5), but every row that
-- was synced BEFORE that change is still stored on 1-3 — that's why the app
-- shows 1-3 stars. This brings the whole column onto one scale in a single,
-- idempotent pass.
--
-- Idempotency: every UPDATE is guarded by quality_normalized = false and sets
-- it true, so re-running is a no-op. The write paths (aurora-sync upsert,
-- kilter catalog-sync, the tick recompute) also set quality_normalized, so rows
-- touched after this migration are never re-scaled.
--
-- Scope of the ×5/3 conversion (Aurora-sourced 1-3 rows only):
--   * Aurora-scale boards: kilter, tension, decoy, soill, touchstone, grasshopper.
--     (MoonBoard quality is native 1-5 — excluded.)
--   * Excludes Kilter Grips-touched rows (kilter_ascensionist_count > 0) — those
--     are native 1-5 from the Grips catalog pull.
--   * Excludes Boardsesh-owned climbs (board_climbs.user_id IS NOT NULL) — their
--     quality comes from boardsesh_ticks on 1-5.
--
-- NOTE: assumes the conversion has NOT already been applied out-of-band. If an
-- environment ran the old manual `quality_average * 5/3` SQL from
-- docs/kilter-sync.md, mark those rows normalized first so this migration skips
-- them (see docs); otherwise they would be scaled twice.

-- 1. Scale the Aurora-sourced 1-3 rows to 1-5 and mark them normalized.
UPDATE board_climb_stats s
   SET quality_average  = s.quality_average * 5.0 / 3.0,
       quality_normalized = TRUE
 WHERE s.quality_normalized = FALSE
   AND s.quality_average IS NOT NULL
   AND s.quality_average > 0
   -- Genuine 1-3 values only: anything already > 3 is on 1-5 (e.g. a Boardsesh-
   -- owned climb), so the ×5/3 can never push a value past 5. Verified on prod:
   -- the only kilter rows > 3 are Boardsesh-owned (also excluded below).
   AND s.quality_average <= 3.0
   AND s.board_type IN ('kilter', 'tension', 'decoy', 'soill', 'touchstone', 'grasshopper')
   AND COALESCE(s.kilter_ascensionist_count, 0) = 0
   AND NOT EXISTS (
     SELECT 1 FROM board_climbs bc
      WHERE bc.board_type = s.board_type
        AND bc.uuid       = s.climb_uuid
        AND bc.user_id IS NOT NULL
   );

-- 2. Everything else is already on 1-5 (MoonBoard, Kilter Grips-native,
--    Boardsesh-owned, or has no quality at all) — mark normalized without
--    changing the value so future writes/backfills skip it.
UPDATE board_climb_stats
   SET quality_normalized = TRUE
 WHERE quality_normalized = FALSE;
