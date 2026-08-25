// Woods Board configuration.
//
// Woods is a non-Aurora board (like MoonBoard): its catalog is code-driven, not
// sourced from the Aurora database tables. This file holds the metadata the app
// needs that does NOT depend on the board-art assets — the angles, the two board
// sizes, the single layout, and the frames encoder.
//
// The on-screen hold geometry and board art come from the decompiled Woods app.
import {
  WOODS_BOARD_SIZES,
  WOODS_WIRE_ROLE,
  WOODS_HOLD_POSITIONS,
  type WoodsBoardSize,
} from '@boardsesh/board-constants/woods';

export { WOODS_BOARD_SIZES };
export type { WoodsBoardSize };

// Woods supports 20–70° in 5° steps (Woods app API: angle 20–70 step 5).
export const WOODS_ANGLES = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70] as const;

// The Woods board ships in two physical sizes; each has its own LED table
// (board-constants WOODS_LED_MAPS) and hold layout. A climb's `boardDimension`
// picks the size. `dimension` is the value the Woods data API uses.
export const WOODS_SIZES: Record<WoodsBoardSize, { id: number; name: string; dimension: WoodsBoardSize }> = {
  '8x10': { id: 1, name: '8 x 10', dimension: '8x10' },
  '12x12': { id: 2, name: '12 x 12', dimension: '12x12' },
};

// Map a board size's numeric id back to its dimension string (and vice versa).
export function woodsSizeIdToDimension(sizeId: number): WoodsBoardSize | undefined {
  return Object.values(WOODS_SIZES).find((size) => size.id === sizeId)?.dimension;
}

export function woodsDimensionToSizeId(dimension: WoodsBoardSize): number {
  return WOODS_SIZES[dimension].id;
}

// Woods has a single hold layout shared by both sizes (the 8×10 is a subset of
// the 12×12 positions). Modeled as layout id 1 so the deep board routes resolve.
export const WOODS_LAYOUTS = {
  woods: { id: 1, name: 'Original' },
} as const;

// Woods has no hold sets, but a board config with zero set ids breaks the board
// builder, the `board/layout/size/sets/angle` path parser and the readable-URL
// round trip. Ship one synthetic set instead, the way So iLL ships 'The Set'.
export const WOODS_SETS = [{ id: 1, name: 'Standard' }] as const;

// Hold roles as the Woods data API reports them in a problem's `holdList`.
export type WoodsHoldType = 'Start' | 'Hand' | 'Finish' | 'Foot';

const WOODS_HOLD_TYPE_TO_CODE: Record<WoodsHoldType, number> = {
  Start: WOODS_WIRE_ROLE.START,
  Hand: WOODS_WIRE_ROLE.HAND,
  Finish: WOODS_WIRE_ROLE.FINISH,
  Foot: WOODS_WIRE_ROLE.FOOT,
};

/**
 * Encode a Woods problem's holds into the `p{baseHoldLocation}r{roleCode}` frames
 * string Boardsesh stores. The role codes match the BLE wire codes, so the saved
 * frames feed `getWoodsBluetoothPacket` directly. Holds are sorted by location for
 * a stable, fingerprintable string; unknown roles (e.g. "Clear") are dropped.
 */
export function encodeWoodsHoldsToFrames(holds: Array<{ type: string; baseHoldLocation: number }>): string {
  return holds
    .filter((hold): hold is { type: WoodsHoldType; baseHoldLocation: number } => hold.type in WOODS_HOLD_TYPE_TO_CODE)
    .sort((a, b) => a.baseHoldLocation - b.baseHoldLocation)
    .map((hold) => `p${hold.baseHoldLocation}r${WOODS_HOLD_TYPE_TO_CODE[hold.type]}`)
    .join('');
}

