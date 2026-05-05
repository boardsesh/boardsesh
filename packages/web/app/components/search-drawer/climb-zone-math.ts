import type { ZoneBox } from '@/app/lib/types';

/**
 * Bounding edges of the board playing surface in placement-grid coordinates.
 * Matches the `edge_*` fields on `BoardDetails`.
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
export function buildDefaultZone(edges: BoardEdges): ZoneBox {
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
export function clampZoneBox(box: ZoneBox, edges: BoardEdges): ZoneBox {
  const minWidth = Math.max(1, Math.round((edges.edgeRight - edges.edgeLeft) * 0.05));
  const minHeight = Math.max(1, Math.round((edges.edgeTop - edges.edgeBottom) * 0.05));
  let { edgeLeft: l, edgeRight: r, edgeBottom: b, edgeTop: t } = box;
  l = Math.max(edges.edgeLeft, Math.min(l, edges.edgeRight - minWidth));
  r = Math.min(edges.edgeRight, Math.max(r, l + minWidth));
  b = Math.max(edges.edgeBottom, Math.min(b, edges.edgeTop - minHeight));
  t = Math.min(edges.edgeTop, Math.max(t, b + minHeight));
  return {
    edgeLeft: Math.round(l),
    edgeRight: Math.round(r),
    edgeBottom: Math.round(b),
    edgeTop: Math.round(t),
  };
}

/**
 * Apply a drag delta (in grid coordinates) to a starting box, given the
 * drag mode (which corner / move). Edge handles in the SVG correspond to
 * grid-axis pairs as follows: visually-upper-Y = larger `edgeTop`,
 * visually-lower-Y = smaller `edgeBottom`.
 */
export function applyDrag(startBox: ZoneBox, mode: DragMode, dx: number, dy: number, edges: BoardEdges): ZoneBox {
  if (mode === 'move') {
    const widthGrid = startBox.edgeRight - startBox.edgeLeft;
    const heightGrid = startBox.edgeTop - startBox.edgeBottom;
    const next: ZoneBox = {
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
  const next: ZoneBox = { ...startBox };
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
 * Convert a grid-coordinate point to SVG-pixel coordinates.
 * Mirrors the math in `board-constants.ts` so the rectangle lines up with
 * the rendered hold positions.
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
 * Inverse of `gridToSvg` — translate a point in SVG coordinate space back
 * to grid coordinates. Used to convert a pointer event (after applying
 * the SVG's screen CTM) back to where the user is in board space.
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
