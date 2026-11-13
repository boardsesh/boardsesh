import { MOONBOARD_GRID } from '@boardsesh/board-constants/moonboard';

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

// MoonBoard has a single fixed size (all boards are same dimensions)
export const MOONBOARD_SIZE = {
  id: 1,
  name: 'Standard',
  description: '11x18 Grid',
  // Standard board-art image dimensions
  width: 650,
  height: 1000,
};

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
  // Background image filename under public/images/moonboard/. Labels only: the
  // A-K column letters and row numbers, transparent everywhere else. Web stacks
  // it under the holds; mobile draws it above the holds overlay so the
  // dark-mode veil cannot fade it (issue #6234).
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
