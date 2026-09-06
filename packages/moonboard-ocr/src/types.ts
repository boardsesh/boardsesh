// Grid coordinates shared by all MoonBoards. Mini profiles validate a 12-row
// subset at runtime; full-size profiles retain all 18 rows.
// Columns: A-K (11 columns)
// Rows: 1-18 (bottom to top)
export type Column = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K';
export type Row = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18;

export type GridCoordinate = `${Column}${Row}`;

export type HoldType = 'start' | 'hand' | 'finish';

export type DetectedHold = {
  type: HoldType;
  coordinate: GridCoordinate;
  // Pixel position in the original image (for debugging)
  pixelX: number;
  pixelY: number;
  // Confidence score (0-1)
  confidence: number;
};

export type MoonBoardClimb = {
  // Climb metadata from OCR
  name: string;
  setter: string;
  angle: number;
  userGrade: string;
  setterGrade: string;
  isBenchmark: boolean; // Orange "B" icon indicates official benchmark climb

  // Hold positions
  holds: {
    start: GridCoordinate[];
    hand: GridCoordinate[];
    finish: GridCoordinate[];
  };

  // Source tracking
  sourceFile: string;

  // Optional: parsing confidence/errors
  parseWarnings?: string[];
};

export type ParseResult = {
  success: boolean;
  climb?: MoonBoardClimb;
  error?: string;
  warnings: string[];
};

export type BoardRegion = {
  // Coordinates of the board area in the image
  x: number;
  y: number;
  width: number;
  height: number;
};

export type HeaderRegion = {
  // Coordinates of the header/text area
  x: number;
  y: number;
  width: number;
  height: number;
};

// Color detection thresholds (in HSV)
export type ColorRange = {
  hueMin: number;
  hueMax: number;
  satMin: number;
  satMax: number;
  valMin: number;
  valMax: number;
};

export const HOLD_COLORS: Record<HoldType, ColorRange> = {
  // Red circles for start holds
  start: {
    hueMin: 0,
    hueMax: 10,
    satMin: 150,
    satMax: 255,
    valMin: 150,
    valMax: 255,
  },
  // Blue circles for hand holds
  hand: {
    hueMin: 100,
    hueMax: 130,
    satMin: 150,
    satMax: 255,
    valMin: 150,
    valMax: 255,
  },
  // Yellow/Green circles for finish holds
  finish: {
    hueMin: 40,
    hueMax: 80,
    satMin: 150,
    satMax: 255,
    valMin: 150,
    valMax: 255,
  },
};

// MoonBoard 2024 grid configuration
export const GRID_CONFIG = {
  columns: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] as Column[],
  rows: [18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as Row[],
  numColumns: 11,
  numRows: 18,
};

/**
 * Relative grid positions for each hold coordinate.
 * Values are 0-1 representing percentage of board width/height.
 * Positions are at cell centers to match the original cell-based detection.
 *
 * For 11 columns: cell width = 1/11, centers at (colIdx + 0.5) / 11
 * For 18 rows: cell height = 1/18, centers at (rowIdx + 0.5) / 18
 * Row 18 is at top (rowIdx 0), row 1 is at bottom (rowIdx 17)
 */
export const GRID_POSITIONS: Record<GridCoordinate, { x: number; y: number }> = (() => {
  const positions: Record<string, { x: number; y: number }> = {};
  const columns: Column[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];

  for (let colIdx = 0; colIdx < 11; colIdx++) {
    for (let row = 1; row <= 18; row++) {
      const coord = `${columns[colIdx]}${row}` as GridCoordinate;
      // X: cell center position (colIdx + 0.5) / 11
      const x = (colIdx + 0.5) / 11;
      // Y: row 18 at top (rowIdx 0), row 1 at bottom (rowIdx 17)
      const rowIdx = 18 - row;
      const y = (rowIdx + 0.5) / 18;
      positions[coord] = { x, y };
    }
  }

  return positions as Record<GridCoordinate, { x: number; y: number }>;
})();
