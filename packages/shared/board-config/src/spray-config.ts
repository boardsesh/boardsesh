// Spray wall configuration.
//
// A spray wall is not a catalogue board. It is a climber's own wall,
// photographed, with its holds detected and corrected by hand — so unlike
// Kilter (an Aurora sync) or Woods (a decompiled app), there is nothing to
// hard-code here except the identity every wall shares.
//
// The identity mapping, and the reason each piece is a single global constant:
//
//   product   1  — every wall. `board_products` exists to group product sizes
//                  under a manufacturer's board model, and spray walls have no
//                  models.
//   set       1  — "Holds", every wall. A wall's holds are not shipped in sets a
//                  climber installs or removes, so there is nothing for set ids
//                  to partition. One synthetic set, the way Woods ships one.
//   roles   1-4  — STARTING / HAND / FINISH / FOOT, matching
//                  `STATE_TO_PRIMARY_CODE.spray`.
//   layout    per wall, created at runtime. One `board_layouts` row per wall.
//   size      per wall, and its id EQUALS the layout id. A wall has exactly one
//                  size — itself — so a second id space would only ever hold the
//                  same number twice.
//
// The wall VERSION is deliberately absent from all of this: a reset makes new
// `spray_wall_versions` / `spray_wall_holds` rows, never a new layout or size,
// so every climb ever set on the wall keeps pointing at the same
// `(board_type, layout_id)` partition and stays findable.
//
// Rows for any of it land in SW-04; this file is the shape they must take.

import type { Angle } from './types';

/** The one `board_products` row every spray wall's size belongs to. */
export const SPRAY_PRODUCT_ID = 1;

/** The one synthetic hold set every spray wall and spray climb carries. */
export const SPRAY_SET = { id: 1, name: 'Holds' } as const;

/** `SPRAY_SET` as the id list a board config / render config wants. */
export const SPRAY_SET_IDS: readonly number[] = [SPRAY_SET.id];

/**
 * Hold role codes, mirroring `STATE_TO_PRIMARY_CODE.spray`. Named here so the
 * wall editor and the create-climb flow can read a role without importing the
 * board-wide frames table.
 */
export const SPRAY_ROLE = {
  STARTING: 1,
  HAND: 2,
  FINISH: 3,
  FOOT: 4,
} as const;

/**
 * The angles a spray wall can be set at.
 *
 * A wall's angle is fixed at creation (the epic's "Not changed" row: stats are
 * keyed by angle and a wall does not adjust), so this is the list the create
 * flow offers once — not a rail the climber flips through afterwards. Same 0-70
 * in 5° steps as the Aurora boards, because that is the range a home wall is
 * actually built at.
 */
export const SPRAY_ANGLES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70] as const satisfies readonly Angle[];

/**
 * How many walls one climber may own.
 *
 * Every wall costs a private-bucket photo per version and a catalogue layout
 * row, so this is a storage bound, not a product opinion. Ten is well past what
 * a home climber or a gym needs and low enough that a scripted account cannot
 * fill the bucket.
 */
export const MAX_SPRAY_WALLS_PER_USER = 10;

/**
 * Holds on one wall. A dense commercial spray wall runs 400-800 holds; 1500
 * leaves room for the densest real wall while bounding what a detector run, a
 * hold editor session and a reset match have to hold in memory at once.
 */
export const MAX_HOLDS_PER_WALL = 1500;

/**
 * Versions of one wall — i.e. resets. A wall reset every month for four years
 * stays inside this. The cap exists because every version keeps its own photo
 * and its own `spray_wall_holds` generation.
 */
export const MAX_VERSIONS_PER_WALL = 50;

/**
 * What a spray wall is called in prose. `formatBoardDisplayName('spray')`
 * returns this, so a board-type label anywhere in the app reads "Spray wall"
 * rather than "Spray".
 */
export const SPRAY_DISPLAY_NAME = 'Spray wall';

/**
 * The catalogue size id for a wall's layout. They are the same number by
 * definition (see the module comment); this exists so the equality is written
 * once and read at every call site instead of being re-derived.
 */
export function spraySizeIdForLayout(layoutId: number): number {
  return layoutId;
}
