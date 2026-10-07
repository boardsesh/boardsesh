-- Moon Climbing converts 6A to V2; the shared (Aurora) table says 6a/V3, so
-- MoonBoard 6A problems read V3 next to 6A+ (also V3). Relabel only: ids stay,
-- so ticks, filters and stats are untouched. Mirrors MOONBOARD_BOULDER_GRADES.
UPDATE board_difficulty_grades
SET boulder_name = '6a/V2'
WHERE board_type = 'moonboard'
  AND difficulty = 16;--> statement-breakpoint

-- Moon's scale is 5+, 6A, 6A+ …, with no 5b or 5c. Listing them put a second V1
-- and an empty V2 on the MoonBoard grade rail. The rows stay so a community
-- grade average that rounds onto 14/15 still has a label.
UPDATE board_difficulty_grades
SET is_listed = false
WHERE board_type = 'moonboard'
  AND difficulty IN (14, 15);
