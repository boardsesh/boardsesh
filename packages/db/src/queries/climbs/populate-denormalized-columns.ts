import { sql } from 'drizzle-orm';
import { populateMoonBoardRequiredSetIds } from './moonboard-set-ids';

/**
 * A minimal database interface that supports raw SQL execution.
 * Works with any drizzle instance (NeonDatabase, PostgresJsDatabase, etc.)
 */
type ExecutableDb = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

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
 * `compatible_size_ids` — derived by comparing the climb's edge bounding box
 * against all `board_product_sizes` for that board type.
 *
 * MoonBoard takes a separate path: it has no `board_placements`/size data, so we
 * derive `required_set_ids` from the cell -> set map (see
 * populateMoonBoardRequiredSetIds) and skip the edge/size steps.
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
  if (climbUuids.length === 0) return;

  // Woods writes both denormalised columns authoritatively at import time: its
  // `required_set_ids` is always the empty set (one synthetic hold set, so
  // `{} <@ {1}` holds) and its `compatible_size_ids` is the single board size the
  // climb was set on. Neither can be re-derived here — Woods has no
  // `board_placements` and no `board_product_sizes` rows — so running the Aurora
  // path would null out what the importer put there.
  if (boardType === 'woods') return;

  if (boardType === 'moonboard') {
    await populateMoonBoardRequiredSetIds(db, climbUuids);
    return;
  }

  // Drizzle's `sql` template expands a JS array into comma-separated parameters
  // wrapped in parentheses, producing a ROW literal like `($1, $2, $3)` which
  // cannot be cast to `text[]`. Build an explicit `ARRAY[...]` literal instead.
  const uuidsArray = sql`ARRAY[${sql.join(
    climbUuids.map((uuid) => sql`${uuid}`),
    sql`, `,
  )}]::text[]`;

  // The regex 'p(\d+)r' must be written with a doubled backslash in source.
  // A JS string literal silently drops the backslash before unrecognized
  // escapes, so `'p(\d+)r'` becomes `'p(d+)r'` at runtime and matches `pd+r`
  // literally — that's why user-created climbs never got their edges or
  // required_set_ids populated. Doubling it gives PG the expected `p(\d+)r`.
  const holdIdRegex = 'p(\\d+)r';

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
      CROSS JOIN LATERAL regexp_matches(c2.frames, ${holdIdRegex}, 'g') AS m(hold_id_arr)
      JOIN board_placements bp
        ON bp.id = (m.hold_id_arr[1])::int
        AND bp.board_type = c2.board_type
        AND bp.layout_id = c2.layout_id
      JOIN board_holes bh
        ON bh.id = bp.hole_id
        AND bh.board_type = c2.board_type
      WHERE c2.board_type = ${boardType}
        AND c2.uuid = ANY(${uuidsArray})
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
      CROSS JOIN LATERAL regexp_matches(c2.frames, ${holdIdRegex}, 'g') AS m(hold_id_arr)
      JOIN board_placements bp
        ON bp.id = (m.hold_id_arr[1])::int
        AND bp.board_type = c2.board_type
        AND bp.layout_id = c2.layout_id
      WHERE c2.board_type = ${boardType}
        AND c2.uuid = ANY(${uuidsArray})
        AND c2.frames IS NOT NULL
      GROUP BY c2.uuid
    ) sub
    WHERE c.uuid = sub.uuid AND c.board_type = ${boardType}
  `);

  // Step 3: Populate compatible_size_ids from edge comparison
  await db.execute(sql`
    UPDATE board_climbs c SET compatible_size_ids = sub.size_ids
    FROM (
      SELECT c2.uuid,
        ARRAY_AGG(ps.id ORDER BY ps.id) as size_ids
      FROM board_climbs c2
      JOIN board_product_sizes ps
        ON ps.board_type = c2.board_type
        AND c2.edge_left > ps.edge_left
        AND c2.edge_right < ps.edge_right
        AND c2.edge_bottom > ps.edge_bottom
        AND c2.edge_top < ps.edge_top
      WHERE c2.board_type = ${boardType}
        AND c2.uuid = ANY(${uuidsArray})
        AND c2.edge_left IS NOT NULL
      GROUP BY c2.uuid
    ) sub
    WHERE c.uuid = sub.uuid AND c.board_type = ${boardType}
  `);
}
