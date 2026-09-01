// MoonBoard Configuration
// This file contains all MoonBoard-specific configuration that differs from Aurora boards

import { MOONBOARD_GRID } from '@boardsesh/board-constants/moonboard';

// Feature flag - enabled by default
export const MOONBOARD_ENABLED = true;

// MoonBoard grade values keep compatibility with the grade strings used by the
// MoonBoard create flow; labels match board_difficulty_grades and BOULDER_GRADES.
export const MOONBOARD_GRADES = [
  { value: '5+', label: '5a/V1', difficultyId: 13 },
  { value: '5B', label: '5b/V1', difficultyId: 14 },
  { value: '5C', label: '5c/V2', difficultyId: 15 },
  { value: '6A', label: '6a/V3', difficultyId: 16 },
  { value: '6A+', label: '6a+/V3', difficultyId: 17 },
  { value: '6B', label: '6b/V4', difficultyId: 18 },
  { value: '6B+', label: '6b+/V4', difficultyId: 19 },
  { value: '6C', label: '6c/V5', difficultyId: 20 },
  { value: '6C+', label: '6c+/V5', difficultyId: 21 },
  { value: '7A', label: '7a/V6', difficultyId: 22 },
  { value: '7A+', label: '7a+/V7', difficultyId: 23 },
  { value: '7B', label: '7b/V8', difficultyId: 24 },
  { value: '7B+', label: '7b+/V8', difficultyId: 25 },
  { value: '7C', label: '7c/V9', difficultyId: 26 },
  { value: '7C+', label: '7c+/V10', difficultyId: 27 },
  { value: '8A', label: '8a/V11', difficultyId: 28 },
  { value: '8A+', label: '8a+/V12', difficultyId: 29 },
  { value: '8B', label: '8b/V13', difficultyId: 30 },
  { value: '8B+', label: '8b+/V14', difficultyId: 31 },
  { value: '8C', label: '8c/V15', difficultyId: 32 },
  { value: '8C+', label: '8c+/V16', difficultyId: 33 },
] as const;

export function getMoonBoardGradeLabel(value: string): string {
  return MOONBOARD_GRADES.find((grade) => grade.value === value)?.label ?? value;
}

// MoonBoard layout types (equivalent to Aurora "layouts")
export const MOONBOARD_LAYOUTS = {
  'moonboard-2010': { id: 1, name: 'MoonBoard 2010', folder: 'moonboard2010' },
  'moonboard-2016': { id: 2, name: 'MoonBoard 2016', folder: 'moonboard2016' },
  'moonboard-2024': { id: 3, name: 'MoonBoard 2024', folder: 'moonboard2024' },
  'moonboard-masters-2017': {
    id: 4,
    name: 'MoonBoard Masters 2017',
    folder: 'moonboardmasters2017',
  },
  'moonboard-masters-2019': {
    id: 5,
    name: 'MoonBoard Masters 2019',
    folder: 'moonboardmasters2019',
  },
  'mini-moonboard-2020': { id: 6, name: 'Mini MoonBoard 2020', folder: 'minimoonboard2020' },
  'mini-moonboard-2025': { id: 7, name: 'Mini MoonBoard 2025', folder: 'minimoonboard2025' },
} as const;

export type MoonBoardLayoutKey = keyof typeof MOONBOARD_LAYOUTS;