// =============================================================================
// Board geometry (reverse-engineered from the Woods app, v1.6)
// =============================================================================
// The Woods board is laid out as variable-width rows: each row holds a fixed
// number of holds spread edge-to-edge across the board width. `BOARD_ROW_LENGTHS`
// (app constants) gives the hold count per row, top to bottom; a hold's
// `baseHoldLocation` is the cumulative index across rows (the app's
// `getHoldPositionFromRowColumn`). Totals: 8x10 = 485, 12x12 = 894 — matching the
// LED maps. Narrower rows align with every-other column of the widest row, which
// falls out of the edge-to-edge spread (e.g. an 11-hold row over a 21-hold row).

const repeat = (count: number, value: number): number[] => Array.from({ length: count }, () => value);

export const WOODS_ROW_LENGTHS: Record<WoodsBoardSize, number[]> = {
  '8x10': [...repeat(1, 11), ...repeat(21, 21), ...repeat(3, 11)],
  '12x12': [...repeat(3, 17), ...repeat(23, 33), ...repeat(3, 17), ...repeat(1, 17), ...repeat(1, 16)],
};

export type WoodsRowColumn = { row: number; column: number };

/**
 * Decompose a `baseHoldLocation` into its (row, column) on the board, walking the
 * row-length table (the app's `getHoldRowColumnFromPosition`). Returns undefined
 * for a location past the board's hold count.
 */
export function getWoodsHoldRowColumn(baseHoldLocation: number, size: WoodsBoardSize): WoodsRowColumn | undefined {
  const rows = WOODS_ROW_LENGTHS[size];
  let start = 0;
  for (let row = 0; row < rows.length; row++) {
    const end = start + rows[row];
    if (baseHoldLocation >= start && baseHoldLocation < end) {
      return { row, column: baseHoldLocation - start };
    }
    start = end;
  }
  return undefined;
}

/** Inverse of {@link getWoodsHoldRowColumn} — (row, column) → baseHoldLocation. */
export function getWoodsHoldPosition(row: number, column: number, size: WoodsBoardSize): number {
  const rows = WOODS_ROW_LENGTHS[size];
  return rows.slice(0, row).reduce((sum, length) => sum + length, 0) + column;
}

/**
 * Normalised board position (0..1) for a hold: x across the width, y down the
 * height of the board-art image. These come from `WOODS_HOLD_POSITIONS` — per-hold
 * centres detected from the Woods app's board art (the row pitch isn't uniform, so
 * a computed grid won't line up). Mirroring is x → 1 - x. Returns undefined for a
 * location past the board's hold count.
 */
export function getWoodsHoldGridPosition(
  baseHoldLocation: number,
  size: WoodsBoardSize,
): { x: number; y: number } | undefined {
  const position = WOODS_HOLD_POSITIONS[size][baseHoldLocation];
  if (!position) return undefined;
  return { x: position[0], y: position[1] };
}

/**
 * Rendered hold-circle radius (board-art px) per board size.
 *
 * Sized off the MEASURED spacing of `WOODS_HOLD_POSITIONS`, not a computed grid:
 * the median nearest-neighbour distance is 27.1 px on 8×10 and 31.8 px on 12×12.
 * At ~0.42 × that, the share of holds overlapping a neighbour drops from 90% to
 * 43% on 8×10 and from 83% to 36% on 12×12. The previous
 * `min(cellWidth, cellHeight) / 2` estimate gave 17.1 / 18.6 px, at which the
 * board rendered as one smear instead of discrete holds. The rows aren't evenly
 * pitched, which is why the cell-size estimate was so far out.
 *
 * The residual 43% / 36% is not a sizing problem and no radius fixes it: it's
 * near-duplicate detections from the CV pass — pairs of centres a pixel or two
 * apart that draw on top of each other whatever radius they get.
 * `__tests__/woods-hold-positions.test.ts` pins their count as a budget, and
 * re-extracting the table is the follow-up that clears them.
 */
export const WOODS_HOLD_RADIUS_PX: Record<WoodsBoardSize, number> = {
  '8x10': 11.5,
  '12x12': 13.5,
};

export type WoodsGeometry = {
  numRows: number;
  // Widest row — the master column count the narrower rows align to.
  maxColumns: number;
  // Board-art image dimensions (px) and filename under public/images/woods/. The
  // hold positions are normalised over this image, so the pixel size only sets the
  // coordinate space for `getWoodsHoldImagePosition`.
  width: number;
  height: number;
  backgroundImage: string;
};

