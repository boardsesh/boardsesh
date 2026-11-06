import type { Quad } from './homography';
import { readLedPositions, readTnutWiring, type LedPosition, type TnutWiring } from './led-layout';

/** Rectified wall-only frame coordinates in [0, 1], with the origin at the top left. */
export type TnutPoint = { x: number; y: number };
export type TnutCorners = {
  topLeft: TnutPoint;
  topRight: TnutPoint;
  bottomLeft: TnutPoint;
  bottomRight: TnutPoint;
};
export type TnutPattern = 'grid' | 'offset' | 'custom';
/** Placement choice only; physical LED indices are assigned separately. */
export type SprayLedPlacement = 'center' | 'sides' | 'below' | 'alternating';

export const MIN_TNUT_DIMENSION = 1;
export const MAX_TNUT_DIMENSION = 50;
export const DEFAULT_TNUT_DIMENSION = 8;
export const MAX_TNUT_HOLES = 3000;
export const DEFAULT_TNUT_CORNERS: TnutCorners = Object.freeze({
  topLeft: Object.freeze({ x: 0.1, y: 0.1 }),
  topRight: Object.freeze({ x: 0.9, y: 0.1 }),
  bottomLeft: Object.freeze({ x: 0.1, y: 0.9 }),
  bottomRight: Object.freeze({ x: 0.9, y: 0.9 }),
});

export type TnutGridOptions = {
  pattern: 'grid' | 'offset';
  rows: number;
  columns: number;
  corners: TnutCorners;
  firstRowOffset: boolean;
  /** Absent means the legacy count of positions in a full row. */
  columnConvention?: 'all';
};

/** The edited hole list is authoritative, including additions/removals from a grid. */
export type TnutLayout = {
  version: 1;
  pattern: TnutPattern;
  rows: number;
  columns: number;
  firstRowOffset: boolean;
  corners: TnutCorners;
  holes: TnutPoint[];
  /** Stable version identity; never an expiring signed photo URL. */
  photoKey: string;
  /** Absent for layouts saved before the LED placement step was completed. */
  ledPlacement?: SprayLedPlacement;
  columnConvention?: 'all';
  ledPositions?: LedPosition[];
  wiring?: TnutWiring;
};

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  'worklet';
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function isCoordinate(candidate: unknown): candidate is number {
  'worklet';
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1;
}

function isPoint(candidate: unknown): candidate is TnutPoint {
  'worklet';
  return isRecord(candidate) && isCoordinate(candidate.x) && isCoordinate(candidate.y);
}

function cornerQuad(corners: TnutCorners): Quad {
  'worklet';
  return [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft].map(({ x, y }) => [x, y]);
}

/** Hidden corners remain stored, so even inactive points must stay in bounds. */
function hasCornerPoints(candidate: unknown): candidate is TnutCorners {
  'worklet';
  return (
    isRecord(candidate) &&
    isPoint(candidate.topLeft) &&
    isPoint(candidate.topRight) &&
    isPoint(candidate.bottomLeft) &&
    isPoint(candidate.bottomRight)
  );
}

/** Reject crossed, mirrored, concave and near-degenerate two-dimensional frames. */
export function isValidTnutCorners(candidate: unknown): candidate is TnutCorners {
  'worklet';
  if (!hasCornerPoints(candidate)) return false;
  const quad = cornerQuad(candidate);
  // A tiny turn is numerically unstable even when the quad's total area is large.
  // Positive turns enforce convexity and TL/TR/BR/BL winding in wall-frame coordinates.
  return quad.every(([x, y], index) => {
    const [nextX, nextY] = quad[(index + 1) % 4];
    const [afterX, afterY] = quad[(index + 2) % 4];
    return (nextX - x) * (afterY - nextY) - (nextY - y) * (afterX - nextX) >= 0.000001;
  });
}

function hasValidCalibration(corners: TnutCorners, rows: number, columns: number): boolean {
  'worklet';
  if (rows === 1 && columns === 1) return true;
  if (rows === 1) return corners.topLeft.x !== corners.topRight.x || corners.topLeft.y !== corners.topRight.y;
  if (columns === 1) return corners.topLeft.x !== corners.bottomLeft.x || corners.topLeft.y !== corners.bottomLeft.y;
  return isValidTnutCorners(corners);
}

function isDimension(candidate: unknown): candidate is number {
  'worklet';
  return (
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= MIN_TNUT_DIMENSION &&
    candidate <= MAX_TNUT_DIMENSION
  );
}

