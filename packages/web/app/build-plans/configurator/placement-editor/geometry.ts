/**
 * The millimetre maths behind dragging a label around a wall.
 *
 * Pure, browser-free and framework-free on purpose: the generator is the
 * authority on whether a placement can be routed, but a buyer dragging a label
 * needs an answer every frame, and a round trip per frame is neither fast
 * enough nor allowed (the hole-bearing layout query is capped at 10 a minute).
 * So this module re-implements the same three checks the generator runs —
 * inside the panel, clear of every hole keep-out, not across a seam — against
 * the artwork's bounding rectangle rather than its outlined glyphs.
 *
 * That difference is deliberate and it only ever errs one way: a rectangle is
 * bigger than the letters inside it, so anything this module calls clear really
 * is clear. Something it calls a collision may still be fine (a hole in the gap
 * between two letters), which costs the buyer a nudge they did not strictly
 * need. Being wrong in the other direction would sell a pack that cannot be cut.
 *
 * Coordinates are the generator's wall space throughout (see `docs/coordinates.md`
 * in the generator repo): millimetres, origin at the bottom-left corner of the
 * bottom-left main panel, `+y` up, kicker panels at negative `y`, rotation
 * counter-clockwise. Nothing here knows about SVG or pixels.
 */

/** A point in wall space. */
export type PointMm = { xMm: number; yMm: number };

/**
 * An artwork item as a rectangle: its CENTRE, its size, and how far it is
 * turned. The centre rather than a corner because that is what the generator's
 * `placement` means, and rotation is about that centre.
 */
export type ArtRectMm = {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** Counter-clockwise degrees. */
  rotationDeg: number;
};

/** One cut panel, positioned by its bottom-left corner like the layout response. */
export type PanelRectMm = {
  index: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
};

/** A seam as the line it actually is: one fixed coordinate over a span. */
export type SeamLineMm = {
  kind: 'vertical' | 'horizontal';
  /** `x` for a vertical seam, `y` for a horizontal one. */
  valueMm: number;
  /** How far the seam runs, in the other axis. */
  extent: readonly [number, number];
};

/** A drilled hole reduced to what a keep-out test needs, plus an id to point at. */
export type HoleMm = {
  id: string;
  xMm: number;
  yMm: number;
  keepoutRadiusMm: number;
};

/** Which corner is being dragged. */
export type ResizeHandle = 'bottomLeft' | 'bottomRight' | 'topLeft' | 'topRight';

/** Everything in the way of one placement. Empty on all three counts means it fits. */
export type PlacementCollisions = {
  /** Ids of the holes whose keep-out the artwork reaches into. */
  holes: string[];
  /** Indices, in the layout's own seam order, of the seams it spans. */
  seams: number[];
  /** True when any corner leaves the panel, margin included. */
  offPanel: boolean;
};

/** How the label's own shape maps a width in mm to a drawn height and font size. */
export type LabelMetrics = {
  /** Drawn width divided by drawn height. */
  aspect: number;
  /** Font size, in user units, that renders one millimetre of glyph height. */
  fontSizePerHeightMm: number;
};

/** Placements snap to this, so two labels on one wall line up without fiddling. */
export const PLACEMENT_GRID_MM = 10;

/** Rotation snaps to this while shift is held. */
export const ROTATION_SNAP_DEG = 15;

/**
 * Width per character of the fallback label estimate, as a fraction of height.
 *
 * Only used before the browser has measured the real thing (and on the server,
 * where there is nothing to measure). Close enough to keep the first paint from
 * jumping; replaced by a `getBBox` measurement as soon as one is available.
 */
const FALLBACK_CHAR_WIDTH_RATIO = 0.58;

/** Cap height as a fraction of font size, for the same fallback. */
const FALLBACK_CAP_HEIGHT_RATIO = 0.72;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Fold any angle into (-180, 180], which is the range the backend accepts. */
export function normaliseRotationDeg(degrees: number): number {
  const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180;
  // -180 and 180 are the same angle; prefer the positive one so a slider that
  // reads 180 does not flip to -180 the moment it is touched.
  return wrapped === -180 ? 180 : wrapped;
}

/** Round to the placement grid. Exported because the reducer snaps every drag through it. */
export function snapToGrid(value: number, stepMm: number = PLACEMENT_GRID_MM): number {
  if (!Number.isFinite(value) || stepMm <= 0) return value;
  return Math.round(value / stepMm) * stepMm;
}

