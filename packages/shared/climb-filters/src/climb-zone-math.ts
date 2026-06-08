import type { HoldsFilter, ZoneBoxInput } from '@boardsesh/shared-schema';

/**
 * Platform-free geometry helpers for the board "zone" search filter — the
 * draggable rectangle that restricts results to climbs whose holds fit inside
 * it. Extracted from the web search drawer so web and mobile share one
 * implementation (the web copy re-exports from here against its own `ZoneBox`
 * alias, which is structurally identical to {@link ZoneBoxInput}).
 *
 * Coordinates: `ZoneBoxInput` edges are in placement-grid space (the same
 * coordinate space as `board_holes.x/y` and the `edge_*` columns on board
 * sizes). Hold positions (`cx`/`cy`) come from the renderer in SVG-pixel space,
 * so {@link isHoldInsideZone} runs them back through {@link svgToGrid} first.
 */

/**
 * Bounding edges of the board playing surface in placement-grid coordinates.
 * Matches the `edge_*` fields on a board size / `BoardDetails`.
 */
export type BoardEdges = {
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
};

export type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/**
 * Default zone covers the inner 60% of the board so the user immediately
 * sees a visible rectangle they can manipulate.
 */
export function buildDefaultZone(edges: BoardEdges): ZoneBoxInput {
  const widthGrid = edges.edgeRight - edges.edgeLeft;
  const heightGrid = edges.edgeTop - edges.edgeBottom;
  const padX = Math.round(widthGrid * 0.2);
  const padY = Math.round(heightGrid * 0.2);
  return {
    edgeLeft: edges.edgeLeft + padX,
    edgeRight: edges.edgeRight - padX,
    edgeBottom: edges.edgeBottom + padY,
    edgeTop: edges.edgeTop - padY,
  };
}

/**
 * Constrain a (potentially mid-drag) box to fit inside the board edges
 * and respect the 5%-of-board minimum size.
 */
export function clampZoneBox(box: ZoneBoxInput, edges: BoardEdges): ZoneBoxInput {
  const minWidth = Math.max(1, Math.round((edges.edgeRight - edges.edgeLeft) * 0.05));
  const minHeight = Math.max(1, Math.round((edges.edgeTop - edges.edgeBottom) * 0.05));
  let { edgeLeft: left, edgeRight: right, edgeBottom: bottom, edgeTop: top } = box;
  left = Math.max(edges.edgeLeft, Math.min(left, edges.edgeRight - minWidth));
  right = Math.min(edges.edgeRight, Math.max(right, left + minWidth));
  bottom = Math.max(edges.edgeBottom, Math.min(bottom, edges.edgeTop - minHeight));
  top = Math.min(edges.edgeTop, Math.max(top, bottom + minHeight));
  return {
    edgeLeft: Math.round(left),
    edgeRight: Math.round(right),
    edgeBottom: Math.round(bottom),
    edgeTop: Math.round(top),
  };
}

/**
 * Apply a drag delta (in grid coordinates) to a starting box, given the
 * drag mode (which corner / move). Edge handles correspond to grid-axis
 * pairs as follows: visually-upper-Y = larger `edgeTop`, visually-lower-Y =
 * smaller `edgeBottom`.
 */
export function applyDrag(
  startBox: ZoneBoxInput,
  mode: DragMode,
  dx: number,
  dy: number,
  edges: BoardEdges,
): ZoneBoxInput {
  if (mode === 'move') {
    const widthGrid = startBox.edgeRight - startBox.edgeLeft;
    const heightGrid = startBox.edgeTop - startBox.edgeBottom;
    const next: ZoneBoxInput = {
      edgeLeft: startBox.edgeLeft + dx,
      edgeRight: startBox.edgeRight + dx,
      edgeBottom: startBox.edgeBottom + dy,
      edgeTop: startBox.edgeTop + dy,
    };
    if (next.edgeLeft < edges.edgeLeft) {
      next.edgeLeft = edges.edgeLeft;
      next.edgeRight = edges.edgeLeft + widthGrid;
    }
    if (next.edgeRight > edges.edgeRight) {
      next.edgeRight = edges.edgeRight;
      next.edgeLeft = edges.edgeRight - widthGrid;
    }
    if (next.edgeBottom < edges.edgeBottom) {
      next.edgeBottom = edges.edgeBottom;
      next.edgeTop = edges.edgeBottom + heightGrid;
    }
    if (next.edgeTop > edges.edgeTop) {
      next.edgeTop = edges.edgeTop;
      next.edgeBottom = edges.edgeTop - heightGrid;
    }
    return clampZoneBox(next, edges);
  }
  const next: ZoneBoxInput = { ...startBox };
  if (mode === 'nw' || mode === 'sw') next.edgeLeft = startBox.edgeLeft + dx;
  if (mode === 'ne' || mode === 'se') next.edgeRight = startBox.edgeRight + dx;
  if (mode === 'nw' || mode === 'ne') next.edgeTop = startBox.edgeTop + dy;
  if (mode === 'sw' || mode === 'se') next.edgeBottom = startBox.edgeBottom + dy;
  return clampZoneBox(next, edges);
}

