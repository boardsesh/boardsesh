-- MoonBoard grade lookup previously capped at 8b+/V14 (difficulty=31), so the
-- catalog importer had no shared difficulty id for 8C/8C+ problems and wrote
-- them in with a NULL grade (see moonboard-helpers.ts MOONBOARD_GRADE_TO_DIFFICULTY).
-- Additive: adds the two missing rows following the 0088 seed pattern.
INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
VALUES
  ('moonboard', 32, '8c/V15', NULL, true),
  ('moonboard', 33, '8c+/V16', NULL, true)
ON CONFLICT (board_type, difficulty)
DO UPDATE SET
  boulder_name = EXCLUDED.boulder_name,
  route_name = EXCLUDED.route_name,
  is_listed = EXCLUDED.is_listed;
