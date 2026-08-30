import {
  QUANTUM_MODELS,
  QUANTUM_PRODUCT_SIZES,
  QUANTUM_SET_ID,
  type QuantumModelName,
} from '@boardsesh/board-constants/quantum';

/**
 * Fixed placement geometry bundled from the approved, pinned snapshot.
 *
 * The shared renderer deliberately accepts this as data instead of bundling a
 * copied wall image or guessing placement ids from the advertised row/column
 * count. Quantum placement ids share a namespace across the standard size family, so the grid dimensions alone cannot position a climb.
 */
export type QuantumCanonicalPlacement = Readonly<{
  id: number;
  x: number;
  y: number;
}>;

export type QuantumCanonicalGeometry = Readonly<{
  layoutId: number;
  sizeId: number;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  placements: readonly QuantumCanonicalPlacement[];
}>;

export type QuantumNeutralGrid = Readonly<{
  model: QuantumModelName;
  columns: number;
  rows: number;
  boardWidth: number;
  boardHeight: number;
}>;

export type QuantumRenderableHold = Readonly<{
  id: number;
  mirroredHoldId: null;
  cx: number;
  cy: number;
  r: number;
}>;

export type QuantumBoardDetails = Readonly<{
  board_name: 'quantum';
  layout_id: number;
  size_id: number;
  set_ids: readonly [typeof QUANTUM_SET_ID];
  layout_name: string;
  size_name: string;
  set_names: readonly ['Default'];
  supportsMirroring: false;
  edge_left: number;
  edge_right: number;
  edge_bottom: number;
  edge_top: number;
  boardWidth: number;
  boardHeight: number;
  images_to_holds: Record<string, never[]>;
  holdsData: QuantumRenderableHold[];
  neutralGrid: QuantumNeutralGrid;
}>;

// Renderer-only units. One exact advertised grid cell is 100 canvas units;
// this is deliberately not a claim about physical dimensions or image pixels.
const NEUTRAL_GRID_CELL_SIZE = 100;
const NEUTRAL_HOLD_RADIUS_FRACTION = 0.18;

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/** Resolve only exact model layout/size pairs; cross-model pairs fail closed. */
export function getQuantumModelForConfig(
  layoutId: number,
  sizeId: number,
): Readonly<{ key: QuantumModelName; model: (typeof QUANTUM_MODELS)[QuantumModelName] }> | null {
  for (const [key, model] of Object.entries(QUANTUM_MODELS) as Array<
    [QuantumModelName, (typeof QUANTUM_MODELS)[QuantumModelName]]
  >) {
    if (model.layoutId === layoutId && model.sizeId === sizeId) return { key, model };
  }
  return null;
}

/**
 * Neutral canvas metadata for the five controller models. Source-coordinate
 * bounds determine aspect; protocol rows/columns only decorate the grid.
 */
export function getQuantumNeutralGrid(layoutId: number, sizeId: number): QuantumNeutralGrid | null {
  const resolved = getQuantumModelForConfig(layoutId, sizeId);
  if (!resolved) return null;
  const { key, model } = resolved;
  return {
    model: key,
    columns: model.columns,
    rows: model.rows,
    boardWidth: model.columns * NEUTRAL_GRID_CELL_SIZE,
    // Protocol rows/columns identify the controller, not physical aspect.
    // Preserve the fixed source bounds, including the separate Belay topology.
    boardHeight:
      model.columns *
      NEUTRAL_GRID_CELL_SIZE *
      ((QUANTUM_PRODUCT_SIZES[sizeId]!.edgeTop! - QUANTUM_PRODUCT_SIZES[sizeId]!.edgeBottom!) /
        (QUANTUM_PRODUCT_SIZES[sizeId]!.edgeRight! - QUANTUM_PRODUCT_SIZES[sizeId]!.edgeLeft!)),
  };
}

/**
 * Project authoritative catalogue coordinates onto the neutral model canvas.
 *
 * Unknown, malformed, duplicate, empty, or mismatched geometry returns null.
 * Callers must keep Quantum out of browse/create surfaces in that state: a
 * plausible-looking row-major guess would light and edit the wrong holds.
 */
export function getQuantumBoardDetails(geometry: QuantumCanonicalGeometry): QuantumBoardDetails | null {
  const neutralGrid = getQuantumNeutralGrid(geometry.layoutId, geometry.sizeId);
  const resolved = getQuantumModelForConfig(geometry.layoutId, geometry.sizeId);
  if (!neutralGrid || !resolved) return null;

  const { edgeLeft, edgeRight, edgeBottom, edgeTop } = geometry;
  if (
    !isFiniteNumber(edgeLeft) ||
    !isFiniteNumber(edgeRight) ||
    !isFiniteNumber(edgeBottom) ||
    !isFiniteNumber(edgeTop) ||
    edgeLeft >= edgeRight ||
    edgeBottom >= edgeTop ||
    geometry.placements.length === 0
  ) {
    return null;
  }

  const xScale = neutralGrid.boardWidth / (edgeRight - edgeLeft);
  const yScale = neutralGrid.boardHeight / (edgeTop - edgeBottom);
  const holdRadius = NEUTRAL_GRID_CELL_SIZE * NEUTRAL_HOLD_RADIUS_FRACTION;
  const seenPlacementIds = new Set<number>();
  const holdsData: QuantumRenderableHold[] = [];

  for (const placement of geometry.placements) {
    if (
      !Number.isSafeInteger(placement.id) ||
      placement.id < 0 ||
      seenPlacementIds.has(placement.id) ||
      !isFiniteNumber(placement.x) ||
      !isFiniteNumber(placement.y) ||
      placement.x < edgeLeft ||
      placement.x > edgeRight ||
      placement.y < edgeBottom ||
      placement.y > edgeTop
    ) {
      return null;
    }
    seenPlacementIds.add(placement.id);
    holdsData.push({
      id: placement.id,
      mirroredHoldId: null,
      cx: (placement.x - edgeLeft) * xScale,
      cy: neutralGrid.boardHeight - (placement.y - edgeBottom) * yScale,
      r: holdRadius,
    });
  }

  return {
    board_name: 'quantum',
    layout_id: geometry.layoutId,
    size_id: geometry.sizeId,
    set_ids: [QUANTUM_SET_ID],
    layout_name: resolved.model.displayName,
    size_name: resolved.model.displayName,
    set_names: ['Default'],
    supportsMirroring: false,
    edge_left: edgeLeft,
    edge_right: edgeRight,
    edge_bottom: edgeBottom,
    edge_top: edgeTop,
    boardWidth: neutralGrid.boardWidth,
    boardHeight: neutralGrid.boardHeight,
    images_to_holds: {},
    holdsData,
    neutralGrid,
  };
}
