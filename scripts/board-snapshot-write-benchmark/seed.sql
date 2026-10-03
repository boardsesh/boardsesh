-- Synthetic, repeatable rows for the board snapshot trigger write-path benchmark.
-- Run once per matched disposable PG18 baseline/candidate database.
BEGIN;
INSERT INTO public.board_climbs (uuid, board_type, layout_id, created_at, name)
SELECT 'snapshot-trigger-bench-upsert-climb-' || lpad(series::text, 8, '0'),
       'kilter', 1, '2026-10-03T00:00:00Z', 'snapshot benchmark seed'
FROM generate_series(1, 16000) AS series;
INSERT INTO public.board_climbs (uuid, board_type, layout_id, created_at, name)
SELECT 'snapshot-trigger-bench-delete-climb-' || lpad(series::text, 8, '0'),
       'kilter', 1, '2026-10-03T00:00:00Z', 'snapshot benchmark delete seed'
FROM generate_series(1, 32000) AS series;
INSERT INTO public.board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count)
SELECT 'kilter', 'snapshot-trigger-bench-upsert-climb-' || lpad(series::text, 8, '0'),
       40, 5.0, 1
FROM generate_series(1, 16000) AS series;
INSERT INTO public.board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count)
SELECT 'kilter', 'snapshot-trigger-bench-delete-climb-' || lpad(series::text, 8, '0'),
       40, 5.0, 1
FROM generate_series(1, 32000) AS series;
INSERT INTO public.board_climb_grades
  (board_type, climb_uuid, angle, local_grade, confidence, model_version, coeff_version)
SELECT 'kilter', 'snapshot-trigger-bench-upsert-grade-' || lpad(series::text, 8, '0'),
       40, 5.0, 'confirmed', 'snapshot-bench', 'snapshot-bench'
FROM generate_series(1, 16000) AS series;
COMMIT;
ANALYZE public.board_climbs;
ANALYZE public.board_climb_stats;
ANALYZE public.board_climb_grades;
ANALYZE public.sync_deletions;
