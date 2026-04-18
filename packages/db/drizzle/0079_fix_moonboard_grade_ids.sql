-- Fix MoonBoard grade IDs in board_difficulty_grades to align with BOULDER_GRADES.
--
-- Migration 0025 seeded MoonBoard grades with IDs 10–25 (6A=10, 6A+=11, ...),
-- but the frontend uses BOULDER_GRADES which maps 6A=16, 6A+=17, etc.
-- This mismatch causes every MoonBoard grade to display 6 grades too hard.
--
-- Fix: delete old rows (IDs 10–25), insert corrected rows (IDs 13–31),
-- and shift existing board_climb_stats difficulty values by +6.

-- Step 1: Delete the incorrectly-mapped MoonBoard grade rows
DELETE FROM board_difficulty_grades WHERE board_type = 'moonboard';

-- Step 2: Insert with IDs matching BOULDER_GRADES in board-data.ts
-- These IDs are shared across all boards for consistency.
INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, is_listed) VALUES
  ('moonboard', 13, '5+', true),
  ('moonboard', 14, '5B', true),
  ('moonboard', 15, '5C', true),
  ('moonboard', 16, '6A', true),
  ('moonboard', 17, '6A+', true),
  ('moonboard', 18, '6B', true),
  ('moonboard', 19, '6B+', true),
  ('moonboard', 20, '6C', true),
  ('moonboard', 21, '6C+', true),
  ('moonboard', 22, '7A', true),
  ('moonboard', 23, '7A+', true),
  ('moonboard', 24, '7B', true),
  ('moonboard', 25, '7B+', true),
  ('moonboard', 26, '7C', true),
  ('moonboard', 27, '7C+', true),
  ('moonboard', 28, '8A', true),
  ('moonboard', 29, '8A+', true),
  ('moonboard', 30, '8B', true),
  ('moonboard', 31, '8B+', true)
ON CONFLICT (board_type, difficulty) DO UPDATE SET boulder_name = EXCLUDED.boulder_name, is_listed = EXCLUDED.is_listed;

-- Step 3: Shift existing board_climb_stats difficulty values for MoonBoard.
-- Old mapping used IDs 10–25; new mapping uses IDs 16–31 (shift +6).
-- Only shift values in the old range to avoid double-shifting.
UPDATE board_climb_stats
SET display_difficulty = display_difficulty + 6
WHERE board_type = 'moonboard' AND display_difficulty BETWEEN 10 AND 25;

UPDATE board_climb_stats
SET benchmark_difficulty = benchmark_difficulty + 6
WHERE board_type = 'moonboard' AND benchmark_difficulty BETWEEN 10 AND 25;

UPDATE board_climb_stats
SET difficulty_average = difficulty_average + 6
WHERE board_type = 'moonboard' AND difficulty_average BETWEEN 10 AND 25;
