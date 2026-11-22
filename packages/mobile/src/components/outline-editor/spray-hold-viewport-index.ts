import type { SprayEditorHold } from './spray-hold-editor-reducer';

export type HoldViewportBounds = { minX: number; minY: number; maxX: number; maxY: number };

type IndexedHold = { hold: SprayEditorHold; bounds: HoldViewportBounds };
type ViewportCell = { column: number; row: number; holds: readonly IndexedHold[] };
export type SprayHoldViewportIndex = {
  cellSize: number;
  cells: ReadonlyMap<string, ViewportCell>;
  oversized: readonly IndexedHold[];
};

const GRID_DIVISIONS = 32;
const MAX_HOLD_CELLS = 64;
const NO_HOLDS: readonly SprayEditorHold[] = [];
/** Geometry is immutable; this cache does not keep previous walls alive. */
const geometryBounds = new WeakMap<SprayEditorHold, HoldViewportBounds | null>();

function finiteBounds(bounds: HoldViewportBounds): boolean {
  return (
    Number.isFinite(bounds.minX) &&
    Number.isFinite(bounds.minY) &&
    Number.isFinite(bounds.maxX) &&
    Number.isFinite(bounds.maxY) &&
    bounds.minX <= bounds.maxX &&
    bounds.minY <= bounds.maxY
  );
}

function holdBounds(hold: SprayEditorHold): HoldViewportBounds | null {
  const cached = geometryBounds.get(hold);
  if (cached !== undefined) return cached;
  let bounds: HoldViewportBounds | null = null;
  if (Number.isFinite(hold.cx) && Number.isFinite(hold.cy) && Number.isFinite(hold.r) && hold.r > 0) {
    if (hold.outline === null) {
      bounds = { minX: hold.cx - hold.r, minY: hold.cy - hold.r, maxX: hold.cx + hold.r, maxY: hold.cy + hold.r };
    } else if (hold.outline.length >= 6 && hold.outline.length % 2 === 0) {
      bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (let coordinate = 0; coordinate < hold.outline.length; coordinate += 2) {
        const boardX = hold.cx + hold.outline[coordinate] * hold.r;
        const boardY = hold.cy + hold.outline[coordinate + 1] * hold.r;
        if (!Number.isFinite(boardX) || !Number.isFinite(boardY)) {
          bounds = null;
          break;
        }
        bounds.minX = Math.min(bounds.minX, boardX);
        bounds.minY = Math.min(bounds.minY, boardY);
        bounds.maxX = Math.max(bounds.maxX, boardX);
        bounds.maxY = Math.max(bounds.maxY, boardY);
      }
    }
  }
  if (bounds && !finiteBounds(bounds)) bounds = null;
  geometryBounds.set(hold, bounds);
  return bounds;
}

function intersects(first: HoldViewportBounds, second: HoldViewportBounds): boolean {
  return (
    first.minX <= second.maxX && first.maxX >= second.minX && first.minY <= second.maxY && first.maxY >= second.minY
  );
}

/** Build once when holds change; touch movement queries only the nearby cells. */
function createSprayHoldViewportIndex(
  holds: readonly SprayEditorHold[],
  boardWidth: number,
  boardHeight: number,
): SprayHoldViewportIndex {
  const cellSize = Math.max(boardWidth, boardHeight) / GRID_DIVISIONS;
  const cells = new Map<string, { column: number; row: number; holds: IndexedHold[] }>();
  const oversized: IndexedHold[] = [];
  if (
    !Number.isFinite(boardWidth) ||
    !Number.isFinite(boardHeight) ||
    boardWidth <= 0 ||
    boardHeight <= 0 ||
    !Number.isFinite(cellSize) ||
    cellSize <= 0
  ) {
    return { cellSize: 1, cells, oversized };
  }
  for (const hold of holds) {
    if (!Number.isSafeInteger(hold.id) || hold.id === 0) continue;
    const bounds = holdBounds(hold);
    if (!bounds) continue;
    const indexed = { hold, bounds };
    const firstColumn = Math.floor(bounds.minX / cellSize);
    const lastColumn = Math.floor(bounds.maxX / cellSize);
    const firstRow = Math.floor(bounds.minY / cellSize);
    const lastRow = Math.floor(bounds.maxY / cellSize);
    const cellCount = (lastColumn - firstColumn + 1) * (lastRow - firstRow + 1);
    if (![firstColumn, lastColumn, firstRow, lastRow].every(Number.isSafeInteger) || cellCount > MAX_HOLD_CELLS) {
      oversized.push(indexed);
      continue;
    }
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      for (let row = firstRow; row <= lastRow; row += 1) {
        const key = `${column}:${row}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = { column, row, holds: [] };
          cells.set(key, cell);
        }
        cell.holds.push(indexed);
      }
    }
  }
  return { cellSize, cells, oversized };
}

/** Inclusive bounds keep rings touching the viewport edge; callers add halo/overscan. */
export function holdsInSprayViewport(
  index: SprayHoldViewportIndex,
  bounds: HoldViewportBounds,
): readonly SprayEditorHold[] {
  if (!finiteBounds(bounds)) return NO_HOLDS;
  const firstColumn = Math.floor(bounds.minX / index.cellSize);
  const lastColumn = Math.floor(bounds.maxX / index.cellSize);
  const firstRow = Math.floor(bounds.minY / index.cellSize);
  const lastRow = Math.floor(bounds.maxY / index.cellSize);
  const cellCount = (lastColumn - firstColumn + 1) * (lastRow - firstRow + 1);
  const found = new Map<number, SprayEditorHold>();
  const collect = (indexed: IndexedHold) => {
    if (intersects(indexed.bounds, bounds)) found.set(indexed.hold.id, indexed.hold);
  };
  if (cellCount <= index.cells.size && [firstColumn, lastColumn, firstRow, lastRow].every(Number.isSafeInteger)) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      for (let row = firstRow; row <= lastRow; row += 1) {
        const cell = index.cells.get(`${column}:${row}`);
        if (cell) for (const indexed of cell.holds) collect(indexed);
      }
    }
  } else {
    // A zoomed-out or extreme query must not iterate billions of empty cells.
    for (const cell of index.cells.values()) {
      if (cell.column < firstColumn || cell.column > lastColumn || cell.row < firstRow || cell.row > lastRow) continue;
      for (const indexed of cell.holds) collect(indexed);
    }
  }
  for (const indexed of index.oversized) collect(indexed);
  return [...found.values()].sort((left, right) => left.id - right.id);
}

/** Reopening the native magnifier reuses bins as well as cached geometry bounds. */
const viewportIndexes = new WeakMap<
  readonly SprayEditorHold[],
  {
    boardWidth: number;
    boardHeight: number;
    index: SprayHoldViewportIndex;
  }
>();

export function buildSprayHoldViewportIndex(
  holds: readonly SprayEditorHold[],
  boardWidth: number,
  boardHeight: number,
): SprayHoldViewportIndex {
  const cached = viewportIndexes.get(holds);
  if (cached && Object.is(cached.boardWidth, boardWidth) && Object.is(cached.boardHeight, boardHeight)) {
    return cached.index;
  }
  const index = createSprayHoldViewportIndex(holds, boardWidth, boardHeight);
  viewportIndexes.set(holds, { boardWidth, boardHeight, index });
  return index;
}
