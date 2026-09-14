-- Spray wall catalogue seed (SW-04, issue #5437).
--
-- A spray wall is a runtime-created catalogue layout, so the per-wall rows land
-- when a climber creates a wall (SW-05). What every wall SHARES is seeded once,
-- here: one product, one hold set, four hold roles, and a grade scale.
--
-- The two id sequences these rows pair with (spray_wall_catalog_id_seq,
-- spray_hold_catalog_id_seq) are declared in the drizzle schema and created by
-- migration 0226, so they are deliberately not repeated here.
--
-- Every statement is idempotent (ON CONFLICT DO NOTHING) so a re-run against a
-- database that already carries the seed is a no-op.

-- The one product every wall's size hangs off. is_listed = false: a spray
-- product is not a board anyone can buy or browse.
INSERT INTO board_products (board_type, id, name, is_listed)
VALUES ('spray', 1, 'Spray wall', false)
ON CONFLICT (board_type, id) DO NOTHING;
--> statement-breakpoint

-- One synthetic hold set. A wall's holds are not shipped in sets a climber
-- installs or removes, so there is nothing for set ids to partition.
INSERT INTO board_sets (board_type, id, name)
VALUES ('spray', 1, 'Holds')
ON CONFLICT (board_type, id) DO NOTHING;
--> statement-breakpoint

-- Hold roles 1-4, matching STATE_TO_PRIMARY_CODE.spray and HOLD_STATE_MAP.spray
-- in packages/board-constants/src/hold-states.ts. The colours are stored in the
-- Aurora catalogue's own '#'-less hex, like every other row of this table. A
-- spray wall has no LEDs and no firmware, so led_color never reaches a wire and
-- the renderer reads HOLD_STATE_MAP rather than these columns; they are carried
-- so a catalogue reader finds a colour per role where it expects one.
INSERT INTO board_placement_roles (board_type, id, product_id, position, name, full_name, led_color, screen_color)
VALUES
  ('spray', 1, 1, 1, 'start',  'Starting Hold', '00FF00', '00DD00'),
  ('spray', 2, 1, 2, 'middle', 'Hand Hold',     '0000FF', '4444FF'),
  ('spray', 3, 1, 3, 'finish', 'Finish Hold',   'FF0000', 'FF0000'),
  ('spray', 4, 1, 4, 'foot',   'Foot Hold',     'FF00FF', 'FF00FF')
ON CONFLICT (board_type, id) DO NOTHING;
--> statement-breakpoint

-- The grade scale. A spray climb carries its setter's grade on the shared
-- Boardsesh difficulty scale (10 = 4a/V0), which is the Tension scale, so the
-- spray rows are a copy of it rather than a second opinion about what 7a means.
-- On a database with no Tension catalogue (a schema-only CI database) fall back
-- to the same scale as BOULDER_GRADES states it in
-- packages/board-constants/src/boulder-grade-mapping.ts, so a spray wall is
-- never left without grades.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM board_difficulty_grades WHERE board_type = 'tension') THEN
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    SELECT 'spray', difficulty, boulder_name, route_name, is_listed
    FROM board_difficulty_grades
    WHERE board_type = 'tension'
    ON CONFLICT (board_type, difficulty) DO NOTHING;
  ELSE
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES
      ('spray', 10, '4a/V0', NULL, true),
      ('spray', 11, '4b/V0', NULL, true),
      ('spray', 12, '4c/V0', NULL, true),
      ('spray', 13, '5a/V1', NULL, true),
      ('spray', 14, '5b/V1', NULL, true),
      ('spray', 15, '5c/V2', NULL, true),
      ('spray', 16, '6a/V3', NULL, true),
      ('spray', 17, '6a+/V3', NULL, true),
      ('spray', 18, '6b/V4', NULL, true),
      ('spray', 19, '6b+/V4', NULL, true),
      ('spray', 20, '6c/V5', NULL, true),
      ('spray', 21, '6c+/V5', NULL, true),
      ('spray', 22, '7a/V6', NULL, true),
      ('spray', 23, '7a+/V7', NULL, true),
      ('spray', 24, '7b/V8', NULL, true),
      ('spray', 25, '7b+/V8', NULL, true),
      ('spray', 26, '7c/V9', NULL, true),
      ('spray', 27, '7c+/V10', NULL, true),
      ('spray', 28, '8a/V11', NULL, true),
      ('spray', 29, '8a+/V12', NULL, true),
      ('spray', 30, '8b/V13', NULL, true),
      ('spray', 31, '8b+/V14', NULL, true),
      ('spray', 32, '8c/V15', NULL, true),
      ('spray', 33, '8c+/V16', NULL, true)
    ON CONFLICT (board_type, difficulty) DO NOTHING;
  END IF;
END $$;
