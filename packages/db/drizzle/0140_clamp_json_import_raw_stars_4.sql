-- Migration: Clamp raw out-of-range stars=4 json-import ticks to 5 (follow-up to 0139 / issue #3390).
--
-- Post-deploy verification of 0139 found 6 untouched json-import rows
-- (updated_at <= aurora_synced_at, i.e. never user-edited) at quality = 4.
-- 0139 assumed every row above 3 was user-edited and left 4s alone, but
-- these came from a Kilter export that genuinely contained the out-of-range
-- raw value stars = 4 (single user, one export). The fixed import path
-- clamps stars > 3 to 5 via convertQuality, so rescale these the same way
-- for consistency and to restore the detection invariant: an untouched
-- aurora-synced ascent can only hold quality NULL, 1, 3 or 5.
--
-- Same safety properties as 0139: source-scoped by the 'json-import-'
-- aurora_id prefix, user edits excluded by the updated_at guard, and
-- idempotent (SET updated_at = now() pushes converted rows out of the
-- guard window; quality = 4 is also simply absent after the rewrite).

DO $$
DECLARE
  clamped_count integer;
BEGIN
  UPDATE boardsesh_ticks
  SET
    quality = 5,
    updated_at = now()
  WHERE aurora_type = 'ascents'
    AND aurora_id LIKE 'json-import-%'
    AND quality = 4
    AND aurora_synced_at IS NOT NULL
    AND updated_at <= aurora_synced_at;

  GET DIAGNOSTICS clamped_count = ROW_COUNT;
  RAISE NOTICE 'Clamped % json-imported ticks with raw out-of-range stars=4 to quality 5', clamped_count;
END $$;
