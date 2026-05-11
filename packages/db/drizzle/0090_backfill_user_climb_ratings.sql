-- Migration: Backfill user_climb_qualities and user_climb_grades from boardsesh_ticks.
--
-- Context:
--   These projection tables expose each user's "current opinion" of a climb's
--   quality and grade. Historically that opinion was implicit in
--   boardsesh_ticks.quality / .difficulty on the most-recent tick, which is
--   too expensive to compute at search time. Going forward, ticks/* mutations
--   and aurora-sync upsert into these tables. This migration seeds them once
--   from existing tick history.
--
-- Rules:
--   - Quality: one row per (user_id, board_type, climb_uuid). Angle is intentionally
--     ignored — a user has one quality opinion per climb, regardless of which
--     angle they last logged it at.
--   - Grade: one row per (user_id, board_type, climb_uuid, angle). Grades are
--     angle-specific.
--   - "Most recent" = highest climbed_at, tiebroken by highest tick id.
--
-- Safety:
--   - ON CONFLICT ... DO UPDATE ... WHERE EXCLUDED.updated_at >= existing.updated_at
--     means re-running the migration (or running it after the new write path
--     has populated some rows) never overwrites newer projection data with
--     older tick data. `>=` matches the live-write helpers in
--     packages/db/src/queries/user-climb-ratings.ts and aurora-sync.
--   - Only ticks where quality / difficulty is non-null contribute. Pure
--     attempt rows have nulls and are skipped.
--   - Grade backfill also filters `angle > 0` — bogus Aurora payloads where
--     `null` / "" coerced to `0` aren't valid Kilter/Tension angles. Mirrors
--     the live-write guard in aurora-sync.

DO $$
DECLARE
  qualities_count integer;
  grades_count integer;
BEGIN
  -- Quality projection
  INSERT INTO user_climb_qualities (user_id, board_type, climb_uuid, quality, updated_at)
  SELECT DISTINCT ON (user_id, board_type, climb_uuid)
    user_id, board_type, climb_uuid, quality, climbed_at
  FROM boardsesh_ticks
  WHERE quality IS NOT NULL
  ORDER BY user_id, board_type, climb_uuid, climbed_at DESC, id DESC
  ON CONFLICT (user_id, board_type, climb_uuid) DO UPDATE
    SET quality = EXCLUDED.quality,
        updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.updated_at >= user_climb_qualities.updated_at;

  GET DIAGNOSTICS qualities_count = ROW_COUNT;
  RAISE NOTICE 'Backfilled % user_climb_qualities rows', qualities_count;

  -- Grade projection
  INSERT INTO user_climb_grades (user_id, board_type, climb_uuid, angle, difficulty, updated_at)
  SELECT DISTINCT ON (user_id, board_type, climb_uuid, angle)
    user_id, board_type, climb_uuid, angle, difficulty, climbed_at
  FROM boardsesh_ticks
  WHERE difficulty IS NOT NULL
    AND angle > 0
  ORDER BY user_id, board_type, climb_uuid, angle, climbed_at DESC, id DESC
  ON CONFLICT (user_id, board_type, climb_uuid, angle) DO UPDATE
    SET difficulty = EXCLUDED.difficulty,
        updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.updated_at >= user_climb_grades.updated_at;

  GET DIAGNOSTICS grades_count = ROW_COUNT;
  RAISE NOTICE 'Backfilled % user_climb_grades rows', grades_count;
END $$;