/**
 * The four corners of a rotated rectangle, counter-clockwise from bottom-left.
 *
 * Corner order matters: the polygon tests below walk consecutive pairs as
 * edges, so a shuffled list would test the diagonals instead of the sides.
 */
export function rotatedRectCorners(centre: PointMm, widthMm: number, heightMm: number, rotationDeg: number): PointMm[] {
  const cos = Math.cos(toRadians(rotationDeg));
  const sin = Math.sin(toRadians(rotationDeg));
  const halfWidth = widthMm / 2;
  const halfHeight = heightMm / 2;
  const localCorners: readonly PointMm[] = [
    { xMm: -halfWidth, yMm: -halfHeight },
    { xMm: halfWidth, yMm: -halfHeight },
    { xMm: halfWidth, yMm: halfHeight },
    { xMm: -halfWidth, yMm: halfHeight },
  ];
  return localCorners.map((corner) => ({
    xMm: centre.xMm + corner.xMm * cos - corner.yMm * sin,
    yMm: centre.yMm + corner.xMm * sin + corner.yMm * cos,
  }));
}

function cross(origin: PointMm, first: PointMm, second: PointMm): number {
  return (first.xMm - origin.xMm) * (second.yMm - origin.yMm) - (first.yMm - origin.yMm) * (second.xMm - origin.xMm);
}

/**
 * Do two closed segments meet?
 *
 * The straddle test, with touching counted as a hit: a label whose edge lands
 * exactly on a seam is `crosses_seam` to the generator too, and rounding a
 * placement to the 10 mm grid makes exact contact common rather than exotic.
 */
export function segmentIntersectsSegment(
  firstStart: PointMm,
  firstEnd: PointMm,
  secondStart: PointMm,
  secondEnd: PointMm,
): boolean {
  const d1 = cross(firstStart, firstEnd, secondStart);
  const d2 = cross(firstStart, firstEnd, secondEnd);
  const d3 = cross(secondStart, secondEnd, firstStart);
  const d4 = cross(secondStart, secondEnd, firstEnd);
  if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) {
    // Collinear: overlap on both axes is contact.
    const overlaps = (a: number, b: number, c: number, d: number) =>
      Math.max(Math.min(a, b), Math.min(c, d)) <= Math.min(Math.max(a, b), Math.max(c, d));
    return (
      overlaps(firstStart.xMm, firstEnd.xMm, secondStart.xMm, secondEnd.xMm) &&
      overlaps(firstStart.yMm, firstEnd.yMm, secondStart.yMm, secondEnd.yMm)
    );
  }
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}

function pointInPolygon(point: PointMm, polygon: readonly PointMm[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const last = polygon[previous];
    const straddles = current.yMm > point.yMm !== last.yMm > point.yMm;
    if (!straddles) continue;
    const crossingX = ((last.xMm - current.xMm) * (point.yMm - current.yMm)) / (last.yMm - current.yMm) + current.xMm;
    if (point.xMm < crossingX) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point: PointMm, start: PointMm, end: PointMm): number {
  const spanX = end.xMm - start.xMm;
  const spanY = end.yMm - start.yMm;
  const lengthSquared = spanX * spanX + spanY * spanY;
  if (lengthSquared === 0) return Math.hypot(point.xMm - start.xMm, point.yMm - start.yMm);
  const along = Math.max(
    0,
    Math.min(1, ((point.xMm - start.xMm) * spanX + (point.yMm - start.yMm) * spanY) / lengthSquared),
  );
  return Math.hypot(point.xMm - (start.xMm + along * spanX), point.yMm - (start.yMm + along * spanY));
}

/**
 * Does a keep-out circle reach the artwork?
 *
 * Two cases, and both matter: the hole sits under the label (centre inside the
 * polygon) or it sits just outside it but closer than its keep-out radius.
 */
export function circleIntersectsPolygon(centre: PointMm, radiusMm: number, polygon: readonly PointMm[]): boolean {
  if (polygon.length === 0) return false;
  if (pointInPolygon(centre, polygon)) return true;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (distanceToSegment(centre, start, end) <= radiusMm) return true;
  }
  return false;
}