// Hold sets available per layout
export const MOONBOARD_SETS: Record<MoonBoardLayoutKey, { id: number; name: string; imageFile: string }[]> = {
  'moonboard-2010': [{ id: 1, name: 'Original School Holds', imageFile: 'originalschoolholds.png' }],
  'moonboard-2016': [
    { id: 2, name: 'Hold Set A', imageFile: 'holdseta.png' },
    { id: 3, name: 'Hold Set B', imageFile: 'holdsetb.png' },
    { id: 4, name: 'Original School Holds', imageFile: 'originalschoolholds.png' },
  ],
  'moonboard-2024': [
    { id: 5, name: 'Hold Set D', imageFile: 'holdsetd.png' },
    { id: 6, name: 'Hold Set E', imageFile: 'holdsete.png' },
    { id: 7, name: 'Hold Set F', imageFile: 'holdsetf.png' },
    { id: 8, name: 'Wooden Holds', imageFile: 'woodenholds.png' },
    { id: 9, name: 'Wooden Holds B', imageFile: 'woodenholdsb.png' },
    { id: 10, name: 'Wooden Holds C', imageFile: 'woodenholdsc.png' },
  ],
  'moonboard-masters-2017': [
    { id: 11, name: 'Hold Set A', imageFile: 'holdseta.png' },
    { id: 12, name: 'Hold Set B', imageFile: 'holdsetb.png' },
    { id: 13, name: 'Hold Set C', imageFile: 'holdsetc.png' },
    { id: 14, name: 'Original School Holds', imageFile: 'originalschoolholds.png' },
    { id: 15, name: 'Screw-on Feet', imageFile: 'screw-onfeet.png' },
    { id: 16, name: 'Wooden Holds', imageFile: 'woodenholds.png' },
  ],
  'moonboard-masters-2019': [
    { id: 17, name: 'Hold Set A', imageFile: 'holdseta.png' },
    { id: 18, name: 'Hold Set B', imageFile: 'holdsetb.png' },
    { id: 19, name: 'Original School Holds', imageFile: 'originalschoolholds.png' },
    { id: 20, name: 'Screw-on Feet', imageFile: 'screw-onfeet.png' },
    { id: 21, name: 'Wooden Holds', imageFile: 'woodenholds.png' },
    { id: 22, name: 'Wooden Holds B', imageFile: 'woodenholdsb.png' },
    { id: 23, name: 'Wooden Holds C', imageFile: 'woodenholdsc.png' },
  ],
  'mini-moonboard-2020': [
    { id: 24, name: 'Original School Holds', imageFile: 'originalschoolholds.png' },
    { id: 25, name: 'Wooden Holds', imageFile: 'woodenholds.png' },
    { id: 26, name: 'Wooden Holds B', imageFile: 'woodenholdsb.png' },
    { id: 27, name: 'Wooden Holds C', imageFile: 'woodenholdsc.png' },
  ],
  // Mini 2025 (holdsetup 22). Set list matches the board art shipped in the
  // MoonBoard app (assets/boards/minimoonboard2025): Hold Set F + Original
  // School Holds + Wooden Holds B/C. There is no plain "Wooden Holds" image for
  // this layout.
  'mini-moonboard-2025': [
    { id: 28, name: 'Hold Set F', imageFile: 'holdsetf.png' },
    { id: 29, name: 'Original School Holds', imageFile: 'originalschoolholds.png' },
    { id: 30, name: 'Wooden Holds B', imageFile: 'woodenholdsb.png' },
    { id: 31, name: 'Wooden Holds C', imageFile: 'woodenholdsc.png' },
  ],
};

// MoonBoard grid configuration (same for all standard layouts)
// 11 columns (A-K) x 18 rows (1-18, bottom to top)
// numColumns and numRows are imported from @boardsesh/board-constants/moonboard;
// columns/rows arrays and the merged export are local because they carry
// board-specific label info that only the web app needs.
const MOONBOARD_COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] as const;
const MOONBOARD_ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] as const;

export { MOONBOARD_GRID };

// The two angles Moon Climbing's own catalog grades problems at (25°/40°).
// This is the default/fallback angle list every picker uses. It's a UI
// convention, not a hard limit — nothing server-side rejects other angles for
// MoonBoard (angle is a plain 0-90 bounded int everywhere it's validated) —
// see the `moonboard-wide-angles` feature flag for the flag-gated wider range.
export const MOONBOARD_ANGLES = [25, 40] as const;

// The full angle range, matching Kilter/Tension (ANGLES.kilter/tension in
// board-data.ts), offered by angle pickers when the `moonboard-wide-angles`
// feature flag is on. A MoonBoard problem's holds don't change with angle —
// Moon Climbing just never grades outside 25°/40°, so climbs graded at other
// angles start with no catalog grade/stats until the community logs there,
// exactly like any Aurora board today.
export const MOONBOARD_WIDE_ANGLES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70] as const;

// MoonBoard has a single fixed size (all boards are same dimensions)
export const MOONBOARD_SIZE = {
  id: 1,
  name: 'Standard',
  description: '11x18 Grid',
  // Standard board-art image dimensions
  width: 650,
  height: 1000,
};

