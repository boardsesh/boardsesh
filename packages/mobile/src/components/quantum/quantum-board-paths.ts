import type { QuantumBoardDetails, QuantumNeutralGrid } from '@boardsesh/board-config';
import type { HoldPlacement } from '../board-renderer/types';

type QuantumRenderPathData = Readonly<{
  holdsData: HoldPlacement[];
  neutralHoldsPath: string;
}>;

const gridPathCache = new Map<string, string>();
const renderPathCache = new WeakMap<QuantumBoardDetails, QuantumRenderPathData>();

function pathNumber(value: number): string {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** One cached SVG path replaces the row/column Line nodes on every render. */
export function getQuantumNeutralGridPath(grid: QuantumNeutralGrid): string {
  const cacheKey = `${grid.columns}:${grid.rows}:${grid.boardWidth}:${grid.boardHeight}`;
  const cached = gridPathCache.get(cacheKey);
  if (cached) return cached;

  const boardWidth = pathNumber(grid.boardWidth);
  const boardHeight = pathNumber(grid.boardHeight);
  const segments: string[] = [];
  for (let columnIndex = 0; columnIndex <= grid.columns; columnIndex += 1) {
    const lineX = pathNumber((columnIndex * grid.boardWidth) / grid.columns);
    segments.push(`M${lineX} 0V${boardHeight}`);
  }
  for (let rowIndex = 0; rowIndex <= grid.rows; rowIndex += 1) {
    const lineY = pathNumber((rowIndex * grid.boardHeight) / grid.rows);
    segments.push(`M0 ${lineY}H${boardWidth}`);
  }

  const path = segments.join('');
  gridPathCache.set(cacheKey, path);
  return path;
}

/**
 * Projected geometry objects are shared by the registry. Cache both the mutable
 * renderer view and a compound circle path by that object identity, so a
 * FlashList of Quantum rows does not rebuild geometry or mount ~225 Circle
 * nodes per thumbnail. A new signed-catalogue revision creates a new details
 * object and therefore a fresh path automatically.
 */
export function getQuantumRenderPathData(boardDetails: QuantumBoardDetails): QuantumRenderPathData {
  const cached = renderPathCache.get(boardDetails);
  if (cached) return cached;

  const holdsData = boardDetails.holdsData.map((hold) => ({ ...hold }));
  const neutralHoldsPath = holdsData
    .map((hold) => {
      const radius = hold.r * 0.6;
      const centerY = pathNumber(hold.cy);
      const leftX = pathNumber(hold.cx - radius);
      const rightX = pathNumber(hold.cx + radius);
      const pathRadius = pathNumber(radius);
      return `M${leftX} ${centerY}A${pathRadius} ${pathRadius} 0 1 0 ${rightX} ${centerY}A${pathRadius} ${pathRadius} 0 1 0 ${leftX} ${centerY}Z`;
    })
    .join('');
  const resolved = { holdsData, neutralHoldsPath };
  renderPathCache.set(boardDetails, resolved);
  return resolved;
}