/** A seam as the two endpoints of the segment it actually occupies. */
function seamEnds(line: SeamLineMm): [PointMm, PointMm] {
  const [start, end] = line.extent;
  if (line.kind === 'vertical') {
    return [
      { xMm: line.valueMm, yMm: start },
      { xMm: line.valueMm, yMm: end },
    ];
  }
  return [
    { xMm: start, yMm: line.valueMm },
    { xMm: end, yMm: line.valueMm },
  ];
}

/**
 * Does the artwork land on both sides of a seam?
 *
 * Two ways it can, and neither one implies the other. Usually an edge crosses
 * the seam. But a short seam can sit entirely UNDER a big label without any
 * edge meeting it, and that is still a word with a joint running through it, so
 * the span check is there as well. Touching counts either way: an edge that
 * lands exactly on the line is `crosses_seam` to the generator too.
 */
export function polygonCrossesLine(polygon: readonly PointMm[], line: SeamLineMm): boolean {
  if (polygon.length === 0) return false;

  const [seamStart, seamEnd] = seamEnds(line);
  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index];
    const edgeEnd = polygon[(index + 1) % polygon.length];
    if (segmentIntersectsSegment(edgeStart, edgeEnd, seamStart, seamEnd)) return true;
  }

  const across = polygon.map((point) => (line.kind === 'vertical' ? point.xMm : point.yMm));
  const along = polygon.map((point) => (line.kind === 'vertical' ? point.yMm : point.xMm));
  const minAcross = Math.min(...across);
  const maxAcross = Math.max(...across);
  if (minAcross > line.valueMm || maxAcross < line.valueMm) return false;
  const [extentStart, extentEnd] = line.extent;
  const seamLow = Math.min(extentStart, extentEnd);
  const seamHigh = Math.max(extentStart, extentEnd);
  return Math.min(...along) <= seamHigh && Math.max(...along) >= seamLow;
}

/**
 * Keep the whole rotated rectangle inside its panel.
 *
 * Clamps the centre using the rotated bounding box, so turning a label near an
 * edge pushes it back in rather than letting a corner escape. A rectangle too
 * big for the panel is parked in the middle: there is no legal centre, and the
 * collision list is what tells the buyer about it.
 */
export function clampCentreToPanel(rect: ArtRectMm, panel: PanelRectMm, marginMm: number): PointMm {
  const cos = Math.abs(Math.cos(toRadians(rect.rotationDeg)));
  const sin = Math.abs(Math.sin(toRadians(rect.rotationDeg)));
  const halfSpanX = (rect.widthMm * cos + rect.heightMm * sin) / 2;
  const halfSpanY = (rect.widthMm * sin + rect.heightMm * cos) / 2;

  const lowX = panel.xMm + marginMm + halfSpanX;
  const highX = panel.xMm + panel.widthMm - marginMm - halfSpanX;
  const lowY = panel.yMm + marginMm + halfSpanY;
  const highY = panel.yMm + panel.heightMm - marginMm - halfSpanY;

  return {
    xMm: lowX > highX ? panel.xMm + panel.widthMm / 2 : Math.min(Math.max(rect.xMm, lowX), highX),
    yMm: lowY > highY ? panel.yMm + panel.heightMm / 2 : Math.min(Math.max(rect.yMm, lowY), highY),
  };
}

/**
 * Drag a corner: new width and new centre, aspect locked.
 *
 * Works in the rectangle's own frame so a rotated label resizes along its own
 * edges rather than along the wall's. The corner opposite the one being dragged
 * stays put, which is what makes a resize feel like a resize instead of a
 * simultaneous move.
 */
export function resizeKeepingAspect(
  handle: ResizeHandle,
  pointerMm: PointMm,
  startRect: ArtRectMm,
  aspect: number,
  minWidthMm: number,
  maxWidthMm: number,
): { xMm: number; yMm: number; widthMm: number } {
  const cos = Math.cos(toRadians(startRect.rotationDeg));
  const sin = Math.sin(toRadians(startRect.rotationDeg));
  const offsetX = pointerMm.xMm - startRect.xMm;
  const offsetY = pointerMm.yMm - startRect.yMm;
  const localX = offsetX * cos + offsetY * sin;

  const signX = handle === 'bottomRight' || handle === 'topRight' ? 1 : -1;
  const signY = handle === 'topLeft' || handle === 'topRight' ? 1 : -1;
  const anchorX = -signX * (startRect.widthMm / 2);
  const anchorY = -signY * (startRect.heightMm / 2);

  const snapped = snapToGrid(Math.abs(localX - anchorX));
  const widthMm = Math.min(Math.max(snapped, minWidthMm), maxWidthMm);
  const heightMm = aspect > 0 ? widthMm / aspect : startRect.heightMm;

  const localCentreX = anchorX + signX * (widthMm / 2);
  const localCentreY = anchorY + signY * (heightMm / 2);

  return {
    xMm: startRect.xMm + localCentreX * cos - localCentreY * sin,
    yMm: startRect.yMm + localCentreX * sin + localCentreY * cos,
    widthMm,
  };
}