// MoonBoard hold states (different color scheme from Aurora)
// Green for start holds, Blue for hand/intermediate holds, Red for finish holds
export const MOONBOARD_HOLD_STATES = {
  start: { name: 'STARTING' as const, color: '#00FF00', displayColor: '#44FF44' },
  // boardseshDisplayColor mirrors HOLD_STATE_MAP.moonboard[43] (issue #2202):
  // the Aura render mode lifts the HAND off the veiled wall. MoonBoard takes
  // Kilter's cyan rather than the Aura blue every other board uses — MoonBoard
  // 2024's own holds are blue, so the blue marker disappeared into them.
  // Pinned by moonboard-hold-state-drift.test.ts.
  hand: { name: 'HAND' as const, color: '#0000FF', displayColor: '#4444FF', boardseshDisplayColor: '#00FFFF' },
  finish: { name: 'FINISH' as const, color: '#FF0000', displayColor: '#FF3333' },
} as const;

// Hold state codes for frames encoding (compatible with Aurora format).
// These codes are used in the frames string format: p{holdId}r{roleCode}
// e.g., "p1r42p45r43p198r44" means hold 1 is start, hold 45 is hand, hold 198 is finish.
//
// The codes 42, 43, 44 are chosen to be compatible with Aurora boards (Kilter/Tension),
// which use similar role code patterns in their placement strings. This allows shared
// parsing logic between MoonBoard and Aurora boards when processing climb data.
export const MOONBOARD_HOLD_STATE_CODES = {
  start: 42,
  hand: 43,
  finish: 44,
} as const;

// Grid coordinate types
export type MoonBoardColumn = (typeof MOONBOARD_COLUMNS)[number];
export type MoonBoardRow = (typeof MOONBOARD_ROWS)[number];
export type MoonBoardCoordinate = `${MoonBoardColumn}${MoonBoardRow}`;

/**
 * Convert a grid coordinate (e.g., "A5", "K18") to a numeric hold ID.
 * IDs range from 1 to 198 (11 columns x 18 rows).
 * ID = (row - 1) * 11 + colIndex + 1
 */
export function coordinateToHoldId(coord: MoonBoardCoordinate): number {
  const col = coord.charAt(0) as MoonBoardColumn;
  const row = parseInt(coord.slice(1), 10) as MoonBoardRow;
  const colIndex = MOONBOARD_COLUMNS.indexOf(col);
  return (row - 1) * MOONBOARD_GRID.numColumns + colIndex + 1;
}

/**
 * Convert a numeric hold ID back to a grid coordinate.
 */
export function holdIdToCoordinate(holdId: number): MoonBoardCoordinate {
  const id = holdId - 1;
  const colIndex = id % MOONBOARD_GRID.numColumns;
  const row = Math.floor(id / MOONBOARD_GRID.numColumns) + 1;
  const col = MOONBOARD_COLUMNS[colIndex];
  return `${col}${row}` as MoonBoardCoordinate;
}

// Visual grid geometry per layout. All MoonBoard layouts share the A–K column
// naming and the 18-row hold-ID numbering used by coordinateToHoldId /
// holdIdToCoordinate; this descriptor only governs how a hold's (column, row)
// maps onto its board-art image, which differs for the Mini boards.
//
// The Mini boards reuse the standard 11-column horizontal grid but are shorter:
// the art (650×694) draws the top row at row 12 and goes down to row 1 (2025) or
// row 2 (2020). Calibration margins below are measured from the actual hold
// positions in the MoonBoard app's board art.
export type MoonBoardGridGeometry = {
  // Columns drawn (A.. ); 11 for every current MoonBoard layout.
  numColumns: number;
  // Highest row number, drawn at the top slot of the image.
  rowTop: number;
  // Number of vertical slots, counting down from rowTop.
  numRows: number;
  // Board-art image dimensions (px).
  width: number;
  height: number;
  // Background image filename under public/images/moonboard/.
  backgroundImage: string;
  // Margins (0-1) of the hold grid within the image.
  calibration: { leftMargin: number; rightMargin: number; topMargin: number; bottomMargin: number };
};