export const WOODS_GEOMETRY: Record<WoodsBoardSize, WoodsGeometry> = {
  '8x10': {
    numRows: WOODS_ROW_LENGTHS['8x10'].length,
    maxColumns: 21,
    width: 720,
    height: 1000,
    backgroundImage: 'woods-8x10-bg.png',
  },
  '12x12': {
    numRows: WOODS_ROW_LENGTHS['12x12'].length,
    maxColumns: 33,
    width: 1225,
    height: 1400,
    backgroundImage: 'woods-12x12-bg.png',
  },
};

/** Absolute (cx, cy) of a hold within the board-art image (detected position × size). */
export function getWoodsHoldImagePosition(
  baseHoldLocation: number,
  size: WoodsBoardSize,
): { cx: number; cy: number } | undefined {
  const grid = getWoodsHoldGridPosition(baseHoldLocation, size);
  if (!grid) return undefined;
  const geometry = WOODS_GEOMETRY[size];
  return { cx: grid.x * geometry.width, cy: grid.y * geometry.height };
}

/**
 * A hold's position in Woods ZONE-GRID space — the coordinates the "Board region"
 * search box is expressed in.
 *
 * The box is dragged over the board art, and `svgToGrid` in
 * `@boardsesh/climb-filters` converts a render position back to grid units using
 * only the `boardWidth`/`boardHeight` and `edge_*` that
 * {@link getWoodsBoardDetails} reports. For Woods that is board-art pixels over a
 * `0..maxColumns` × `0..numRows` box, so the conversion collapses to scaling the
 * normalised hold centre — with y flipped, because grid y counts up from the floor
 * while the art's y counts down from the top.
 *
 * This is deliberately NOT the hold's real (row, column): rows have different
 * lengths and an uneven pitch, so the hold in column 3 is not at x = 3. It doesn't
 * need to be. The zone filter only needs the client and the server to put a hold in
 * the same place, and both derive it from the same normalised centre.
 */
export function getWoodsHoldZonePosition(
  baseHoldLocation: number,
  size: WoodsBoardSize,
): { x: number; y: number } | undefined {
  const position = getWoodsHoldGridPosition(baseHoldLocation, size);
  if (!position) return undefined;
  const geometry = WOODS_GEOMETRY[size];
  return { x: position.x * geometry.maxColumns, y: (1 - position.y) * geometry.numRows };
}

/** The four edges of a board-region search box, in Woods zone-grid space. */
export type WoodsZoneBox = {
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
};

/**
 * Every hold of a board size that sits inside a region box, so the climb search
 * can answer a zone query with no `board_placements` / `board_holes` rows behind
 * it — Woods is code-driven and has none (boardsesh/boardsesh#4748).
 *
 * Inclusive on all four edges, matching `isHoldInsideZone` on the client: the
 * `allHolds` filter keeps a climb whose every hold fits inside the box, so a hold
 * sitting exactly on an edge must not disqualify it. Positions are compared
 * unrounded for the same reason — the client prunes its own hold filters with the
 * raw float, and a rounded server would disagree on the boundary.
 *
 * The two Woods sizes number their holds differently, so the caller passes the
 * size being browsed. A size id that isn't a Woods board returns null rather than
 * a plausible-looking list, so a stale or crafted size fails the search closed.
 *
 * Ids come back ascending: the keys of `WOODS_HOLD_POSITIONS` are array indices,
 * which `Object.keys` enumerates in numeric order.
 */
export function woodsHoldIdsInZone(sizeId: number, box: WoodsZoneBox): number[] | null {
  const dimension = woodsSizeIdToDimension(sizeId);
  if (!dimension) return null;

  const inside: number[] = [];
  for (const holdKey of Object.keys(WOODS_HOLD_POSITIONS[dimension])) {
    const baseHoldLocation = Number(holdKey);
    const position = getWoodsHoldZonePosition(baseHoldLocation, dimension);
    if (!position) continue;
    if (
      position.x >= box.edgeLeft &&
      position.x <= box.edgeRight &&
      position.y >= box.edgeBottom &&
      position.y <= box.edgeTop
    ) {
      inside.push(baseHoldLocation);
    }
  }
  return inside;
}

