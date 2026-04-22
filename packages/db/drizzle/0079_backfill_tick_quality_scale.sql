-- Migration: Backfill boardsesh_ticks.quality for rows imported from Aurora.
--
-- Context:
--   Kilter/Tension (Aurora) store user ratings on a 1-3 scale, Boardsesh on 1-5.
--   The previous conversion formula was `ROUND((aurora_q / 3.0) * 5)`, which
--   produced an uneven mapping: Aurora 1 -> 2, 2 -> 3, 3 -> 5 (losing the
--   lowest rating) and could produce values 7 or 8 if Aurora ever returned
--   4 or 5, which violates the 1-5 scale and Zod validation downstream.
--
--   The corrected formula (now in convert-quality.ts) maps endpoints exactly:
--   Aurora 1 -> 1, 2 -> 3, 3 -> 5, with 4/5 clamped to 5.
--
-- What this migration does:
--   Rewrites `quality` in-place for ticks that were synced from the Aurora API
--   or migrated by 0026/0037 (both used the old formula). Only touches rows
--   where `quality` is still one of the distinctive old-formula outputs
--   (2, 7, 8). Values 3 and 5 are already correct under the new formula and
--   do not need to be rewritten.
--
-- Safety:
--   - Scoped to rows with aurora_type = 'ascents' and aurora_id NOT NULL and
--     NOT a 'json-import-' synthetic id. JSON-imported rows were already on
--     the 1-5 scale and must not be touched.
--   - Scoped to rows that have not been modified since the last Aurora sync
--     (updated_at <= aurora_synced_at) so we do not overwrite user edits
--     made via updateTick. The updateTick mutation bumps updated_at but
--     leaves aurora_synced_at unchanged, so any user edit causes
--     updated_at > aurora_synced_at — no tolerance window needed.
--   - Idempotent by design: the WHERE clause filters on quality IN (2, 7, 8),
--     and the corrected output values are 1 and 5 — neither of which appears
--     in that set. A second run therefore matches zero rows and changes nothing.
--   - Deliberately leaves rows with quality = 1 / 4 alone: those values are
--     not producible by the old formula from an integer Aurora input and are
--     most likely user-originated.

DO $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE boardsesh_ticks
  SET
    quality = CASE quality
      WHEN 2 THEN 1  -- was Aurora 1 under old (q/3)*5 rounding
      WHEN 7 THEN 5  -- was Aurora 4, clamp to 5
      WHEN 8 THEN 5  -- was Aurora 5, clamp to 5
      ELSE quality
    END,
    updated_at = now()
  WHERE aurora_type = 'ascents'
    AND aurora_id IS NOT NULL
    AND aurora_id NOT LIKE 'json-import-%'
    AND quality IN (2, 7, 8)
    AND aurora_synced_at IS NOT NULL
    AND updated_at <= aurora_synced_at;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE 'Backfilled % boardsesh_ticks rows with corrected quality scale', updated_count;
END $$;