export const STANDARD_MOONBOARD_GEOMETRY: MoonBoardGridGeometry = {
  numColumns: MOONBOARD_GRID.numColumns,
  rowTop: MOONBOARD_GRID.numRows,
  numRows: MOONBOARD_GRID.numRows,
  width: MOONBOARD_SIZE.width,
  height: MOONBOARD_SIZE.height,
  backgroundImage: 'moonboard-bg.png',
  // X: 10% left / 5% right; Y: 6% top / 4% bottom.
  calibration: { leftMargin: 0.1, rightMargin: 0.05, topMargin: 0.06, bottomMargin: 0.04 },
};

// Mini MoonBoard 2020 and 2025 share one geometry: 11 columns, rows 1–12 (top
// row is row 12), on the 650×694 board art. 2020 simply leaves row 1 empty.
export const MINI_MOONBOARD_GEOMETRY: MoonBoardGridGeometry = {
  numColumns: 11,
  rowTop: 12,
  numRows: 12,
  width: 650,
  height: 694,
  backgroundImage: 'minimoonboard-bg.png',
  calibration: { leftMargin: 0.1047, rightMargin: 0.0508, topMargin: 0.0793, bottomMargin: 0.0571 },
};

const MINI_MOONBOARD_LAYOUT_KEYS = new Set<MoonBoardLayoutKey>(['mini-moonboard-2020', 'mini-moonboard-2025']);

/** Geometry for a layout key (Mini boards differ from the standard 11×18). */
export function getMoonBoardGeometry(layoutKey: MoonBoardLayoutKey): MoonBoardGridGeometry {
  return MINI_MOONBOARD_LAYOUT_KEYS.has(layoutKey) ? MINI_MOONBOARD_GEOMETRY : STANDARD_MOONBOARD_GEOMETRY;
}

/** Geometry by numeric layout id; falls back to the standard board. */
export function getMoonBoardGeometryByLayoutId(layoutId: number): MoonBoardGridGeometry {
  const entry = getLayoutById(layoutId);
  return entry ? getMoonBoardGeometry(entry[0] as MoonBoardLayoutKey) : STANDARD_MOONBOARD_GEOMETRY;
}

/** Geometry by board-art folder (e.g. 'minimoonboard2020'); falls back to standard. */
export function getMoonBoardGeometryByFolder(folder: string): MoonBoardGridGeometry {
  const entry = Object.entries(MOONBOARD_LAYOUTS).find(([, layout]) => layout.folder === folder);
  return entry ? getMoonBoardGeometry(entry[0] as MoonBoardLayoutKey) : STANDARD_MOONBOARD_GEOMETRY;
}

/**
 * Get the relative position (0-1) for a hold ID on the board, for the given
 * geometry (defaults to the standard 11×18 board).
 * X: 0 = left edge, 1 = right edge. Y: 0 = top edge, 1 = bottom edge (SVG).
 *
 * The hold's (column, row) is decoded from the universal 11-column hold-ID
 * scheme; `geometry.rowTop` places row numbers onto the image's vertical slots.
 */
export function getGridPosition(
  holdId: number,
  geometry: MoonBoardGridGeometry = STANDARD_MOONBOARD_GEOMETRY,
): { x: number; y: number } {
  const id = holdId - 1;
  const colIndex = id % MOONBOARD_GRID.numColumns;
  const row = Math.floor(id / MOONBOARD_GRID.numColumns) + 1;

  const { leftMargin, rightMargin, topMargin, bottomMargin } = geometry.calibration;
  const gridWidth = 1 - leftMargin - rightMargin;
  const gridHeight = 1 - topMargin - bottomMargin;

  // X: cell center within the grid region.
  const relativeX = (colIndex + 0.5) / geometry.numColumns;
  const x = leftMargin + relativeX * gridWidth;

  // Y: the highest row number sits in the top slot; rows count down. In SVG, Y
  // increases downward, so a higher row number maps to a smaller y.
  const slotFromTop = geometry.rowTop - row;
  const relativeY = (slotFromTop + 0.5) / geometry.numRows;
  const y = topMargin + relativeY * gridHeight;

  return { x, y };
}

/**
 * Get layout info by layout ID
 */
export function getLayoutById(layoutId: number) {
  return Object.entries(MOONBOARD_LAYOUTS).find(([, layout]) => layout.id === layoutId);
}

/**
 * Get hold sets for a layout
 */
export function getHoldSetsForLayout(layoutKey: MoonBoardLayoutKey) {
  return MOONBOARD_SETS[layoutKey] || [];
}