function isColumnCount(candidate: unknown, convention: unknown): candidate is number {
  'worklet';
  // A migrated legacy 50-column offset layout has 99 distinct vertical positions.
  return (
    (convention === undefined || convention === 'all') &&
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 1 &&
    candidate <= (convention === 'all' ? 99 : 50)
  );
}

/** Closed-form unit-square→wall-frame homography, computed once for each frame. */
function squareToWallFrame(corners: TnutCorners): number[] {
  'worklet';
  const { topLeft, topRight, bottomRight, bottomLeft } = corners;
  const deltaX1 = topRight.x - bottomRight.x;
  const deltaX2 = bottomLeft.x - bottomRight.x;
  const deltaY1 = topRight.y - bottomRight.y;
  const deltaY2 = bottomLeft.y - bottomRight.y;
  const sumX = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const sumY = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const denominator = deltaX1 * deltaY2 - deltaX2 * deltaY1;
  const perspectiveX = (sumX * deltaY2 - deltaX2 * sumY) / denominator;
  const perspectiveY = (deltaX1 * sumY - sumX * deltaY1) / denominator;
  return [
    topRight.x - topLeft.x + perspectiveX * topRight.x,
    bottomLeft.x - topLeft.x + perspectiveY * bottomLeft.x,
    topLeft.x,
    topRight.y - topLeft.y + perspectiveX * topRight.y,
    bottomLeft.y - topLeft.y + perspectiveY * bottomLeft.y,
    topLeft.y,
    perspectiveX,
    perspectiveY,
  ];
}

/** A single axis uses only its visible endpoints; hidden corners cannot bend it. */
function gridToWallFrame(options: TnutGridOptions): number[] {
  'worklet';
  const { topLeft, topRight, bottomLeft } = options.corners;
  if (options.rows === 1) {
    return [topRight.x - topLeft.x, 0, topLeft.x, topRight.y - topLeft.y, 0, topLeft.y, 0, 0];
  }
  if (options.columns === 1) {
    return [0, bottomLeft.x - topLeft.x, topLeft.x, 0, bottomLeft.y - topLeft.y, topLeft.y, 0, 0];
  }
  return squareToWallFrame(options.corners);
}

function projectPoint(matrix: number[], column: number, row: number): TnutPoint {
  'worklet';
  const denominator = matrix[6] * column + matrix[7] * row + 1;
  return {
    // A boundary anchor may round to -epsilon or 1+epsilon after projection.
    x: Math.max(0, Math.min(1, (matrix[0] * column + matrix[1] * row + matrix[2]) / denominator)),
    y: Math.max(0, Math.min(1, (matrix[3] * column + matrix[4] * row + matrix[5]) / denominator)),
  };
}

/** Validate the active calibration while preserving all four stored corners. */
export function isValidTnutGrid(options: unknown): options is TnutGridOptions {
  'worklet';
  return (
    isRecord(options) &&
    (options.pattern === 'grid' || options.pattern === 'offset') &&
    isDimension(options.rows) &&
    isColumnCount(options.columns, options.columnConvention) &&
    (options.pattern === 'offset' || options.columns <= 50) &&
    typeof options.firstRowOffset === 'boolean' &&
    hasCornerPoints(options.corners) &&
    hasValidCalibration(options.corners, options.rows, options.columns)
  );
}

/**
 * Project an evenly spaced grid into its calibrated rectified wall frame. Offset rows have
 * one fewer hole and sit half a column inward on both sides; calibration corners
 * still describe the outer rectangle, even when a corner has no physical hole.
 * A single row follows TL→TR; a single column follows TL→BL without alternating
 * empty rows. A 1×1 grid is the top-left point, independent of the offset phase.
 */
export function generateTnutGrid(options: TnutGridOptions): TnutPoint[] {
  if (!isValidTnutGrid(options)) {
    throw new RangeError('Invalid T-nut grid');
  }
  const projection = gridToWallFrame(options);
  const holes: TnutPoint[] = [];
  for (let row = 0; row < options.rows; row++) {
    const inset =
      options.columns > 1 &&
      options.pattern === 'offset' &&
      (row % 2 === 0 ? options.firstRowOffset : !options.firstRowOffset);
    const all = options.pattern === 'offset' && options.columnConvention === 'all' && options.columns > 1;
    const count = all ? Math.ceil((options.columns - (inset ? 1 : 0)) / 2) : options.columns - (inset ? 1 : 0);
    for (let column = 0; column < count; column++) {
      holes.push(
        projectPoint(
          projection,
          (all ? column * 2 + (inset ? 1 : 0) : column + (inset ? 0.5 : 0)) / Math.max(1, options.columns - 1),
          row / Math.max(1, options.rows - 1),
        ),
      );
    }
  }
  return holes;
}

