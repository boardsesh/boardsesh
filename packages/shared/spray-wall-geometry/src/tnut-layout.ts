import type { Quad } from './homography';

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
export type SprayLedPlacement = 'center' | 'sides' | 'below';

export const MIN_TNUT_DIMENSION = 2;
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

/** Reject crossed, mirrored, concave and near-degenerate calibration frames. */
export function isValidTnutCorners(candidate: unknown): candidate is TnutCorners {
  'worklet';
  if (
    !isRecord(candidate) ||
    !isPoint(candidate.topLeft) ||
    !isPoint(candidate.topRight) ||
    !isPoint(candidate.bottomLeft) ||
    !isPoint(candidate.bottomRight)
  ) {
    return false;
  }
  const quad = cornerQuad(candidate as TnutCorners);
  // A tiny turn is numerically unstable even when the quad's total area is large.
  // Positive turns enforce convexity and TL/TR/BR/BL winding in wall-frame coordinates.
  return quad.every(([x, y], index) => {
    const [nextX, nextY] = quad[(index + 1) % 4];
    const [afterX, afterY] = quad[(index + 2) % 4];
    return (nextX - x) * (afterY - nextY) - (nextY - y) * (afterX - nextX) >= 0.000001;
  });
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

function projectPoint(matrix: number[], column: number, row: number): TnutPoint {
  'worklet';
  const denominator = matrix[6] * column + matrix[7] * row + 1;
  return {
    // A boundary anchor may round to -epsilon or 1+epsilon after projection.
    x: Math.max(0, Math.min(1, (matrix[0] * column + matrix[1] * row + matrix[2]) / denominator)),
    y: Math.max(0, Math.min(1, (matrix[3] * column + matrix[4] * row + matrix[5]) / denominator)),
  };
}

function isValidGrid(options: TnutGridOptions): boolean {
  'worklet';
  return (
    (options.pattern === 'grid' || options.pattern === 'offset') &&
    isDimension(options.rows) &&
    isDimension(options.columns) &&
    typeof options.firstRowOffset === 'boolean' &&
    isValidTnutCorners(options.corners)
  );
}

/**
 * Project an evenly spaced grid into its calibrated rectified wall frame. Offset rows have
 * one fewer hole and sit half a column inward on both sides; calibration corners
 * still describe the outer rectangle, even when a corner has no physical hole.
 */
export function generateTnutGrid(options: TnutGridOptions): TnutPoint[] {
  if (!isValidGrid(options)) {
    throw new RangeError('Invalid T-nut grid');
  }
  const gridToWallFrame = squareToWallFrame(options.corners);
  const holes: TnutPoint[] = [];
  for (let row = 0; row < options.rows; row++) {
    const inset = options.pattern === 'offset' && (row % 2 === 0 ? options.firstRowOffset : !options.firstRowOffset);
    const count = options.columns - (inset ? 1 : 0);
    for (let column = 0; column < count; column++) {
      holes.push(
        projectPoint(gridToWallFrame, (column + (inset ? 0.5 : 0)) / (options.columns - 1), row / (options.rows - 1)),
      );
    }
  }
  return holes;
}

/** One worklet-safe SVG path for the live overlay; no JS-thread callback per drag frame. */
export function tnutGridPath(options: TnutGridOptions, width: number, height: number, radius: number): string {
  'worklet';
  if (
    !isValidGrid(options) ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Number.isFinite(radius) ||
    radius <= 0
  )
    return '';
  const gridToWallFrame = squareToWallFrame(options.corners);
  const circle = `a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0z`;
  let path = '';
  for (let row = 0; row < options.rows; row++) {
    const inset = options.pattern === 'offset' && (row % 2 === 0 ? options.firstRowOffset : !options.firstRowOffset);
    for (let column = 0; column < options.columns - (inset ? 1 : 0); column++) {
      const point = projectPoint(
        gridToWallFrame,
        (column + (inset ? 0.5 : 0)) / (options.columns - 1),
        row / (options.rows - 1),
      );
      path += `M${(point.x * width - radius).toFixed(2)} ${(point.y * height).toFixed(2)}${circle}`;
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
      candidate.ledPlacement !== 'below') ||
    (candidate.pattern !== 'grid' && candidate.pattern !== 'offset' && candidate.pattern !== 'custom') ||
    !isDimension(candidate.rows) ||
    !isDimension(candidate.columns) ||
    typeof candidate.firstRowOffset !== 'boolean' ||
    !isValidTnutCorners(candidate.corners) ||
    !Array.isArray(candidate.holes) ||
    candidate.holes.length > MAX_TNUT_HOLES ||
    !candidate.holes.every(isPoint) ||
    typeof candidate.photoKey !== 'string' ||
    !candidate.photoKey.trim() ||
    candidate.photoKey.length > 4096
  ) {
    return null;
  }
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
  };
}