/**
 * Get image files for selected set IDs
 */
export function getHoldSetImages(layoutKey: MoonBoardLayoutKey, setIds: number[]): string[] {
  const sets = MOONBOARD_SETS[layoutKey] || [];
  return sets.filter((s) => setIds.includes(s.id)).map((s) => s.imageFile);
}

/**
 * Get MoonBoard details in a format compatible with BoardDetails type.
 * This allows MoonBoard pages to use the same layout structure as Aurora boards.
 */
export function getMoonBoardDetails({ layout_id, set_ids }: { layout_id: number; set_ids: number[] }) {
  const layoutEntry = getLayoutById(layout_id);
  if (!layoutEntry) {
    throw new Error(`MoonBoard layout not found: ${layout_id}`);
  }

  const [layoutKey, layoutData] = layoutEntry;
  const geometry = getMoonBoardGeometry(layoutKey as MoonBoardLayoutKey);
  const sets = MOONBOARD_SETS[layoutKey as MoonBoardLayoutKey] || [];
  const selectedSets = sets.filter((s) => set_ids.includes(s.id));

  // Compute hold positions from the layout's grid for the WASM/canvas rendering
  // pipeline. Rows 1..rowTop are emitted (132 holds for the Mini, 198 standard).
  // Mini 2020 has no physical holds on row 1, but emitting those slots is
  // harmless — no climb references them, so they never light up.
  const cellWidth = geometry.width / geometry.numColumns;
  const cellHeight = geometry.height / geometry.numRows;
  const holdRadius = Math.min(cellWidth, cellHeight) * 0.525;

  const holdsData = Array.from({ length: geometry.numColumns * geometry.rowTop }, (_, i) => {
    const holdId = i + 1;
    const pos = getGridPosition(holdId, geometry);
    return {
      id: holdId,
      mirroredHoldId: null,
      cx: pos.x * geometry.width,
      cy: pos.y * geometry.height,
      r: holdRadius,
    };
  });

  // Build images_to_holds with background + hold set images as keys.
  // Values are empty arrays — only keys are used for background URL construction
  // in the WASM worker and BoardImageLayers rendering paths.
  const images_to_holds: Record<string, []> = { [geometry.backgroundImage]: [] };
  for (const set of selectedSets) {
    images_to_holds[`${layoutData.folder}/${set.imageFile}`] = [];
  }

  return {
    board_name: 'moonboard' as const,
    layout_id,
    size_id: MOONBOARD_SIZE.id,
    set_ids,
    layout_name: layoutData.name,
    size_name: MOONBOARD_SIZE.name,
    size_description: MOONBOARD_SIZE.description,
    set_names: selectedSets.map((s) => s.name),
    boardWidth: geometry.width,
    boardHeight: geometry.height,
    supportsMirroring: false,
    edge_left: 0,
    edge_right: geometry.numColumns,
    edge_bottom: 0,
    edge_top: geometry.rowTop,
    images_to_holds,
    holdsData,
    // Moonboard-specific fields for grid-based rendering (used by MoonBoardRenderer SVG)
    layoutFolder: layoutData.folder,
    holdSetImages: selectedSets.map((s) => s.imageFile),
  };
}

/**
 * Encode MoonBoard holds to frames format for database storage.
 * Format: p{holdId}r{roleCode} (e.g., "p1r42p45r43p198r44")
 */
export function encodeMoonBoardHoldsToFrames(holds: { start: string[]; hand: string[]; finish: string[] }): string {
  const parts: string[] = [];

  holds.start.forEach((coord) => {
    const holdId = coordinateToHoldId(coord as MoonBoardCoordinate);
    parts.push(`p${holdId}r${MOONBOARD_HOLD_STATE_CODES.start}`);
  });

  holds.hand.forEach((coord) => {
    const holdId = coordinateToHoldId(coord as MoonBoardCoordinate);
    parts.push(`p${holdId}r${MOONBOARD_HOLD_STATE_CODES.hand}`);
  });

  holds.finish.forEach((coord) => {
    const holdId = coordinateToHoldId(coord as MoonBoardCoordinate);
    parts.push(`p${holdId}r${MOONBOARD_HOLD_STATE_CODES.finish}`);
  });

  return parts.join('');
}