/** One worklet-safe SVG path for the live overlay; no JS-thread callback per drag frame. */
export function tnutGridPath(
  options: TnutGridOptions,
  width: number,
  height: number,
  radius: number,
  offsetX = 0,
  offsetY = 0,
): string {
  'worklet';
  if (
    !isValidTnutGrid(options) ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Number.isFinite(radius) ||
    radius <= 0
  )
    return '';
  const projection = gridToWallFrame(options);
  const circle = `a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0z`;
  let path = '';
  for (let row = 0; row < options.rows; row++) {
    const inset =
      options.columns > 1 &&
      options.pattern === 'offset' &&
      (row % 2 === 0 ? options.firstRowOffset : !options.firstRowOffset);
    const all = options.pattern === 'offset' && options.columnConvention === 'all' && options.columns > 1;
    const count = all ? Math.ceil((options.columns - (inset ? 1 : 0)) / 2) : options.columns - (inset ? 1 : 0);
    for (let column = 0; column < count; column++) {
      const point = projectPoint(
        projection,
        (all ? column * 2 + (inset ? 1 : 0) : column + (inset ? 0.5 : 0)) / Math.max(1, options.columns - 1),
        row / Math.max(1, options.rows - 1),
      );
      path += `M${(point.x * width + offsetX - radius).toFixed(2)} ${(point.y * height + offsetY).toFixed(2)}${circle}`;
    }
  }
  return path;
}

/** Read a versioned device-local layout without trusting persisted JSON. */
export function readTnutLayout(candidate: unknown): TnutLayout | null {
  if (
    !isRecord(candidate) ||
    candidate.version !== 1 ||
    (candidate.ledPlacement !== undefined &&
      candidate.ledPlacement !== 'center' &&
      candidate.ledPlacement !== 'sides' &&
      candidate.ledPlacement !== 'below' &&
      candidate.ledPlacement !== 'alternating') ||
    (candidate.ledPlacement === 'alternating' && candidate.pattern !== 'offset') ||
    (candidate.pattern !== 'grid' && candidate.pattern !== 'offset' && candidate.pattern !== 'custom') ||
    !isDimension(candidate.rows) ||
    !isColumnCount(candidate.columns, candidate.columnConvention) ||
    (candidate.pattern !== 'offset' && typeof candidate.columns === 'number' && candidate.columns > 50) ||
    typeof candidate.firstRowOffset !== 'boolean' ||
    !hasCornerPoints(candidate.corners) ||
    !hasValidCalibration(candidate.corners, candidate.rows, candidate.columns) ||
    !Array.isArray(candidate.holes) ||
    candidate.holes.length > MAX_TNUT_HOLES ||
    !candidate.holes.every(isPoint) ||
    typeof candidate.photoKey !== 'string' ||
    !candidate.photoKey.trim() ||
    candidate.photoKey.length > 4096
  ) {
    return null;
  }
  const ledPositions = candidate.ledPositions === undefined ? undefined : readLedPositions(candidate.ledPositions);
  if (ledPositions === null) return null;
  const wiring = candidate.wiring === undefined ? undefined : readTnutWiring(candidate.wiring, ledPositions ?? []);
  if (wiring === null) return null;
  return {
    version: 1,
    pattern: candidate.pattern,
    rows: candidate.rows,
    columns: candidate.columns,
    firstRowOffset: candidate.firstRowOffset,
    corners: {
      topLeft: { x: candidate.corners.topLeft.x, y: candidate.corners.topLeft.y },
      topRight: { x: candidate.corners.topRight.x, y: candidate.corners.topRight.y },
      bottomLeft: { x: candidate.corners.bottomLeft.x, y: candidate.corners.bottomLeft.y },
      bottomRight: { x: candidate.corners.bottomRight.x, y: candidate.corners.bottomRight.y },
    },
    holes: candidate.holes.map(({ x, y }) => ({ x, y })),
    photoKey: candidate.photoKey,
    ...(candidate.ledPlacement !== undefined ? { ledPlacement: candidate.ledPlacement } : {}),
    ...(candidate.columnConvention === 'all' ? { columnConvention: 'all' as const } : {}),
    ...(ledPositions !== undefined ? { ledPositions } : {}),
    ...(wiring !== undefined ? { wiring } : {}),
  };
}

/** Update count labels without changing calibrated or edited positions. Idempotent. */
export function migrateTnutLayoutColumns(layout: TnutLayout): TnutLayout {
  if (layout.columnConvention === 'all') return layout;
  return {
    ...layout,
    columnConvention: 'all',
    columns: layout.pattern === 'offset' ? 2 * layout.columns - 1 : layout.columns,
  };
}