/**
 * Where the rotate handle has been dragged to, in degrees.
 *
 * The handle sits directly above the label, so a pointer straight up from the
 * centre is rotation zero — hence the quarter turn taken off the raw angle.
 */
export function rotateFromPointer(centre: PointMm, pointerMm: PointMm, snap: boolean): number {
  const raw = (Math.atan2(pointerMm.yMm - centre.yMm, pointerMm.xMm - centre.xMm) * 180) / Math.PI - 90;
  const snapped = snap ? Math.round(raw / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG : Math.round(raw);
  return normaliseRotationDeg(snapped);
}

/**
 * Everything in the way of one placement.
 *
 * `keepoutScale` is the generator's cut-through multiplier: a shape cut right
 * through the sheet needs more room around a hole than one scored into it.
 */
export function findCollisions(
  rect: ArtRectMm,
  panel: PanelRectMm | null,
  holes: readonly HoleMm[],
  seams: readonly SeamLineMm[],
  keepout: { panelEdgeMarginMm: number; keepoutScale: number },
): PlacementCollisions {
  const corners = rotatedRectCorners({ xMm: rect.xMm, yMm: rect.yMm }, rect.widthMm, rect.heightMm, rect.rotationDeg);

  const margin = keepout.panelEdgeMarginMm;
  const offPanel =
    panel === null ||
    corners.some(
      (corner) =>
        corner.xMm < panel.xMm + margin ||
        corner.xMm > panel.xMm + panel.widthMm - margin ||
        corner.yMm < panel.yMm + margin ||
        corner.yMm > panel.yMm + panel.heightMm - margin,
    );

  const hitHoles: string[] = [];
  for (const hole of holes) {
    if (circleIntersectsPolygon({ xMm: hole.xMm, yMm: hole.yMm }, hole.keepoutRadiusMm * keepout.keepoutScale, corners))
      hitHoles.push(hole.id);
  }

  const hitSeams: number[] = [];
  seams.forEach((seam, index) => {
    if (polygonCrossesLine(corners, seam)) hitSeams.push(index);
  });

  return { holes: hitHoles, seams: hitSeams, offPanel };
}

/**
 * A guess at how wide a label will draw, for the render before the browser has
 * measured the real one. Never used once a measurement lands.
 */
export function estimateLabelMetrics(text: string): LabelMetrics {
  const characters = Math.max(text.trim().length, 1);
  return {
    aspect: Math.max(characters * FALLBACK_CHAR_WIDTH_RATIO, 0.2),
    fontSizePerHeightMm: 1 / FALLBACK_CAP_HEIGHT_RATIO,
  };
}

/**
 * Turn a browser pointer position into wall millimetres.
 *
 * Split out of the SVG component and given the element's box as data so it can
 * be tested without a layout engine — and so a zero-sized box (jsdom, a hidden
 * tab, the moment before first layout) returns the middle of the wall instead
 * of a NaN that would travel all the way into a placement.
 */
export function clientToWallMm(
  bounds: { left: number; top: number; width: number; height: number },
  viewBox: { minXMm: number; minYMm: number; widthMm: number; heightMm: number },
  clientX: number,
  clientY: number,
): PointMm {
  if (bounds.width <= 0 || bounds.height <= 0) {
    return {
      xMm: viewBox.minXMm + viewBox.widthMm / 2,
      yMm: -(viewBox.minYMm + viewBox.heightMm / 2),
    };
  }
  const svgX = viewBox.minXMm + ((clientX - bounds.left) / bounds.width) * viewBox.widthMm;
  const svgY = viewBox.minYMm + ((clientY - bounds.top) / bounds.height) * viewBox.heightMm;
  // The SVG draws the wall upside down (y grows downward there), so the flip
  // that happens on the way in happens in reverse on the way out.
  return { xMm: svgX, yMm: -svgY };
}