/**
 * The horizontally-mirrored hold for a `baseHoldLocation` — the same row, with the
 * column reflected across the row's width (column → rowLength - 1 - column). Returns
 * the input location for the centre hold of an odd-width row (it mirrors to itself)
 * and undefined for a location past the board.
 *
 * Woods does not offer mirrored climbs yet (`supportsMirroring` is false below);
 * this is the geometry half of that feature, ready for the follow-up that threads
 * `mirrored` through the BLE send path.
 */
export function getWoodsMirroredHoldLocation(baseHoldLocation: number, size: WoodsBoardSize): number | undefined {
  const rowColumn = getWoodsHoldRowColumn(baseHoldLocation, size);
  if (!rowColumn) return undefined;
  const rowLength = WOODS_ROW_LENGTHS[size][rowColumn.row];
  return getWoodsHoldPosition(rowColumn.row, rowLength - 1 - rowColumn.column, size);
}

/**
 * Build a `BoardDetails`-shaped descriptor for a Woods board size, mirroring
 * {@link getMoonBoardDetails}. The size id selects the 8×10 or 12×12 board; the
 * returned `holdsData` carries every detected hold centre (in board-art pixels)
 * so the Woods SVG renderer can light a climb's holds. Woods has no real hold
 * sets, so it reports the single synthetic {@link WOODS_SETS} entry, and
 * `images_to_holds` holds only the background.
 */
export function getWoodsBoardDetails({ size_id }: { size_id: number }) {
  const dimension = woodsSizeIdToDimension(size_id);
  if (!dimension) {
    throw new Error(`Woods board size not found: ${size_id}`);
  }

  const geometry = WOODS_GEOMETRY[dimension];
  const sizeInfo = WOODS_SIZES[dimension];

  const holdRadius = WOODS_HOLD_RADIUS_PX[dimension];

  // One entry per detected hold centre. `id` is the baseHoldLocation, matching the
  // `p{baseHoldLocation}r{code}` frames stored for Woods climbs.
  const holdsData = Object.keys(WOODS_HOLD_POSITIONS[dimension]).map((key) => {
    const baseHoldLocation = Number(key);
    const position = getWoodsHoldImagePosition(baseHoldLocation, dimension);
    return {
      id: baseHoldLocation,
      mirroredHoldId: getWoodsMirroredHoldLocation(baseHoldLocation, dimension) ?? null,
      cx: position?.cx ?? 0,
      cy: position?.cy ?? 0,
      r: holdRadius,
    };
  });

  // Only the background key is used (for URL construction); the value is empty.
  const images_to_holds: Record<string, []> = { [geometry.backgroundImage]: [] };

  return {
    board_name: 'woods' as const,
    layout_id: WOODS_LAYOUTS.woods.id,
    size_id,
    set_ids: WOODS_SETS.map((set) => set.id),
    layout_name: WOODS_LAYOUTS.woods.name,
    size_name: sizeInfo.name,
    set_names: WOODS_SETS.map((set) => set.name),
    boardWidth: geometry.width,
    boardHeight: geometry.height,
    // Mirroring is not wired end-to-end for Woods, so don't offer it: the BLE
    // send path ignores `mirrored` and lights the unmirrored holds, and
    // `boardSupportsMirroring('woods', …)` already answers false. The geometry
    // half exists — `getWoodsMirroredHoldLocation` and the `mirroredHoldId` on
    // each hold below — so a follow-up only has to thread the flag through the
    // send path. MoonBoard, the other code-driven board, reports false too.
    supportsMirroring: false,
    edge_left: 0,
    edge_right: geometry.maxColumns,
    edge_bottom: 0,
    edge_top: geometry.numRows,
    images_to_holds,
    holdsData,
  };
}
