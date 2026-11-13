import { WOODS_ROW_LENGTHS, type WoodsBoardSize } from '@boardsesh/board-constants/woods-dimensions';

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

// Calibrated against the lossless Woods app art. Every logical mounting slot
// retains its ID; WOODS_OCCUPIED_HOLD_IDS separately identifies physical holds
// for silhouette tracing. See scripts/woods-board-calibration.ts (#4971).
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
