-- Recompute board_climbs.compatible_size_ids from LED coverage instead of the
-- edge-containment heuristic introduced in 0073.
--
-- The edge-based check filters by bounding box only, so a climb can "fit" a
-- product size yet reference placements whose holes have no board_leds entry
-- for that size. Sending such a climb to the board then throws from
-- getAuroraBluetoothPacket: "N of M placements have no LED mapping for this
-- board configuration". The search filter must agree with the bluetooth code
-- about which climbs the connected board can actually light up.
--
-- New semantics: a climb is compatible with a product size iff every
-- placement referenced in its frames has a row in board_leds for that size.
-- Same query shape as populate-denormalized-columns.ts so one-off sync and
-- this backfill stay in sync.

WITH led_mapped_placements AS (
  SELECT
    bp.board_type,
    bp.layout_id,
    bl.product_size_id,
    ARRAY_AGG(DISTINCT bp.id ORDER BY bp.id) AS placement_ids
  FROM board_placements bp
  JOIN board_leds bl
    ON bl.board_type = bp.board_type
    AND bl.hole_id = bp.hole_id
  WHERE bp.board_type != 'moonboard'
  GROUP BY bp.board_type, bp.layout_id, bl.product_size_id
),
climb_placements AS (
  SELECT
    c.uuid,
    c.board_type,
    c.layout_id,
    ARRAY_AGG(DISTINCT (m.hold_id_arr[1])::int) AS required_placement_ids
  FROM board_climbs c
  CROSS JOIN LATERAL regexp_matches(c.frames, 'p(\d+)r', 'g') AS m(hold_id_arr)
  WHERE c.board_type != 'moonboard'
    AND c.frames IS NOT NULL
  GROUP BY c.uuid, c.board_type, c.layout_id
),
climb_compatible_sizes AS (
  SELECT
    cp.uuid,
    cp.board_type,
    COALESCE(
      ARRAY_AGG(lmp.product_size_id ORDER BY lmp.product_size_id) FILTER (
        WHERE cp.required_placement_ids <@ lmp.placement_ids
      ),
      ARRAY[]::int[]
    ) AS size_ids
  FROM climb_placements cp
  LEFT JOIN led_mapped_placements lmp
    ON lmp.board_type = cp.board_type
    AND lmp.layout_id = cp.layout_id
  GROUP BY cp.uuid, cp.board_type
)
UPDATE board_climbs c
SET compatible_size_ids = ccs.size_ids
FROM climb_compatible_sizes ccs
WHERE c.uuid = ccs.uuid
  AND c.board_type = ccs.board_type;