export type BoardDimensions = BoardEdges & {
  boardWidth: number;
  boardHeight: number;
};

/**
 * Convert a grid-coordinate point to SVG-pixel coordinates. Mirrors the math
 * the renderer uses so the rectangle lines up with the rendered hold positions.
 */
export function gridToSvg(x: number, y: number, dims: BoardDimensions): { x: number; y: number } {
  const xSpacing = dims.boardWidth / (dims.edgeRight - dims.edgeLeft);
  const ySpacing = dims.boardHeight / (dims.edgeTop - dims.edgeBottom);
  return {
    x: (x - dims.edgeLeft) * xSpacing,
    y: dims.boardHeight - (y - dims.edgeBottom) * ySpacing,
  };
}

/**
 * Inverse of {@link gridToSvg} — translate a point in SVG coordinate space back
 * to grid coordinates.
 */
export function svgToGrid(svgX: number, svgY: number, dims: BoardDimensions): { x: number; y: number } {
  const xSpacing = dims.boardWidth / (dims.edgeRight - dims.edgeLeft);
  const ySpacing = dims.boardHeight / (dims.edgeTop - dims.edgeBottom);
  return {
    x: svgX / xSpacing + dims.edgeLeft,
    y: dims.edgeBottom + (dims.boardHeight - svgY) / ySpacing,
  };
}

/**
 * Pick a sensible handle radius in SVG units. Scales with board size but
 * clamps against absolute lower/upper bounds so handles never overlap on
 * tiny boards or balloon to cover half the rectangle on huge ones.
 */
export function computeHandleRadius(dims: BoardDimensions): number {
  const HANDLE_FRACTION = 0.04;
  const MIN_HANDLE = 8;
  const MAX_HANDLE = 40;
  const fromBoard = Math.max(dims.boardWidth, dims.boardHeight) * HANDLE_FRACTION;
  return Math.max(MIN_HANDLE, Math.min(MAX_HANDLE, fromBoard));
}

/**
 * Whether a hold sits inside (or on the edge of) a zone box. `cx`/`cy` come
 * from the renderer in SVG-pixel space; the zone box is in grid coordinates, so
 * we run the hold position through {@link svgToGrid} and compare against the box
 * edges.
 *
 * Inclusive on all four sides — the backend zone filter keeps a climb if every
 * hold fits inside the box, so a hold exactly on the edge still leaves the climb
 * eligible.
 *
 * Returns `true` for a null/undefined zone — semantically "no zone constraint =
 * every hold is unconstrained" — so callers that prune holds after a zone change
 * can pass `null` without a separate guard.
 */
export function isHoldInsideZone(
  hold: { cx: number; cy: number },
  zone: ZoneBoxInput | null | undefined,
  dims: BoardDimensions,
): boolean {
  if (!zone) return true;
  const gridPoint = svgToGrid(hold.cx, hold.cy, dims);
  return (
    gridPoint.x >= zone.edgeLeft &&
    gridPoint.x <= zone.edgeRight &&
    gridPoint.y >= zone.edgeBottom &&
    gridPoint.y <= zone.edgeTop
  );
}

/** Hold-position lookup keyed by hold id (`board_holes`/SVG-pixel `cx`/`cy`). */
export type HoldPositionLookup = ReadonlyMap<number, { cx: number; cy: number }>;

/**
 * Drop every hold filter whose hold sits outside the zone box. The backend
 * `allHolds` zone filter keeps a climb only when every one of its holds fits
 * inside the box, so a filter hold sitting outside the zone guarantees zero
 * matches — pruning it stops the user staring at empty results.
 *
 * Holds the lookup doesn't know are dropped too: under an active zone a tap on a
 * fabricated/stale id can't be the user's intent. A `null` zone means "no zone
 * constraint", so every filter survives. Shared so web and mobile prune
 * identically (extracted from the web search drawer's local `pruneHoldsToZone`).
 */
export function pruneHoldsToZone(
  holdsFilter: HoldsFilter,
  zone: ZoneBoxInput | null | undefined,
  holdsById: HoldPositionLookup,
  dims: BoardDimensions,
): HoldsFilter {
  if (!zone) return holdsFilter;
  const pruned: HoldsFilter = {};
  for (const [holdIdRaw, entry] of Object.entries(holdsFilter)) {
    const hold = holdsById.get(Number(holdIdRaw));
    if (hold && entry && isHoldInsideZone(hold, zone, dims)) {
      pruned[Number(holdIdRaw)] = entry;
    }
  }
  return pruned;
}
