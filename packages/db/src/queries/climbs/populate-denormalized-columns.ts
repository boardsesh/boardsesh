import { sql } from 'drizzle-orm';

/**
 * A minimal database interface that supports raw SQL execution.
 * Works with any drizzle instance (NeonDatabase, PostgresJsDatabase, etc.)
 */
interface ExecutableDb {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

/**
 * Populate the denormalized `required_set_ids` and `compatible_size_ids` columns
 * on `board_climbs` for the given climb UUIDs.
 *
 * Also computes missing edge values (edge_left/right/bottom/top) from hold
 * positions when they are NULL, which is the case for locally created climbs.
 *
 * `required_set_ids` — derived by parsing hold IDs from the `frames` column
 * (format: `p{holdId}r{roleCode}...`) and looking up each hold's set_id in
 * `board_placements`. This works regardless of whether `board_climb_holds` has
 * been populated.
 *
 * `compatible_size_ids` — derived by checking, for each product size, that
 * every placement referenced by the climb's frames has an entry in
 * `board_leds` for that size. An edge bounding-box check is not sufficient:
 * a climb can fit within a board's edges while still referencing holes that
 * have no LED mapping on that specific product size (e.g. a hold from a set
 * that isn't LED-equipped on smaller boards). LED coverage matches the
 * `getAuroraBluetoothPacket` check in the bluetooth code, so the search
 * filter and the BLE sender agree on which climbs a board can light up.
 *
 * MoonBoard climbs are skipped (they have no set or size data).
 *
 * @param db A drizzle database or transaction instance
 * @param boardType The board type (e.g. 'kilter', 'tension')
 * @param climbUuids The UUIDs of climbs to update
 */
export async function populateDenormalizedColumns(
  db: ExecutableDb,
  boardType: string,
  climbUuids: string[],
): Promise<void> {
  if (climbUuids.length === 0 || boardType === 'moonboard') return;

  // Step 1: Compute missing edge values from hold positions.
  // Locally created climbs don't have edges set, but we can derive them from
  // the hold IDs in the frames string -> placements -> holes (x, y).
  await db.execute(sql`
    UPDATE board_climbs c
    SET edge_left = sub.min_x,
        edge_right = sub.max_x,
        edge_bottom = sub.min_y,
        edge_top = sub.max_y
    FROM (
      SELECT c2.uuid,
        MIN(bh.x) as min_x, MAX(bh.x) as max_x,
        MIN(bh.y) as min_y, MAX(bh.y) as max_y
      FROM board_climbs c2
      CROSS JOIN LATERAL regexp_matches(c2.frames, 'p(\d+)r', 'g') AS m(hold_id_arr)
      JOIN board_placements bp
        ON bp.id = (m.hold_id_arr[1])::int
        AND bp.board_type = c2.board_type
        AND bp.layout_id = c2.layout_id
      JOIN board_holes bh
        ON bh.id = bp.hole_id
        AND bh.board_type = c2.board_type
      WHERE c2.board_type = ${boardType}
        AND c2.uuid = ANY(${climbUuids}::text[])
        AND c2.edge_left IS NULL
        AND c2.frames IS NOT NULL
      GROUP BY c2.uuid
    ) sub
    WHERE c.uuid = sub.uuid AND c.board_type = ${boardType}
  `);

  // Step 2: Populate required_set_ids by extracting hold IDs from the frames
  // string and joining against board_placements to find which sets are needed.
  // The frames format is "p{holdId}r{roleCode}p{holdId}r{roleCode}..."
  // regexp_matches with 'g' flag extracts all hold IDs.
  await db.execute(sql`
    UPDATE board_climbs c SET required_set_ids = sub.sets
    FROM (
      SELECT c2.uuid,
        ARRAY_AGG(DISTINCT bp.set_id ORDER BY bp.set_id) as sets
      FROM board_climbs c2
      CROSS JOIN LATERAL regexp_matches(c2.frames, 'p(\d+)r', 'g') AS m(hold_id_arr)
      JOIN board_placements bp
        ON bp.id = (m.hold_id_arr[1])::int
        AND bp.board_type = c2.board_type
        AND bp.layout_id = c2.layout_id
      WHERE c2.board_type = ${boardType}
        AND c2.uuid = ANY(${climbUuids}::text[])
        AND c2.frames IS NOT NULL
      GROUP BY c2.uuid
    ) sub
    WHERE c.uuid = sub.uuid AND c.board_type = ${boardType}
  `);

  // Step 3: Populate compatible_size_ids from LED coverage.
  // A climb is compatible with a product size iff every placement referenced
  // in its frames has a row in board_leds for that product size. We compute
  // this with two CTEs:
  //   - led_mapped_placements: for each (layout, product_size), the full set
  //     of placement IDs that can be lit. Joins board_placements to board_leds
  //     via hole_id.
  //   - climb_placements: for each climb, the distinct placement IDs it needs,
  //     parsed from frames (format: "p{placementId}r{roleCode}...").
  // Then the climb's required_placement_ids must be contained (<@) within the
  // (layout, size)'s LED-mapped placement set for that size to qualify.
  // COALESCE handles climbs that don't fit any size (empty array, not NULL).
  await db.execute(sql`
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
      WHERE bp.board_type = ${boardType}
      GROUP BY bp.board_type, bp.layout_id, bl.product_size_id
    ),
    climb_placements AS (
      SELECT
        c2.uuid,
        c2.board_type,
        c2.layout_id,
        ARRAY_AGG(DISTINCT (m.hold_id_arr[1])::int) AS required_placement_ids
      FROM board_climbs c2
      CROSS JOIN LATERAL regexp_matches(c2.frames, 'p(\d+)r', 'g') AS m(hold_id_arr)
      WHERE c2.board_type = ${boardType}
        AND c2.uuid = ANY(${climbUuids}::text[])
        AND c2.frames IS NOT NULL
      GROUP BY c2.uuid, c2.board_type, c2.layout_id
    ),
    climb_compatible_sizes AS (
      SELECT
        cp.uuid,
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
      GROUP BY cp.uuid
    )
    UPDATE board_climbs c
    SET compatible_size_ids = ccs.size_ids
    FROM climb_compatible_sizes ccs
    WHERE c.uuid = ccs.uuid
      AND c.board_type = ${boardType}
  `);
}
